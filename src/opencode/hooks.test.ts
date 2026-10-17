import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { after, before, describe, it } from "node:test";
import { FakeSubagentRunner } from "../core/fake-runner.js";
import { JUDGE_SCHEMA } from "../core/judge.js";
import { ConcurrencyLimitedRunner } from "../core/subagent.js";
import { createContextLensHooks } from "./hooks.js";
import type { ContextLensClient, ContextLensHooksOptions } from "./hooks.js";

const answer = {
  excerpts: [{ startLine: 10, endLine: 12, reason: "target" }],
  summary: "Found it.",
  confidence: 4,
};
const tick = () => new Promise((r) => setImmediate(r));

let tmp: string;
let largePath: string;
let smallPath: string;
let chunkedPath: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "context-lens-hooks-"));
  largePath = join(tmp, "large.ts");
  smallPath = join(tmp, "small.ts");
  writeFileSync(largePath, Array.from({ length: 400 }, (_, i) => `const line_${i + 1} = ${i + 1};`).join("\n"));
  writeFileSync(smallPath, Array.from({ length: 100 }, (_, i) => `small ${i + 1}`).join("\n"));
  chunkedPath = join(tmp, "chunked.ts");
  writeFileSync(chunkedPath, Array.from({ length: 3000 }, (_, i) => `const chunk_${i + 1} = ${i + 1};`).join("\n"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const noopClient = {
  session: {
    create: async () => ({}),
    prompt: async () => ({}),
    delete: async () => ({}),
  },
} as ContextLensClient;

function setup(extra: Partial<ContextLensHooksOptions> = {}) {
  const runner = new FakeSubagentRunner({ structured: answer });
  const hooks = createContextLensHooks({
    client: noopClient,
    directory: tmp,
    runner,
    configOptions: { homeDir: tmp, env: {} },
    ...extra,
  });
  return { hooks, runner };
}

const synthetic = (filePath: string) =>
  Array.from({ length: 400 }, (_, i) => `${i + 1}: padded synthetic native read output for ${filePath}`).join("\n");
const mkOutput = (filePath: string) => ({ title: filePath, output: synthetic(filePath), metadata: { a: 1 } });
const call = (tool: string, args: unknown, sessionID = "s1") => ({ tool, sessionID, callID: "c1", args });

describe("createContextLensHooks", () => {
  it("(a) replaces large file output with rendered excerpts", async () => {
    const { hooks, runner } = setup();
    const out = mkOutput(largePath);
    const original = out.output;
    await hooks["tool.execute.after"](call("read", { filePath: largePath }), out);
    ok(out.output.includes("lines 10-12"));
    ok(out.output.includes("Confidence: 4/5"));
    ok(out.output.includes("const line_10 = 10;"));
    ok(out.output.length < original.length);
    strictEqual(out.title, largePath);
    deepStrictEqual(out.metadata, { a: 1 });
    strictEqual(runner.calls.length, 1);
  });

  it("(a.1) accepts the OpenCode v2 read path argument", async () => {
    const { hooks, runner } = setup();
    const out = mkOutput(largePath);
    await hooks["tool.execute.after"](call("read", { path: largePath }), out);
    ok(out.output.includes("lines 10-12"));
    strictEqual(runner.calls.length, 1);
  });

  it("(b) leaves small files untouched", async () => {
    const { hooks, runner } = setup();
    const out = mkOutput(smallPath);
    const snapshot = structuredClone(out);
    await hooks["tool.execute.after"](call("read", { filePath: smallPath }), out);
    deepStrictEqual(out, snapshot);
    strictEqual(runner.calls.length, 0);
  });

  it("(c) ranged reads pass through", async () => {
    for (const args of [{ offset: 0 }, { limit: 50 }]) {
      const { hooks, runner } = setup();
      const out = mkOutput(largePath);
      const snapshot = structuredClone(out);
      await hooks["tool.execute.after"](call("read", { filePath: largePath, ...args }), out);
      deepStrictEqual(out, snapshot);
      strictEqual(runner.calls.length, 0);
    }
  });

  it("(d) ignores other tools and matches Read case-insensitively", async () => {
    const { hooks } = setup();
    const bash = mkOutput(largePath);
    const snapshot = structuredClone(bash);
    await hooks["tool.execute.after"](call("bash", { filePath: largePath }), bash);
    deepStrictEqual(bash, snapshot);
    const read = mkOutput(largePath);
    await hooks["tool.execute.after"](call("Read", { filePath: largePath }), read);
    ok(read.output.includes("lines 10-12"));
  });

  it("(e) runner rejection leaves output unchanged", async () => {
    const { hooks } = setup({
      runner: new FakeSubagentRunner(() => {
        throw new Error("boom");
      }),
    });
    const out = mkOutput(largePath);
    const snapshot = structuredClone(out);
    await hooks["tool.execute.after"](call("read", { filePath: largePath }), out);
    deepStrictEqual(out, snapshot);
  });

  it("(f) missing file leaves output unchanged", async () => {
    const { hooks } = setup();
    const missing = join(tmp, "nope.ts");
    const out = mkOutput(missing);
    const snapshot = structuredClone(out);
    await hooks["tool.execute.after"](call("read", { filePath: missing }), out);
    deepStrictEqual(out, snapshot);
  });

  it("(g) missing or empty args leave output unchanged", async () => {
    const { hooks, runner } = setup();
    for (const args of [undefined, {}, null, { filePath: "" }, { filePath: 3 }]) {
      const out = mkOutput(largePath);
      const snapshot = structuredClone(out);
      await hooks["tool.execute.after"](call("read", args), out);
      deepStrictEqual(out, snapshot);
    }
    strictEqual(runner.calls.length, 0);
  });

  it("(h) throwing or rejecting app.log does not break interception", async () => {
    for (const log of [
      () => {
        throw new Error("sync");
      },
      () => Promise.reject(new Error("async")),
    ]) {
      const client = { ...noopClient, app: { log } } as ContextLensClient;
      const { hooks } = setup({ client });
      const out = mkOutput(largePath);
      await hooks["tool.execute.after"](call("read", { filePath: largePath }), out);
      ok(out.output.includes("lines 10-12"));
      await tick();
    }
  });

  it("(i) chat.message text feeds the prompt; explicit question wins", async () => {
    const { hooks, runner } = setup();
    await hooks["chat.message"](
      { sessionID: "s1" },
      {
        message: {},
        parts: [
          { type: "text", text: "find the auth handler" },
          { type: "text", text: "ignored", synthetic: true },
          { type: "file" },
        ],
      }
    );
    await hooks["tool.execute.after"](call("read", { filePath: largePath }), mkOutput(largePath));
    ok(runner.calls[0].prompt.includes("find the auth handler"));
    ok(!runner.calls[0].prompt.includes("ignored"));
    await hooks["tool.execute.after"](
      call("read", { filePath: largePath, question: "where is X?" }),
      mkOutput(largePath)
    );
    ok(runner.calls[1].prompt.includes("where is X?"));
  });

  it("(j) forwards structured logs and warns on corrupt config", async () => {
    const logs: { body: { service: string; level: string; message: string; extra?: Record<string, unknown> } }[] = [];
    const client = {
      ...noopClient,
      app: {
        log: async (o: (typeof logs)[number]) => {
          logs.push(o);
        },
      },
    } as ContextLensClient;
    const dir = mkdtempSync(join(tmpdir(), "context-lens-hooks-cfg-"));
    try {
      mkdirSync(join(dir, ".context-lens"));
      writeFileSync(join(dir, ".context-lens", "config.json"), "{not json");
      const { hooks } = setup({ client, directory: dir });
      await hooks["tool.execute.after"](call("read", { filePath: largePath }), mkOutput(largePath));
      await tick();
      ok(logs.some((l) => l.body.service === "context-lens" && l.body.level === "info" && l.body.extra?.intercepted === true));
      ok(logs.some((l) => l.body.level === "warn"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(k) fans out chunked reads, logs chunks, and preserves serial defaults", async () => {
    let active = 0;
    let maxInFlight = 0;
    const delayed = new FakeSubagentRunner(async () => {
      active += 1;
      maxInFlight = Math.max(maxInFlight, active);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      active -= 1;
      return { structured: answer };
    });
    const logs: Array<{ body: { message: string } }> = [];
    const client = { ...noopClient, app: { log: async (entry: { body: { message: string } }) => { logs.push(entry); } } } as ContextLensClient;
    const hooks = createContextLensHooks({ client, directory: tmp, runner: new ConcurrencyLimitedRunner(delayed, 3), chunkLines: 1000, chunkOverlapLines: 50 });
    const out = mkOutput(chunkedPath);
    await hooks["tool.execute.after"](call("read", { filePath: chunkedPath }), out);
    await tick();
    ok(out.output.includes("lines 10-12"));
    ok(out.output.includes("const chunk_10 = 10;"));
    strictEqual(delayed.calls.length, 4);
    ok(maxInFlight > 1);
    ok(logs.some((entry) => /chunks=4, \d+ms\)$/.test(entry.body.message)));

    const serialLogs: Array<{ body: { message: string } }> = [];
    const serial = setup({ client: { ...noopClient, app: { log: async (entry: { body: { message: string } }) => { serialLogs.push(entry); } } } as ContextLensClient });
    await serial.hooks["tool.execute.after"](call("read", { filePath: chunkedPath }), mkOutput(chunkedPath));
    await tick();
    strictEqual(serial.runner.calls.length, 1);
    ok(serialLogs.some((entry) => /^intercepted /.test(entry.body.message) && !entry.body.message.includes("chunks=")));
  });

  it("(l) skips the plugin's own child sessions without deadlocking", { timeout: 5000 }, async () => {
    let hooks: ReturnType<typeof createContextLensHooks>;
    const nested = mkOutput(largePath);
    const nestedSnapshot = structuredClone(nested);
    const client = {
      session: {
        create: async () => ({ data: { id: "child-1" } }),
        prompt: async () => {
          await hooks["tool.execute.after"](call("read", { filePath: largePath }, "child-1"), nested);
          return { data: { info: { structured: answer }, parts: [] } };
        },
        delete: async () => ({}),
      },
    } as ContextLensClient;
    hooks = createContextLensHooks({
      client,
      directory: tmp,
      configOptions: { homeDir: tmp, env: {} },
    });
    const outer = mkOutput(largePath);
    await hooks["tool.execute.after"](call("read", { filePath: largePath }, "parent"), outer);
    deepStrictEqual(nested, nestedSnapshot);
    ok(outer.output.includes("lines 10-12"));
  });

  it("(m) renders judge outcomes and warns on a judge error", async () => {
    for (const [judgeResult, expected, level, intercepted] of [
      [{ structured: { verdict: "sufficient" } }, "judge=sufficient", "info", true],
      [{ structured: { verdict: "insufficient", reason: "missing context" } }, "judge-rejected", "warn", false],
      [{ text: "not JSON" }, "judge=error", "warn", true],
    ] as const) {
      const logs: Array<{ body: { level: string; message: string } }> = [];
      const runner = new FakeSubagentRunner((request) => request.schema === JUDGE_SCHEMA ? judgeResult : { structured: answer });
      const client = { ...noopClient, app: { log: async (entry: (typeof logs)[number]) => { logs.push(entry); } } } as ContextLensClient;
      const hooks = createContextLensHooks({ client, directory: tmp, runner, judge: { mode: "always" }, configOptions: { homeDir: tmp, env: {} } });
      const out = mkOutput(largePath);
      const original = out.output;
      await hooks["tool.execute.after"](call("read", { filePath: largePath }), out);
      await tick();
      strictEqual(out.output.includes("lines 10-12"), intercepted);
      if (!intercepted) strictEqual(out.output, original);
      ok(logs.some((entry) => entry.body.level === level && entry.body.message.includes(expected)));
      strictEqual(runner.calls.filter((request) => request.schema === JUDGE_SCHEMA).length, 1);
    }
  });

  it("(n) omits judge calls and judge diagnostics when judge is unset", async () => {
    const logs: Array<{ body: { message: string } }> = [];
    const client = { ...noopClient, app: { log: async (entry: (typeof logs)[number]) => { logs.push(entry); } } } as ContextLensClient;
    const { hooks, runner } = setup({ client });
    await hooks["tool.execute.after"](call("read", { filePath: largePath }), mkOutput(largePath));
    await tick();
    strictEqual(runner.calls.length, 1);
    ok(logs.some((entry) => entry.body.message.startsWith("intercepted ") && !entry.body.message.includes("judge=")));
  });

  it("(o) serves a repeat read from the shared cache and misses after an edit", async () => {
    const logs: Array<{ body: { message: string } }> = [];
    const client = { ...noopClient, app: { log: async (entry: (typeof logs)[number]) => { logs.push(entry); } } } as ContextLensClient;
    const { hooks, runner } = setup({ client });
    const cachePath = join(tmp, "cache-me.ts");
    writeFileSync(cachePath, Array.from({ length: 400 }, (_, i) => `const cached_${i + 1} = ${i + 1};`).join("\n"));
    const first = mkOutput(cachePath);
    await hooks["tool.execute.after"](call("read", { filePath: cachePath }), first);
    const second = mkOutput(cachePath);
    await hooks["tool.execute.after"](call("read", { filePath: cachePath }), second);
    await tick();
    strictEqual(second.output, first.output);
    strictEqual(runner.calls.length, 1);
    ok(logs.some((entry) => entry.body.message.includes("cacheHit=true")));
    writeFileSync(cachePath, Array.from({ length: 400 }, (_, i) => `const edited_${i + 1} = ${i + 1};`).join("\n"));
    await hooks["tool.execute.after"](call("read", { filePath: cachePath }), mkOutput(cachePath));
    strictEqual(runner.calls.length, 2);
  });

  describe("tuning config", () => {
    const writeProjectConfig = (dir: string, tuning: unknown) => {
      mkdirSync(join(dir, ".context-lens"), { recursive: true });
      writeFileSync(join(dir, ".context-lens", "config.json"), JSON.stringify({ version: 1, tuning }));
    };
    const tuningDir = (name: string, tuning: unknown) => {
      const dir = mkdtempSync(join(tmp, `${name}-`));
      writeProjectConfig(dir, tuning);
      return dir;
    };
    const lineFile = (dir: string, lines: number, name = "f.ts") => {
      const path = join(dir, name);
      writeFileSync(path, Array.from({ length: lines }, (_, i) => `const v_${i + 1} = ${i + 1};`).join("\n"));
      return path;
    };
    const mkLogClient = (logs: Array<{ body: { level: string; message: string } }>) =>
      ({ ...noopClient, app: { log: async (entry: (typeof logs)[number]) => { logs.push(entry); } } }) as ContextLensClient;
    const build = (directory: string, extra: Partial<ContextLensHooksOptions> = {}) => {
      const runner = new FakeSubagentRunner({ structured: answer });
      const logs: Array<{ body: { level: string; message: string } }> = [];
      const hooks = createContextLensHooks({
        client: mkLogClient(logs),
        directory,
        runner,
        configOptions: { homeDir: tmp, env: { XDG_CONFIG_HOME: join(tmp, "xdg") } },
        ...extra,
      });
      return { hooks, runner, logs };
    };

    it("(p) project thresholdLines intercepts a file the default would pass", async () => {
      const dir = tuningDir("thr", { thresholdLines: 300 });
      const file = lineFile(dir, 320);
      const withConfig = build(dir);
      const out = mkOutput(file);
      await withConfig.hooks["tool.execute.after"](call("read", { filePath: file }), out);
      strictEqual(withConfig.runner.calls.length, 1);
      ok(out.output.includes("lines 10-12"));

      const plain = build(tmp);
      await plain.hooks["tool.execute.after"](call("read", { filePath: file }), mkOutput(file));
      strictEqual(plain.runner.calls.length, 0);
    });

    it("(q) project chunkLines fans out chunk calls", async () => {
      const dir = tuningDir("chunk", { chunkLines: 1000, chunkOverlapLines: 50 });
      const file = lineFile(dir, 3000);
      const { hooks, runner, logs } = build(dir);
      await hooks["tool.execute.after"](call("read", { filePath: file }), mkOutput(file));
      await tick();
      strictEqual(runner.calls.length, 4);
      ok(logs.some((entry) => /chunks=4/.test(entry.body.message)));
    });

    it("(r) explicit thresholdLines beats project config", async () => {
      const dir = tuningDir("explicit", { thresholdLines: 300 });
      const file = lineFile(dir, 320);
      const { hooks, runner } = build(dir, { thresholdLines: 500 });
      await hooks["tool.execute.after"](call("read", { filePath: file }), mkOutput(file));
      strictEqual(runner.calls.length, 0);
    });

    it("(s) cacheMaxEntries 0 disables the shared cache", async () => {
      const dir = tuningDir("nocache", { cacheMaxEntries: 0 });
      const file = lineFile(dir, 400);
      const { hooks, runner } = build(dir);
      await hooks["tool.execute.after"](call("read", { filePath: file }), mkOutput(file));
      await hooks["tool.execute.after"](call("read", { filePath: file }), mkOutput(file));
      strictEqual(runner.calls.length, 2);
    });

    it("(t) env tuning applies and an invalid value warns and uses the default", async () => {
      const dir = tuningDir("invalid", { thresholdLines: "lots" });
      const file = lineFile(dir, 320);
      const { hooks, runner, logs } = build(dir);
      await hooks["tool.execute.after"](call("read", { filePath: file }), mkOutput(file));
      strictEqual(runner.calls.length, 0);
      ok(logs.some((entry) => entry.body.level === "warn" && entry.body.message.includes("ignoring") && entry.body.message.includes("thresholdLines")));

      const viaEnv = build(dir, { configOptions: { homeDir: tmp, env: { XDG_CONFIG_HOME: join(tmp, "xdg"), CONTEXT_LENS_THRESHOLD: "300" } } });
      await viaEnv.hooks["tool.execute.after"](call("read", { filePath: file }), mkOutput(file));
      strictEqual(viaEnv.runner.calls.length, 1);
    });
  });
});
