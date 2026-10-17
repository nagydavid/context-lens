import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { after, before, describe, it } from "node:test";
import { FakeSubagentRunner } from "../core/fake-runner.js";
import { createContextLensHooks } from "./hooks.js";
import type { ContextLensClient, ContextLensHooksOptions } from "./hooks.js";
import type { OpenCodePickerUi } from "./model-picker.js";

const answer = {
  excerpts: [{ startLine: 10, endLine: 12, reason: "target" }],
  summary: "Found it.",
  confidence: 4,
};
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type LogEntry = { service: string; level: string; message: string; extra?: Record<string, unknown> };

let tmp: string;
let largePath: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "context-lens-matrix-"));
  largePath = join(tmp, "large.ts");
  writeFileSync(largePath, Array.from({ length: 400 }, (_, i) => `const line_${i + 1} = ${i + 1};`).join("\n"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const noopSession = {
  create: async () => ({}),
  prompt: async () => ({}),
  delete: async () => ({}),
};

function recordingClient(session: ContextLensClient["session"] = noopSession) {
  const logs: LogEntry[] = [];
  const client = {
    session,
    app: {
      log: async (o: { body: LogEntry }) => {
        logs.push(o.body);
      },
    },
  } as ContextLensClient;
  return { client, logs };
}

function setup(runner: FakeSubagentRunner | undefined, extra: Partial<ContextLensHooksOptions> = {}) {
  const { client, logs } = recordingClient();
  const hooks = createContextLensHooks({
    client,
    directory: tmp,
    runner,
    configOptions: { homeDir: tmp, env: {} },
    ...extra,
  });
  return { hooks, logs };
}

const synthetic = (filePath: string) =>
  Array.from({ length: 400 }, (_, i) => `${i + 1}: padded synthetic native read output for ${filePath}`).join("\n");
const mkOutput = (filePath: string) => ({ title: filePath, output: synthetic(filePath), metadata: { a: 1 } });
const call = (tool: string, args: unknown, sessionID = "s1") => ({ tool, sessionID, callID: "c1", args });

const failureLogged = (logs: LogEntry[], reason?: string) =>
  logs.some(
    (l) =>
      l.service === "context-lens" &&
      (l.level === "error" ||
        (l.level === "warn" &&
          l.extra?.fallbackReason !== undefined &&
          (reason === undefined || l.extra.fallbackReason === reason)))
  );
const fallbackLog = (logs: LogEntry[]) => logs.find((l) => l.extra?.fallbackReason !== undefined);
const infoLog = (logs: LogEntry[]) =>
  logs.find((l) => l.service === "context-lens" && l.level === "info" && l.extra?.intercepted === true);

/** Reads `filePath` through the hook and asserts the host output stayed byte-identical. */
async function expectFallback(hooks: ReturnType<typeof createContextLensHooks>, filePath: string) {
  const out = mkOutput(filePath);
  const snapshot = structuredClone(out);
  await hooks["tool.execute.after"](call("read", { filePath }), out);
  await tick();
  deepStrictEqual(out, snapshot);
}

describe("error matrix (R004)", () => {
  it("#1 spawn failure", async () => {
    let prompted = 0;
    const { client, logs } = recordingClient({
      create: async () => {
        throw new Error("boom");
      },
      prompt: async () => {
        prompted++;
        return {};
      },
      delete: async () => ({}),
    });
    const hooks = createContextLensHooks({ client, directory: tmp, configOptions: { homeDir: tmp, env: {} } });
    await expectFallback(hooks, largePath);
    ok(failureLogged(logs, "subagent-error"));
    ok(String(fallbackLog(logs)?.extra?.detail).includes("spawn failed"));
    strictEqual(prompted, 0);
  });

  it("#2 timeout", async () => {
    const runner = new FakeSubagentRunner({ structured: answer }, 200);
    const { hooks, logs } = setup(runner, { timeoutMs: 20 });
    await expectFallback(hooks, largePath);
    ok(failureLogged(logs, "timeout"));
  });

  it("#3 invalid question", async () => {
    for (const question of ["", "   ", 42]) {
      const runner = new FakeSubagentRunner({ structured: answer });
      const { hooks } = setup(runner);
      const out = mkOutput(largePath);
      await hooks["tool.execute.after"](call("read", { filePath: largePath, question }), out);
      ok(out.output.includes("lines 10-12"), `question ${JSON.stringify(question)} not intercepted`);
      strictEqual(runner.calls.length, 1);
      ok(runner.calls[0].prompt.includes("main purpose of this file"));
    }
  });

  it("#4 subagent error", async () => {
    const runner = new FakeSubagentRunner(() => {
      throw new Error("model refused");
    });
    const { hooks, logs } = setup(runner, { retryDelayMs: 1 });
    await expectFallback(hooks, largePath);
    ok(failureLogged(logs, "subagent-error"));
    strictEqual(runner.calls.length, 1);
  });

  it("#5 file not found", async () => {
    const runner = new FakeSubagentRunner({ structured: answer });
    const { hooks, logs } = setup(runner);
    await expectFallback(hooks, join(tmp, "does-not-exist.ts"));
    strictEqual(runner.calls.length, 0);
    ok(failureLogged(logs, "file-not-found"));
  });

  it("#6 file too large / binary", async () => {
    const big = new FakeSubagentRunner({ structured: answer });
    const tooLarge = setup(big, { maxFileBytes: 1024 });
    await expectFallback(tooLarge.hooks, largePath);
    strictEqual(big.calls.length, 0);
    ok(failureLogged(tooLarge.logs, "file-too-large"));

    const binPath = join(tmp, "blob.ts");
    const lines = Array.from({ length: 400 }, (_, i) => `row ${i + 1}`);
    lines[2] = "bin\0ary";
    writeFileSync(binPath, lines.join("\n"));
    const bin = new FakeSubagentRunner({ structured: answer });
    const binary = setup(bin);
    await expectFallback(binary.hooks, binPath);
    strictEqual(bin.calls.length, 0);
    ok(failureLogged(binary.logs, "binary-file"));
  });

  it("#7 model config missing", async () => {
    const runner = new FakeSubagentRunner({ structured: answer });
    const { hooks, logs } = setup(runner);
    const out = mkOutput(largePath);
    await hooks["tool.execute.after"](call("read", { filePath: largePath }), out);
    await tick();
    ok(out.output.includes("lines 10-12"));
    strictEqual(runner.calls[0].model, undefined);
    strictEqual(infoLog(logs)?.extra?.modelSource, "none");

    const throwingUi: OpenCodePickerUi = {
      select: async () => {
        throw new Error("ui gone");
      },
      input: async () => {
        throw new Error("ui gone");
      },
    };
    const withUi = setup(new FakeSubagentRunner({ structured: answer }), { ui: throwingUi });
    const out2 = mkOutput(largePath);
    await withUi.hooks["tool.execute.after"](call("read", { filePath: largePath }), out2);
    ok(out2.output.includes("lines 10-12"));
  });

  it("#8 invalid response", async () => {
    for (const response of [{ structured: {} }, { text: "not json" }]) {
      const { hooks, logs } = setup(new FakeSubagentRunner(response));
      await expectFallback(hooks, largePath);
      ok(failureLogged(logs));
      ok(
        ["invalid-response", "invalid-confidence", "no-valid-excerpts"].includes(
          String(fallbackLog(logs)?.extra?.fallbackReason)
        )
      );
    }
  });

  it("#9 network error retried twice", async () => {
    const netError = () => Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
    const always = new FakeSubagentRunner(() => {
      throw netError();
    });
    const failing = setup(always, { retryDelayMs: 1 });
    await expectFallback(failing.hooks, largePath);
    strictEqual(always.calls.length, 3);
    ok(failureLogged(failing.logs, "network-error"));
    ok(String(fallbackLog(failing.logs)?.extra?.detail).includes("after 2 retries"));

    let thrown = false;
    const flaky = new FakeSubagentRunner(() => {
      if (!thrown) {
        thrown = true;
        throw netError();
      }
      return { structured: answer };
    });
    const recovering = setup(flaky, { retryDelayMs: 1 });
    const out = mkOutput(largePath);
    await recovering.hooks["tool.execute.after"](call("read", { filePath: largePath }), out);
    ok(out.output.includes("lines 10-12"));
    strictEqual(flaky.calls.length, 2);
  });

  it("#10 context unavailable", async () => {
    const { hooks, logs } = setup(new FakeSubagentRunner({ structured: answer }));
    const out = mkOutput(largePath);
    await hooks["tool.execute.after"](call("read", { filePath: largePath }, "fresh-session"), out);
    await tick();
    ok(out.output.includes("lines 10-12"));
    strictEqual(infoLog(logs)?.extra?.questionSource, "inferred");
  });

  it("#11 concurrent reads show one picker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-lens-matrix-pick-"));
    try {
      let selects = 0;
      let inputs = 0;
      const ui: OpenCodePickerUi = {
        select: async <T extends string>(): Promise<T | undefined> => {
          selects++;
          await sleep(10);
          return "project" as T;
        },
        input: async () => {
          inputs++;
          await sleep(10);
          return "openai/gpt-mini";
        },
      };
      let inFlight = 0;
      let maxInFlight = 0;
      let sessions = 0;
      const { client } = recordingClient({
        create: async () => ({ data: { id: `child-${++sessions}` } }),
        prompt: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await sleep(5);
          inFlight--;
          return { data: { info: { structured: answer }, parts: [] } };
        },
        delete: async () => ({}),
      });
      const hooks = createContextLensHooks({
        client,
        directory: dir,
        ui,
        configOptions: { homeDir: dir, env: {} },
      });
      const outs = [mkOutput(largePath), mkOutput(largePath), mkOutput(largePath)];
      await Promise.all(outs.map((out) => hooks["tool.execute.after"](call("read", { filePath: largePath }), out)));
      strictEqual(inputs, 1);
      strictEqual(selects, 1);
      for (const out of outs) ok(out.output.includes("lines 10-12"));
      // Identical concurrent reads coalesce into one subagent session.
      strictEqual(sessions, 1);
      strictEqual(maxInFlight, 1);
      ok(existsSync(join(dir, ".context-lens", "config.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
