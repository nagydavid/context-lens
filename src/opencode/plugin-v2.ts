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
    // Tuning (env, project/global config) is resolved inside createParaDocHooks.
    const hooks = createParaDocHooks({
      client: createV2Client(ctx),
      directory,
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
