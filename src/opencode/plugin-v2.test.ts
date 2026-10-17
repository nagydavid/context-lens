import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ParaDocV2Plugin, createV2Client, readFanoutEnv } from "./plugin-v2.js";
import type { ParaDocV2Context } from "./plugin-v2.js";

function makeCtx(overrides: Partial<ParaDocV2Context["session"]> = {}) {
  const calls: Array<[string, unknown]> = [];
  const hooks: Record<string, (event: any) => Promise<void>> = {};
  const ctx: ParaDocV2Context = {
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

describe("ParaDocV2Plugin (OpenCode v2.0.30 host contract)", () => {
  it("is a default-exportable definition with id and setup", () => {
    strictEqual(ParaDocV2Plugin.id, "paradoc");
    strictEqual(typeof ParaDocV2Plugin.setup, "function");
  });

  it("registers tool execute.after and session prompt hooks", () => {
    const { ctx, hooks } = makeCtx();
    ParaDocV2Plugin.setup(ctx);
    ok(hooks["tool.execute.after"]);
    ok(hooks["session.prompt"]);
  });

  it("leaves non-read and failed tool results untouched", async () => {
    const { ctx, hooks } = makeCtx();
    ParaDocV2Plugin.setup(ctx);
    const result = { output: "x", content: [{ type: "text", text: "x" }] };
    await hooks["tool.execute.after"]({ tool: "bash", status: "completed", sessionID: "s", id: "c", input: {}, result });
    await hooks["tool.execute.after"]({ tool: "read", status: "error", sessionID: "s", id: "c", input: { path: "/x" } });
    strictEqual(result.output, "x");
  });

  it("swallows malformed prompt events", async () => {
    const { ctx, hooks } = makeCtx();
    ParaDocV2Plugin.setup(ctx);
    await hooks["session.prompt"]({ sessionID: "s", prompt: null });
  });
});

describe("ParaDocV2Plugin tuning", () => {
  it("honours PARADOC_CHUNK_LINES from process env via loadTuning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paradoc-v2-"));
    const saved = { ...process.env };
    try {
      mkdirSync(join(dir, ".paradoc"));
      writeFileSync(
        join(dir, ".paradoc", "config.json"),
        JSON.stringify({ version: 1, model: { providerID: "p", modelID: "m" } })
      );
      const file = join(dir, "big.ts");
      writeFileSync(file, Array.from({ length: 3000 }, (_, i) => `const v_${i + 1} = ${i + 1};`).join("\n"));
      process.env.HOME = dir;
      process.env.XDG_CONFIG_HOME = join(dir, "xdg");
      process.env.PARADOC_CHUNK_LINES = "1000";
      process.env.PARADOC_CONCURRENCY = "3";
      delete process.env.PARADOC_CACHE;
      delete process.env.PARADOC_THRESHOLD;
      delete process.env.PARADOC_JUDGE;
      let generates = 0;
      const { ctx, hooks } = makeCtx({
        generate: async () => {
          generates += 1;
          return { data: { text: JSON.stringify({ excerpts: [{ startLine: 10, endLine: 12 }], summary: "s", confidence: 4 }) } };
        },
      });
      (ctx as { location?: unknown }).location = { directory: dir };
      ParaDocV2Plugin.setup(ctx);
      const result: { output: string; content?: unknown } = { output: "x\n".repeat(3000) };
      await hooks["tool.execute.after"]({ tool: "read", status: "completed", sessionID: "s", id: "c", input: { path: file }, result });
      strictEqual(generates, 4);
      ok(result.output.includes("lines 10-12"));
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      for (const key of ["PARADOC_CHUNK_LINES", "PARADOC_CONCURRENCY", "PARADOC_CACHE", "PARADOC_THRESHOLD", "PARADOC_JUDGE"]) {
        if (saved[key] === undefined) delete process.env[key];
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readFanoutEnv", () => {
  it("reads positive chunk and concurrency values", () => {
    deepStrictEqual(readFanoutEnv({ PARADOC_CHUNK_LINES: "1000", PARADOC_CONCURRENCY: "3" }), {
      chunkLines: 1000,
      concurrency: 3,
    });
  });

  it("omits absent, garbage, zero, and negative values", () => {
    deepStrictEqual(readFanoutEnv({}), {});
    deepStrictEqual(readFanoutEnv({ PARADOC_CHUNK_LINES: "", PARADOC_CONCURRENCY: "" }), {});
    deepStrictEqual(readFanoutEnv({ PARADOC_CHUNK_LINES: "nope", PARADOC_CONCURRENCY: "0" }), {});
    deepStrictEqual(readFanoutEnv({ PARADOC_CHUNK_LINES: "-1", PARADOC_CONCURRENCY: "-3" }), {});
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
