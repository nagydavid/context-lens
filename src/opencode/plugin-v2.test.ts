import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { ContextLensV2Plugin, createV2Client } from "./plugin-v2.js";
import type { ContextLensV2Context } from "./plugin-v2.js";

function makeCtx(overrides: Partial<ContextLensV2Context["session"]> = {}) {
  const calls: Array<[string, unknown]> = [];
  const hooks: Record<string, (event: any) => Promise<void>> = {};
  const ctx: ContextLensV2Context = {
    location: { directory: "/tmp/does-not-matter" },
    tool: { hook: (name: string, fn: any) => { hooks[`tool.${name}`] = fn; } },
    session: {
      hook: (name: string, fn: any) => { hooks[`session.${name}`] = fn; },
      create: async (p: unknown) => { calls.push(["create", p]); return { data: { id: "ses_child" } }; },
      generate: async (p: unknown) => { calls.push(["generate", p]); return { data: { text: "{\"ok\":true}" } }; },
      remove: async (p: unknown) => { calls.push(["remove", p]); },
      interrupt: async (p: unknown) => { calls.push(["interrupt", p]); },
      switchModel: async (p: unknown) => { calls.push(["switchModel", p]); },
      ...overrides,
    },
  };
  return { ctx, calls, hooks };
}

describe("ContextLensV2Plugin (OpenCode v2.0.30 host contract)", () => {
  it("is a default-exportable definition with id and setup", () => {
    strictEqual(ContextLensV2Plugin.id, "context-lens");
    strictEqual(typeof ContextLensV2Plugin.setup, "function");
  });

  it("registers tool execute.after and session prompt hooks", () => {
    const { ctx, hooks } = makeCtx();
    ContextLensV2Plugin.setup(ctx);
    ok(hooks["tool.execute.after"]);
    ok(hooks["session.prompt"]);
  });

  it("leaves non-read and failed tool results untouched", async () => {
    const { ctx, hooks } = makeCtx();
    ContextLensV2Plugin.setup(ctx);
    const result = { output: "x", content: [{ type: "text", text: "x" }] };
    await hooks["tool.execute.after"]({ tool: "bash", status: "completed", sessionID: "s", id: "c", input: {}, result });
    await hooks["tool.execute.after"]({ tool: "read", status: "error", sessionID: "s", id: "c", input: { path: "/x" } });
    strictEqual(result.output, "x");
  });

  it("swallows malformed prompt events", async () => {
    const { ctx, hooks } = makeCtx();
    ContextLensV2Plugin.setup(ctx);
    await hooks["session.prompt"]({ sessionID: "s", prompt: null });
  });
});

describe("createV2Client", () => {
  it("maps runner calls onto flat v2 session API and wraps generated text", async () => {
    const { ctx, calls } = makeCtx();
    const client = createV2Client(ctx);
    const created = await client.session.create({ body: { title: "t" } });
    deepStrictEqual(created, { data: { id: "ses_child" } });
    const response = await client.session.prompt({
      path: { id: "ses_child" },
      body: { parts: [{ type: "text", text: "hi" }], model: { providerID: "p", modelID: "m" } },
    });
    deepStrictEqual(response, { data: { info: {}, parts: [{ type: "text", text: "{\"ok\":true}" }] } });
    await client.session.delete({ path: { id: "ses_child" } });
    deepStrictEqual(calls.map(([n]) => n), ["create", "switchModel", "generate", "remove"]);
    deepStrictEqual(calls[1][1], { sessionID: "ses_child", model: { id: "m", providerID: "p" } });
    deepStrictEqual(calls[2][1], { sessionID: "ses_child", prompt: "hi" });
  });

  it("throws when generate returns no text", async () => {
    const { ctx } = makeCtx({ generate: async () => ({ data: {} }) });
    const client = createV2Client(ctx);
    await client.session.prompt({ path: { id: "s" }, body: { parts: [{ type: "text", text: "x" }] } }).then(
      () => { throw new Error("expected rejection"); },
      (error: Error) => ok(/no text/.test(error.message))
    );
  });
});
