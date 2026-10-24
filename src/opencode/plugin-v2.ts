import { createParaDocHooks } from "./hooks.js";
import type { ParaDocClient, ParaDocLogLevel } from "./hooks.js";

/**
 * OpenCode v2 plugin definition (`{ id, setup(ctx) }`). v2.0.30 no longer loads the
 * 1.x `Hooks` factory: tool/session hooks and child sessions go through `ctx.tool.hook`,
 * `ctx.session.hook` and `ctx.session.*`. Shapes are mirrored by hand (no SDK dependency)
 * and were taken from the installed host, so every field is read defensively.
 */
type Fn = (...args: any[]) => any;

export interface ParaDocV2Context {
  location?: unknown;
  app?: { log?: Fn } | unknown;
  tool: { hook: Fn };
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

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : asRecord(part)?.text))
    .filter((part): part is string => typeof part === "string")
    .join("\n");
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

export const ParaDocV2Plugin = {
  id: "paradoc",
  setup(ctx: ParaDocV2Context): void {
    const directory = directoryOf(ctx);
    // Tuning (env, project/global config) is resolved inside createParaDocHooks.
    const hooks = createParaDocHooks({
      client: createV2Client(ctx),
      directory,
    });

    ctx.tool.hook("execute.after", async (event: Record<string, any>) => {
      if (event.status !== "completed") return;
      const result = asRecord(event.result);
      if (!result) return;
      const original = typeof result.output === "string" ? result.output : textOfContent(result.content);
      const output = { title: String(event.tool ?? ""), output: original, metadata: result.metadata };
      await hooks["tool.execute.after"](
        { tool: String(event.tool), sessionID: String(event.sessionID), callID: String(event.id), args: event.input },
        output
      );
      if (output.output !== original) {
        result.output = output.output;
        result.content = [{ type: "text", text: output.output }];
      }
    });

    ctx.session.hook?.("prompt", async (event: Record<string, any>) => {
      const text = asRecord(event.prompt)?.text;
      if (typeof text !== "string") return;
      await hooks["chat.message"](
        { sessionID: String(event.sessionID) },
        { message: {}, parts: [{ type: "text", text }] }
      );
    });
  },
};
