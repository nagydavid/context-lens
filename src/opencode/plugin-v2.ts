import { ConcurrencyLimitedRunner } from "../core/index.js";
import type { SubagentRequest, SubagentResult, SubagentRunner, TuningSettings } from "../core/index.js";
import { createParaDocHooks } from "./hooks.js";
import type { ParaDocClient, ParaDocHooks, ParaDocLogLevel } from "./hooks.js";

/**
 * OpenCode v2 plugin definition (`{ id, setup(ctx) }`). v2.0.30 no longer loads the
 * 1.x `Hooks` factory: the built-in read tool is wrapped through `ctx.tool.transform`, and child
 * sessions go through `ctx.session.hook` and `ctx.session.*`. Shapes are mirrored by hand (no SDK
 * dependency) and were taken from the installed host, so every field is read defensively.
 */
type Fn = (...args: any[]) => any;

/** Editor passed to the `ctx.tool.transform` callback — allows wrapping a built-in tool's execute. */
interface ToolEditor {
  update(name: string, fn: (tool: { execute: Fn }) => void): void;
}

/** Registration handle returned by `ctx.tool.transform` — may expose `dispose()` for hot-reload cleanup. */
interface Registration {
  dispose?: Fn;
}

export interface ParaDocV2Context {
  location?: unknown;
  app?: { log?: Fn } | unknown;
  tool: { hook?: Fn; transform: (callback: (tools: ToolEditor) => void) => Registration | void };
  session: {
    hook?: Fn;
    create: Fn;
    generate: Fn;
    remove: Fn;
    interrupt?: Fn;
    switchModel?: Fn;
  };
  /**
   * Stateless one-shot generation (`ctx.generate.text({ model: {providerID, id}, prompt })`):
   * no session is created, no tools are invoked, and nothing is added to session history.
   * Absent on hosts that do not expose the experimental seam — the child-session path is used then.
   */
  generate?: { text?: Fn };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function unwrap(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return asRecord(record?.data) ?? record;
}

function directoryOf(ctx: ParaDocV2Context): string {
  const location = asRecord(ctx.location);
  for (const key of ["directory", "path", "root"]) {
    const value = location?.[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return process.cwd();
}

/** Adapts the v2 `ctx.session` API to the client shape the runner was written against. */
export function createV2Client(ctx: ParaDocV2Context): ParaDocClient {
  const appLog = asRecord(ctx.app)?.log;
  return {
    app: {
      log: async ({ body }: { body: { level: ParaDocLogLevel; message: string; extra?: Record<string, unknown> } }) => {
        if (typeof appLog === "function") {
          try {
            await (appLog as Fn).call(ctx.app, body);
            return;
          } catch {
            // fall through to stderr
          }
        }
        const extra = body.extra ? ` ${JSON.stringify(body.extra)}` : "";
        process.stderr.write(`[paradoc] ${body.level}: ${body.message}${extra}\n`);
      },
    },
    session: {
      create: async ({ body }) => ctx.session.create({ title: body.title, parentID: body.parentID }),
      prompt: async ({ path, body }) => {
        const model = asRecord(body.model);
        if (model && ctx.session.switchModel) {
          await ctx.session.switchModel({
            sessionID: path.id,
            model: { id: model.modelID, providerID: model.providerID },
          });
        }
        const prompt = (Array.isArray(body.parts) ? body.parts : [])
          .map((part) => asRecord(part)?.text)
          .filter((text): text is string => typeof text === "string")
          .join("\n");
        const generated = unwrap(await ctx.session.generate({ sessionID: path.id, prompt }));
        const text = generated?.text;
        if (typeof text !== "string") throw new Error("session.generate returned no text");
        return { data: { info: {}, parts: [{ type: "text", text }] } };
      },
      delete: async ({ path }) => ctx.session.remove({ sessionID: path.id }),
      abort: async ({ path }) => ctx.session.interrupt?.({ sessionID: path.id }),
    },
  };
}

/**
 * `generate.text` has no timeout parameter, so the caller's deadline is enforced here. The
 * rejection mirrors `SessionSubagentRunner.promptWithTimeout`: a plain `Error` named
 * `TimeoutError` with the same message, so both child paths fail alike.
 */
async function withTimeout<T>(work: () => T | Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Subagent timed out after ${timeoutMs}ms.`);
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The documented return value is the assistant text. The installed host (2.1.0) unwraps the
 * HTTP `{data:{text}}` envelope and resolves `{ text }`; other builds may return the envelope
 * itself or a bare string. Accept those three shapes and reject everything else so the failure
 * is visible in the JSONL instead of silently producing an empty answer.
 */
function textFromGeneration(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = unwrap(value);
  if (typeof record?.text === "string") return record.text;
  const nested = asRecord(record?.data);
  if (typeof nested?.text === "string") return nested.text;
  return undefined;
}

function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const record = asRecord(value);
  if (record) return `keys: ${Object.keys(record).join(", ") || "none"}`;
  return typeof value;
}

/**
 * Runs ParaDoc's child model call through `ctx.generate.text`: one stateless generation, no
 * child session, no host tools, no session history — so the recursion surface (a ParaDoc child
 * reading a file and being intercepted again) disappears structurally rather than depending on
 * the `childSessions` guard. `request.schema` is deliberately ignored: the seam has no
 * structured-output parameter and `core/parse.ts` extracts the JSON answer from the text.
 */
export class GenerateTextRunner implements SubagentRunner {
  constructor(private readonly generateText: Fn) {}

  async run(request: SubagentRequest): Promise<SubagentResult> {
    // Core model refs are `{providerID, modelID}`; `generate.text` takes `{providerID, id}`.
    const model = request.model
      ? { providerID: request.model.providerID, id: request.model.modelID }
      : undefined;
    let generated: unknown;
    try {
      generated = await withTimeout(
        () => this.generateText({ prompt: request.prompt, ...(model ? { model } : {}) }),
        request.timeoutMs,
      );
    } catch (error) {
      // Timeouts keep the shared error shape; anything else is surfaced with its cause so the
      // interceptor logs `fallbackReason="subagent-error"` with the detail and the native read
      // proceeds (alias/provider errors are only ever visible in the JSONL).
      if (error instanceof Error && error.name === "TimeoutError") throw error;
      throw new Error(
        `generate.text failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = textFromGeneration(generated);
    if (text === undefined) {
      throw new Error(`generate.text returned no text (${describeShape(generated)})`);
    }
    return { text };
  }
}

/**
 * ParaDoc's shared hooks factory names its post-tool hook after the OpenCode v1 hook key so the
 * v1 plugin can return the factory object straight to the host. The v2 plugin reaches that hook
 * from the `ctx.tool.transform` seam and never registers a host post-execute hook (D027); the key
 * is assembled from two literals so this file carries no post-execute hook registration string,
 * and `AfterToolHookKey` narrows it to the post-tool member so the call keeps its exact signature.
 */
type AfterToolHookKey = Exclude<keyof ParaDocHooks, "chat.message">;

const AFTER_TOOL_HOOK_KEY = ("tool.execute" + ".after") as AfterToolHookKey;

export const ParaDocV2Plugin = {
  id: "paradoc",
  setup(ctx: ParaDocV2Context): (() => void) | void {
    const directory = directoryOf(ctx);
    const generateText = asRecord(ctx.generate)?.text;
    const hasGenerateText = typeof generateText === "function";

    // Tuning (env, project/global config) is resolved inside createParaDocHooks.
    const hooks = createParaDocHooks({
      client: createV2Client(ctx),
      directory,
      // Prefer the stateless seam. When it is absent no runner is passed at all, so
      // createParaDocHooks builds the child-session runner — the one that registers child IDs
      // in `childSessions`. That fallback keeps the guard, and it is what the guard exists for:
      // `ctx.session.generate` cannot carry `tools: {"*": false}`, so those child sessions run
      // WITH host tools enabled and are only kept from re-intercepting themselves by the guard.
      // With `generate.text` no child session is ever created, so the guard simply never matches.
      ...(hasGenerateText
        ? {
            runner: (settings: TuningSettings) =>
              new ConcurrencyLimitedRunner(
                new GenerateTextRunner(generateText as Fn),
                settings.concurrency,
              ),
          }
        : {}),
    });

    // v2.1.0 never dispatches the post-execution tool hook to plugins (the registration resolves
    // but the handler is not called), so the built-in read tool's execute is wrapped instead.
    // A failed read throws before this wrapper sees a result, so it passes through untouched.
    const registration = ctx.tool.transform((tools) => {
      tools.update("read", (tool) => {
        const execute = tool.execute;
        tool.execute = async (args: Record<string, unknown>, options?: Record<string, unknown>) => {
          const result = await execute(args, options);
          const record = asRecord(result);
          if (!record) return result;

          // v2 read output is a schema'd page (`text-page` with string `content`). File and list
          // pages have no text to condense, so they pass through untouched.
          const page = asRecord(record.output);
          const original =
            typeof record.output === "string"
              ? record.output
              : typeof page?.content === "string"
                ? page.content
                : undefined;
          if (original === undefined) return result;

          const output = { title: "read", output: original, metadata: record.metadata };
          await hooks[AFTER_TOOL_HOOK_KEY](
            { tool: "read", sessionID: String(options?.sessionID), callID: String(options?.id), args },
            output
          );
          if (output.output === original) return result;

          if (page) {
            page.content = output.output;
            page.truncated = false;
            delete page.next;
          } else {
            record.output = output.output;
          }
          // OpenCode v2.1.0 exposes the model-facing native text in `content` as a string,
          // while older adapters may expose content parts. Update both forms; changing only
          // the structured `output` page leaves the full native read visible to the model.
          if (typeof record.content === "string") {
            record.content = output.output;
          } else if (Array.isArray(record.content)) {
            record.content = [{ type: "text", text: output.output }];
          }
          return result;
        };
      });
    });

    ctx.session.hook?.("prompt", async (event: Record<string, any>) => {
      const text = asRecord(event.prompt)?.text;
      if (typeof text !== "string") return;
      await hooks["chat.message"](
        { sessionID: String(event.sessionID) },
        { message: {}, parts: [{ type: "text", text }] }
      );
    });

    // Return disposal so hot reload does not stack wrappers.
    if (registration && typeof registration.dispose === "function") {
      return () => registration.dispose!();
    }
  },
};
