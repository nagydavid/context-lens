import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ParaDocV2Plugin, createV2Client } from "./plugin-v2.js";
import type { ParaDocV2Context } from "./plugin-v2.js";

type Fn = (...args: any[]) => any;

// ---------------------------------------------------------------------------
// Harness: fake ctx whose tool.transform captures the callback so we can
// invoke it with a fake editor and obtain the wrapped read execute.
// ---------------------------------------------------------------------------

interface Harness {
  ctx: ParaDocV2Context;
  calls: Array<[string, unknown]>;
  sessionHooks: Record<string, (event: any) => Promise<void>>;
  /** Invoke the captured transform callback with a fake editor whose "read"
   *  tool has the given nativeExecute. Returns the (possibly wrapped) execute. */
  wrapReadTool(nativeExecute: Fn): Fn;
  /** true if ctx.tool.hook was ever called (should never happen). */
  toolHookCalled: boolean;
  /** The dispose function returned by setup(), or undefined. */
  dispose: (() => void) | void;
}

function makeHarness(
  sessionOverrides: Partial<ParaDocV2Context["session"]> = {},
  nativeExecute: Fn = async () => ({}),
) {
  const calls: Array<[string, unknown]> = [];
  const sessionHooks: Record<string, (event: any) => Promise<void>> = {};
  let transformCb: ((tools: { update(name: string, fn: (tool: { execute: Fn }) => void): void }) => void) | undefined;
  let toolHookCalled = false;

  const ctx: ParaDocV2Context = {
    location: { directory: "/tmp/does-not-matter" },
    tool: {
      transform: (cb) => {
        transformCb = cb;
        return { dispose: () => {} };
      },
      hook: () => {
        toolHookCalled = true;
      },
    },
    session: {
      hook: (name: string, fn: any) => {
        sessionHooks[`session.${name}`] = fn;
      },
      create: async (p: unknown) => {
        calls.push(["create", p]);
        return { data: { id: "ses_child" } };
      },
      generate: async (p: unknown) => {
        calls.push(["generate", p]);
        return { data: { text: '{"ok":true}' } };
      },
      remove: async (p: unknown) => {
        calls.push(["remove", p]);
      },
      interrupt: async (p: unknown) => {
        calls.push(["interrupt", p]);
      },
      switchModel: async (p: unknown) => {
        calls.push(["switchModel", p]);
      },
      ...sessionOverrides,
    },
  };

  const dispose = ParaDocV2Plugin.setup(ctx);

  function wrapReadTool(execute: Fn): Fn {
    const tool = { execute };
    transformCb!({
      update: (name, fn) => {
        if (name === "read") fn(tool);
      },
    });
    return tool.execute;
  }

  return { ctx, calls, sessionHooks, wrapReadTool, toolHookCalled, dispose };
}

// ---------------------------------------------------------------------------
// Registration contract
// ---------------------------------------------------------------------------

describe("ParaDocV2Plugin registration (ctx.tool.transform contract)", () => {
  it("is a default-exportable definition with id and setup", () => {
    strictEqual(ParaDocV2Plugin.id, "paradoc");
    strictEqual(typeof ParaDocV2Plugin.setup, "function");
  });

  it("registers via ctx.tool.transform and never calls ctx.tool.hook", () => {
    const h = makeHarness();
    strictEqual(h.toolHookCalled, false, "ctx.tool.hook must not be called");
    // The transform callback was captured (wrapReadTool works)
    const exec = h.wrapReadTool(async () => ({ output: "x" }));
    strictEqual(typeof exec, "function");
  });

  it("registers session prompt hook", async () => {
    const h = makeHarness();
    ok(h.sessionHooks["session.prompt"]);
  });

  it("returns dispose when registration has dispose()", () => {
    const h = makeHarness();
    strictEqual(typeof h.dispose, "function");
    // Calling dispose should not throw
    (h.dispose as () => void)();
  });

  it("returns void when registration has no dispose", () => {
    const calls: Array<[string, unknown]> = [];
    const sessionHooks: Record<string, (event: any) => Promise<void>> = {};
    let transformCb: any;
    const ctx: ParaDocV2Context = {
      location: { directory: "/tmp/does-not-matter" },
      tool: {
        transform: (cb) => {
          transformCb = cb;
          return undefined; // no registration handle
        },
      },
      session: {
        hook: (name: string, fn: any) => {
          sessionHooks[`session.${name}`] = fn;
        },
        create: async () => ({ data: { id: "s" } }),
        generate: async () => ({ data: { text: "" } }),
        remove: async () => {},
      },
    };
    const dispose = ParaDocV2Plugin.setup(ctx);
    strictEqual(dispose, undefined);
  });
});

// ---------------------------------------------------------------------------
// Wrapper behavior: string output
// ---------------------------------------------------------------------------

describe("ParaDocV2Plugin wrapper — string output", () => {
  it("condenses a large string output and rewrites record.content (string form)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paradoc-v2-str-"));
    const saved = { ...process.env };
    try {
      mkdirSync(join(dir, ".paradoc"));
      writeFileSync(
        join(dir, ".paradoc", "config.json"),
        JSON.stringify({ version: 1, model: { providerID: "p", modelID: "m" } }),
      );
      const file = join(dir, "big.ts");
      const content = Array.from({ length: 3000 }, (_, i) => `const v_${i + 1} = ${i + 1};`).join("\n");
      writeFileSync(file, content);

      process.env.HOME = dir;
      process.env.XDG_CONFIG_HOME = join(dir, "xdg");
      process.env.PARADOC_CHUNK_LINES = "1000";
      process.env.PARADOC_CONCURRENCY = "3";
      delete process.env.PARADOC_CACHE;
      delete process.env.PARADOC_THRESHOLD;
      delete process.env.PARADOC_JUDGE;

      const h = makeHarness({
        generate: async () => ({
          data: {
            text: JSON.stringify({
              excerpts: [{ startLine: 10, endLine: 12 }],
              summary: "s",
              confidence: 4,
            }),
          },
        }),
      });
      (h.ctx as { location?: unknown }).location = { directory: dir };

      const nativeResult = { output: content, content };
      const exec = h.wrapReadTool(async () => nativeResult);
      const result = await exec({ path: file }, { sessionID: "s", id: "c" });

      // The wrapper mutated the same object the native execute returned
      strictEqual(result, nativeResult);
      ok(result.output.includes("lines 10-12"), "output should contain condensed excerpt");
      ok(result.output !== content, "output should differ from original");
      // record.content (string form) should also be rewritten
      strictEqual(typeof result.content, "string");
      ok(result.content.includes("lines 10-12"), "content string should be condensed");
    } finally {
      restoreEnv(saved);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Wrapper behavior: page-object output
// ---------------------------------------------------------------------------

describe("ParaDocV2Plugin wrapper — page-object output", () => {
  it("rewrites page.content, sets truncated=false, deletes page.next", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paradoc-v2-page-"));
    const saved = { ...process.env };
    try {
      mkdirSync(join(dir, ".paradoc"));
      writeFileSync(
        join(dir, ".paradoc", "config.json"),
        JSON.stringify({ version: 1, model: { providerID: "p", modelID: "m" } }),
      );
      const file = join(dir, "big.ts");
      const content = Array.from({ length: 3000 }, (_, i) => `const v_${i + 1} = ${i + 1};`).join("\n");
      writeFileSync(file, content);

      process.env.HOME = dir;
      process.env.XDG_CONFIG_HOME = join(dir, "xdg");
      process.env.PARADOC_CHUNK_LINES = "1000";
      process.env.PARADOC_CONCURRENCY = "3";
      delete process.env.PARADOC_CACHE;
      delete process.env.PARADOC_THRESHOLD;
      delete process.env.PARADOC_JUDGE;

      const h = makeHarness({
        generate: async () => ({
          data: {
            text: JSON.stringify({
              excerpts: [{ startLine: 10, endLine: 12 }],
              summary: "s",
              confidence: 4,
            }),
          },
        }),
      });
      (h.ctx as { location?: unknown }).location = { directory: dir };

      const page = { type: "text-page", content, truncated: true, next: "more-content" };
      const nativeResult = { output: page, content };
      const exec = h.wrapReadTool(async () => nativeResult);
      const result = await exec({ path: file }, { sessionID: "s", id: "c" });

      strictEqual(result, nativeResult);
      // page.content should be condensed
      ok(page.content.includes("lines 10-12"), "page.content should contain condensed excerpt");
      ok(page.content !== content, "page.content should differ from original");
      // truncated should be false
      strictEqual(page.truncated, false);
      // next should be deleted
      strictEqual("next" in page, false, "page.next should be deleted");
      // record.content (string form) should also be rewritten
      ok(typeof result.content === "string" && result.content.includes("lines 10-12"));
    } finally {
      restoreEnv(saved);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rewrites record.content array form to [{type:text, text}]", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paradoc-v2-arr-"));
    const saved = { ...process.env };
    try {
      mkdirSync(join(dir, ".paradoc"));
      writeFileSync(
        join(dir, ".paradoc", "config.json"),
        JSON.stringify({ version: 1, model: { providerID: "p", modelID: "m" } }),
      );
      const file = join(dir, "big.ts");
      const content = Array.from({ length: 3000 }, (_, i) => `const v_${i + 1} = ${i + 1};`).join("\n");
      writeFileSync(file, content);

      process.env.HOME = dir;
      process.env.XDG_CONFIG_HOME = join(dir, "xdg");
      process.env.PARADOC_CHUNK_LINES = "1000";
      process.env.PARADOC_CONCURRENCY = "3";
      delete process.env.PARADOC_CACHE;
      delete process.env.PARADOC_THRESHOLD;
      delete process.env.PARADOC_JUDGE;

      const h = makeHarness({
        generate: async () => ({
          data: {
            text: JSON.stringify({
              excerpts: [{ startLine: 10, endLine: 12 }],
              summary: "s",
              confidence: 4,
            }),
          },
        }),
      });
      (h.ctx as { location?: unknown }).location = { directory: dir };

      const nativeResult = {
        output: content,
        content: [{ type: "text", text: content }],
      };
      const exec = h.wrapReadTool(async () => nativeResult);
      const result = await exec({ path: file }, { sessionID: "s", id: "c" });

      strictEqual(result, nativeResult);
      ok(Array.isArray(result.content), "content should be an array");
      strictEqual(result.content.length, 1);
      strictEqual(result.content[0].type, "text");
      ok(result.content[0].text.includes("lines 10-12"), "content[0].text should be condensed");
    } finally {
      restoreEnv(saved);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Pass-through cases
// ---------------------------------------------------------------------------

describe("ParaDocV2Plugin wrapper — pass-through", () => {
  it("non-text page (no string content) passes through byte-identical", async () => {
    const h = makeHarness();
    const nativeResult = { output: { type: "file-page", path: "/some/file" }, content: undefined };
    const exec = h.wrapReadTool(async () => nativeResult);
    const result = await exec({ path: "/some/file" }, { sessionID: "s", id: "c" });

    strictEqual(result, nativeResult, "result should be the same object reference");
    deepStrictEqual(result.output, { type: "file-page", path: "/some/file" });
  });

  it("offset read passes through (hook bypasses on offset)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paradoc-v2-off-"));
    const saved = { ...process.env };
    try {
      mkdirSync(join(dir, ".paradoc"));
      writeFileSync(
        join(dir, ".paradoc", "config.json"),
        JSON.stringify({ version: 1, model: { providerID: "p", modelID: "m" } }),
      );
      const file = join(dir, "big.ts");
      const content = Array.from({ length: 3000 }, (_, i) => `const v_${i + 1} = ${i + 1};`).join("\n");
      writeFileSync(file, content);

      process.env.HOME = dir;
      process.env.XDG_CONFIG_HOME = join(dir, "xdg");
      process.env.PARADOC_CHUNK_LINES = "1000";
      process.env.PARADOC_CONCURRENCY = "3";
      delete process.env.PARADOC_CACHE;
      delete process.env.PARADOC_THRESHOLD;
      delete process.env.PARADOC_JUDGE;

      const h = makeHarness({
        generate: async () => ({
          data: {
            text: JSON.stringify({
              excerpts: [{ startLine: 10, endLine: 12 }],
              summary: "s",
              confidence: 4,
            }),
          },
        }),
      });
      (h.ctx as { location?: unknown }).location = { directory: dir };

      const nativeResult = { output: content, content };
      const exec = h.wrapReadTool(async () => nativeResult);
      // offset is set → hook bypasses → output unchanged → wrapper returns result as-is
      const result = await exec({ path: file, offset: 5 }, { sessionID: "s", id: "c" });

      strictEqual(result, nativeResult);
      strictEqual(result.output, content, "output should be unchanged for offset reads");
    } finally {
      restoreEnv(saved);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("childSessions-guarded session gets no rewrite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paradoc-v2-child-"));
    const saved = { ...process.env };
    try {
      mkdirSync(join(dir, ".paradoc"));
      writeFileSync(
        join(dir, ".paradoc", "config.json"),
        JSON.stringify({ version: 1, model: { providerID: "p", modelID: "m" } }),
      );
      const file = join(dir, "big.ts");
      const content = Array.from({ length: 3000 }, (_, i) => `const v_${i + 1} = ${i + 1};`).join("\n");
      writeFileSync(file, content);

      process.env.HOME = dir;
      process.env.XDG_CONFIG_HOME = join(dir, "xdg");
      process.env.PARADOC_CHUNK_LINES = "1000";
      process.env.PARADOC_CONCURRENCY = "3";
      delete process.env.PARADOC_CACHE;
      delete process.env.PARADOC_THRESHOLD;
      delete process.env.PARADOC_JUDGE;

      let generates = 0;
      const h = makeHarness(
        {
          generate: async () => {
            generates += 1;
            return {
              data: {
                text: JSON.stringify({
                  excerpts: [{ startLine: 10, endLine: 12 }],
                  summary: "s",
                  confidence: 4,
                }),
              },
            };
          },
        },
      );
      (h.ctx as { location?: unknown }).location = { directory: dir };

      // First call: normal session → interception runs → child session "ses_child" created
      const nativeResult1 = { output: content, content };
      const exec1 = h.wrapReadTool(async () => nativeResult1);
      await exec1({ path: file }, { sessionID: "normal-session", id: "c1" });
      ok(generates > 0, "first call should trigger interception");

      // Second call: child session ID → childSessions guard → no rewrite
      const nativeResult2 = { output: content, content };
      const exec2 = h.wrapReadTool(async () => nativeResult2);
      const result2 = await exec2({ path: file }, { sessionID: "ses_child", id: "c2" });

      strictEqual(result2, nativeResult2);
      strictEqual(result2.output, content, "child session output should be unchanged");
    } finally {
      restoreEnv(saved);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hook failure (non-existent file) leaves native result intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paradoc-v2-fail-"));
    const saved = { ...process.env };
    try {
      mkdirSync(join(dir, ".paradoc"));
      writeFileSync(
        join(dir, ".paradoc", "config.json"),
        JSON.stringify({ version: 1, model: { providerID: "p", modelID: "m" } }),
      );

      process.env.HOME = dir;
      process.env.XDG_CONFIG_HOME = join(dir, "xdg");
      delete process.env.PARADOC_CACHE;
      delete process.env.PARADOC_THRESHOLD;
      delete process.env.PARADOC_JUDGE;

      const h = makeHarness();
      const content = "some content";
      const nativeResult = { output: content, content };
      const exec = h.wrapReadTool(async () => nativeResult);
      // File does not exist → hook's internal try/catch logs error, output unchanged
      const result = await exec({ path: join(dir, "nonexistent.ts") }, { sessionID: "s", id: "c" });

      strictEqual(result, nativeResult);
      strictEqual(result.output, content, "output should be unchanged when hook fails internally");
    } finally {
      restoreEnv(saved);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Tuning (env / config) via the wrapper path
// ---------------------------------------------------------------------------

describe("ParaDocV2Plugin tuning", () => {
  it("honours PARADOC_CHUNK_LINES from process env via loadTuning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paradoc-v2-"));
    const saved = { ...process.env };
    try {
      mkdirSync(join(dir, ".paradoc"));
      writeFileSync(
        join(dir, ".paradoc", "config.json"),
        JSON.stringify({ version: 1, model: { providerID: "p", modelID: "m" } }),
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
      const h = makeHarness({
        generate: async () => {
          generates += 1;
          return {
            data: {
              text: JSON.stringify({
                excerpts: [{ startLine: 10, endLine: 12 }],
                summary: "s",
                confidence: 4,
              }),
            },
          };
        },
      });
      (h.ctx as { location?: unknown }).location = { directory: dir };
      const content = "x\n".repeat(3000);
      const nativeResult = { output: content, content };
      const exec = h.wrapReadTool(async () => nativeResult);
      const result = await exec({ path: file }, { sessionID: "s", id: "c" });
      strictEqual(generates, 4);
      ok(result.output.includes("lines 10-12"));
    } finally {
      restoreEnv(saved);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Session prompt hook
// ---------------------------------------------------------------------------

describe("ParaDocV2Plugin session prompt hook", () => {
  it("swallows malformed prompt events", async () => {
    const h = makeHarness();
    await h.sessionHooks["session.prompt"]({ sessionID: "s", prompt: null });
  });
});

// ---------------------------------------------------------------------------
// createV2Client (unchanged)
// ---------------------------------------------------------------------------

describe("createV2Client", () => {
  it("maps runner calls onto flat v2 session API and wraps generated text", async () => {
    const calls: Array<[string, unknown]> = [];
    const ctx: ParaDocV2Context = {
      location: { directory: "/tmp/does-not-matter" },
      tool: { transform: () => {} },
      session: {
        create: async (p: unknown) => {
          calls.push(["create", p]);
          return { data: { id: "ses_child" } };
        },
        generate: async (p: unknown) => {
          calls.push(["generate", p]);
          return { data: { text: '{"ok":true}' } };
        },
        remove: async (p: unknown) => {
          calls.push(["remove", p]);
        },
        interrupt: async (p: unknown) => {
          calls.push(["interrupt", p]);
        },
        switchModel: async (p: unknown) => {
          calls.push(["switchModel", p]);
        },
      },
    };
    const client = createV2Client(ctx);
    const created = await client.session.create({ body: { title: "t" } });
    deepStrictEqual(created, { data: { id: "ses_child" } });
    const response = await client.session.prompt({
      path: { id: "ses_child" },
      body: { parts: [{ type: "text", text: "hi" }], model: { providerID: "p", modelID: "m" } },
    });
    deepStrictEqual(response, { data: { info: {}, parts: [{ type: "text", text: '{"ok":true}' }] } });
    await client.session.delete({ path: { id: "ses_child" } });
    deepStrictEqual(calls.map(([n]) => n), ["create", "switchModel", "generate", "remove"]);
    deepStrictEqual(calls[1][1], { sessionID: "ses_child", model: { id: "m", providerID: "p" } });
    deepStrictEqual(calls[2][1], { sessionID: "ses_child", prompt: "hi" });
  });

  it("throws when generate returns no text", async () => {
    const ctx: ParaDocV2Context = {
      location: { directory: "/tmp/does-not-matter" },
      tool: { transform: () => {} },
      session: {
        create: async () => ({ data: { id: "s" } }),
        generate: async () => ({ data: {} }),
        remove: async () => {},
      },
    };
    const client = createV2Client(ctx);
    await client.session.prompt({ path: { id: "s" }, body: { parts: [{ type: "text", text: "x" }] } }).then(
      () => {
        throw new Error("expected rejection");
      },
      (error: Error) => ok(/no text/.test(error.message)),
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
  for (const key of ["PARADOC_CHUNK_LINES", "PARADOC_CONCURRENCY", "PARADOC_CACHE", "PARADOC_THRESHOLD", "PARADOC_JUDGE"]) {
    if (saved[key] === undefined) delete process.env[key];
  }
}
