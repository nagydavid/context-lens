import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FakeSubagentRunner } from "../core/fake-runner.js";
import { createCopilotHooks } from "./hooks.js";
import { buildE2eFixture, buildViewInput, E2E_FIXTURE_SYMBOL } from "./probe-fixture.js";

const answer = {
  excerpts: [{ startLine: 232, endLine: 238, reason: "checksum implementation" }],
  summary: "The checksum implementation normalizes its input.",
  confidence: 4,
};

let tmp: string;
let largePath: string;
let smallPath: string;
let chunkedPath: string;
before(() => {
  tmp = mkdtempSync(join(process.cwd(), "context-lens-copilot-hooks-"));
  largePath = join(tmp, "fixture.ts");
  smallPath = join(tmp, "small.ts");
  writeFileSync(largePath, buildE2eFixture());
  writeFileSync(smallPath, Array.from({ length: 20 }, (_, index) => `const small${index} = ${index};`).join("\n"));
  chunkedPath = join(tmp, "chunked.ts");
  writeFileSync(chunkedPath, Array.from({ length: 3000 }, (_, index) => `const chunk${index + 1} = ${index + 1};`).join("\n"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function setup(extra: Parameters<typeof createCopilotHooks>[0] = {}) {
  const runner = new FakeSubagentRunner({ structured: answer });
  const logs: { line: string; record: Record<string, unknown> }[] = [];
  const hooks = createCopilotHooks({
    runner,
    configOptions: { homeDir: tmp, env: {} },
    env: {},
    logSink: (line, record) => logs.push({ line, record: record as Record<string, unknown> }),
    ...extra,
  });
  return { hooks, runner, logs };
}

function view(path: string, overrides: Partial<Parameters<typeof buildViewInput>[0]> = {}) {
  return buildViewInput({ path, workingDirectory: tmp, text: "original native view", ...overrides });
}

describe("createCopilotHooks", () => {
  it("(a) condenses a large native view and preserves result metadata", async () => {
    const { hooks, logs } = setup();
    const input = view(largePath);
    const result = await hooks.onPostToolUse(input);
    ok(result?.modifiedResult);
    strictEqual(result.modifiedResult.resultType, input.toolResult.resultType);
    deepStrictEqual(result.modifiedResult.toolTelemetry, input.toolResult.toolTelemetry);
    const text = result.modifiedResult.textResultForLlm;
    ok(text.includes("[context-lens]"));
    ok(text.includes("Confidence: 4/5"));
    ok(text.includes("view_range"));
    ok(text.includes(E2E_FIXTURE_SYMBOL));
    ok(!text.includes("fixtureValue400"));
    ok(logs.some(({ line, record }) => line.includes("intercepted") && typeof record.elapsedMs === "number"));
  });

  it("(b) passes through a small file without running the subagent", async () => {
    const { hooks, runner } = setup();
    strictEqual(await hooks.onPostToolUse(view(smallPath)), undefined);
    strictEqual(runner.calls.length, 0);
  });

  it("(c) passes through range arguments without running the subagent", async () => {
    for (const toolArgs of [{ path: largePath, view_range: [1, 50] }, { path: largePath, range: [1, 50] }]) {
      const { hooks, runner } = setup();
      strictEqual(await hooks.onPostToolUse(view(largePath, { toolArgs })), undefined);
      strictEqual(runner.calls.length, 0);
    }
  });

  it("(d) passes through directory views from telemetry or stat", async () => {
    const directory = join(tmp, "directory");
    mkdirSync(directory, { recursive: true });
    for (const input of [view(directory, { viewType: "directory" }), view(directory)]) {
      const { hooks } = setup();
      strictEqual(await hooks.onPostToolUse(input), undefined);
    }
  });

  it("(e, f) passes through non-view tools and failed tool results", async () => {
    const { hooks } = setup();
    strictEqual(await hooks.onPostToolUse({ ...view(largePath), toolName: "bash" }), undefined);
    strictEqual(await hooks.onPostToolUse(view(largePath, { resultType: "failure" })), undefined);
  });

  it("(g) ignores child Copilot processes", async () => {
    const { hooks, runner } = setup({ env: { CONTEXT_LENS_CHILD: "1" } });
    strictEqual(await hooks.onPostToolUse(view(largePath)), undefined);
    strictEqual(runner.calls.length, 0);
  });

  it("(h) degrades to the native output and logs a fallback when the runner rejects", async () => {
    const logs: { record: Record<string, unknown> }[] = [];
    const hooks = createCopilotHooks({
      runner: new FakeSubagentRunner(() => { throw new Error("boom"); }),
      configOptions: { homeDir: tmp, env: {} },
      env: {},
      logSink: (_line, record) => logs.push({ record: record as Record<string, unknown> }),
    });
    strictEqual(await hooks.onPostToolUse(view(largePath)), undefined);
    ok(logs.some(({ record }) => record.level === "warn" && record.fallbackReason === "subagent-error"));
  });

  it("(i) includes the submitted user prompt as the current task", async () => {
    const { hooks, runner } = setup();
    await hooks.onUserPromptSubmitted({ sessionId: "prompt-session", prompt: "  find the checksum implementation  " });
    await hooks.onPostToolUse(view(largePath, { sessionId: "prompt-session" }));
    ok(runner.calls[0].prompt.includes("Current task: find the checksum implementation"));
  });

  it("(j) supplies a configured project model to the runner", async () => {
    const configDir = join(tmp, ".context-lens");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ version: 1, model: { providerID: "test", modelID: "focused" } }));
    try {
      const { hooks, runner } = setup();
      await hooks.onPostToolUse(view(largePath));
      deepStrictEqual(runner.calls[0].model, { providerID: "test", modelID: "focused" });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("(k) resolves a relative path against the working directory", async () => {
    const { hooks, runner } = setup();
    const result = await hooks.onPostToolUse(view("fixture.ts"));
    ok(result?.modifiedResult?.textResultForLlm.includes("fixture.ts"));
    strictEqual(runner.calls.length, 1);
  });

  it("(l) renders chunked reads and reports chunk failures as host-safe fallbacks", async () => {
    const { hooks, runner, logs } = setup({ chunkLines: 1000, chunkOverlapLines: 50 });
    const result = await hooks.onPostToolUse(view(chunkedPath));
    ok(result?.modifiedResult?.textResultForLlm.includes("--- lines 232-238"));
    strictEqual(runner.calls.length, 4);
    ok(logs.some(({ line }) => /chunks=4, \d+ms\)/.test(line)));

    let calls = 0;
    const failing = new FakeSubagentRunner(() => {
      calls += 1;
      if (calls === 2) throw new Error("chunk failure");
      return { structured: answer };
    });
    const fallbackLogs: Array<{ record: Record<string, unknown> }> = [];
    const fallback = createCopilotHooks({ runner: failing, chunkLines: 1000, chunkOverlapLines: 50, configOptions: { homeDir: tmp, env: {} }, env: {}, logSink: (_line, record) => fallbackLogs.push({ record: record as Record<string, unknown> }) });
    strictEqual(await fallback.onPostToolUse(view(chunkedPath)), undefined);
    ok(fallbackLogs.some(({ record }) => record.level === "warn" && String(record.message).includes("chunk 2/4: chunk failure")));
  });

  it("(m) appends structured JSONL diagnostics when configured", async () => {
    const logFile = join(tmp, "context-lens.jsonl");
    const { hooks } = setup({ env: { CONTEXT_LENS_LOG_FILE: logFile } });
    await hooks.onPostToolUse(view(largePath));
    const record = JSON.parse(readFileSync(logFile, "utf8").trim()) as Record<string, unknown>;
    strictEqual(record.level, "info");
    strictEqual(record.intercepted, true);
  });
});
