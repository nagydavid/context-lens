import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FakeSubagentRunner } from "../core/fake-runner.js";
import type { PdfExtractor } from "../core/pdf.js";
import { JUDGE_SCHEMA } from "../core/judge.js";
import { createCopilotHooks } from "./hooks.js";
import { buildE2eFixture, buildLargeE2eFixture, buildViewInput, E2E_FIXTURE_SYMBOL, E2E_LARGE_FIXTURE_LINES, E2E_LARGE_FIXTURE_SYMBOL } from "./probe-fixture.js";

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
  tmp = mkdtempSync(join(process.cwd(), "paradoc-copilot-hooks-"));
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
    configOptions: { homeDir: tmp, env: {}, projectRoot: tmp },
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
  it("re-exports the large e2e fixture used by the live harness", () => {
    const large = buildLargeE2eFixture();
    strictEqual(large.split("\n").length, E2E_LARGE_FIXTURE_LINES);
    ok(large.includes(`export function ${E2E_LARGE_FIXTURE_SYMBOL}`));
  });

  it("(a) condenses a large native view and preserves result metadata", async () => {
    const { hooks, logs } = setup();
    const input = view(largePath);
    const result = await hooks.onPostToolUse(input);
    ok(result?.modifiedResult);
    strictEqual(result.modifiedResult.resultType, input.toolResult.resultType);
    deepStrictEqual(result.modifiedResult.toolTelemetry, input.toolResult.toolTelemetry);
    const text = result.modifiedResult.textResultForLlm;
    ok(text.includes("[paradoc]"));
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
    const { hooks, runner } = setup({ env: { PARADOC_CHILD: "1" } });
    strictEqual(await hooks.onPostToolUse(view(largePath)), undefined);
    strictEqual(runner.calls.length, 0);
  });

  it("(h) degrades to the native output and logs a fallback when the runner rejects", async () => {
    const logs: { record: Record<string, unknown> }[] = [];
    const hooks = createCopilotHooks({
      runner: new FakeSubagentRunner(() => { throw new Error("boom"); }),
      configOptions: { homeDir: tmp, env: {}, projectRoot: tmp },
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
    const configDir = join(tmp, ".paradoc");
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
    const fallback = createCopilotHooks({ runner: failing, chunkLines: 1000, chunkOverlapLines: 50, configOptions: { homeDir: tmp, env: {}, projectRoot: tmp }, env: {}, logSink: (_line, record) => fallbackLogs.push({ record: record as Record<string, unknown> }) });
    strictEqual(await fallback.onPostToolUse(view(chunkedPath)), undefined);
    ok(fallbackLogs.some(({ record }) => record.level === "warn" && String(record.message).includes("chunk 2/4: chunk failure")));
  });

  it("(m) renders judge outcomes and logs judge errors as warnings", async () => {
    for (const [judgeResult, expected, level, intercepted] of [
      [{ structured: { verdict: "sufficient" } }, "judge=sufficient", "info", true],
      [{ structured: { verdict: "insufficient", reason: "missing context" } }, "judge-rejected", "warn", false],
      [{ text: "not JSON" }, "judge=error", "warn", true],
    ] as const) {
      const runner = new FakeSubagentRunner((request) => request.schema === JUDGE_SCHEMA ? judgeResult : { structured: answer });
      const logs: { line: string; record: Record<string, unknown> }[] = [];
      const hooks = createCopilotHooks({ runner, judge: { mode: "always" }, configOptions: { homeDir: tmp, env: {}, projectRoot: tmp }, env: {}, logSink: (line, record) => logs.push({ line, record: record as Record<string, unknown> }) });
      const result = await hooks.onPostToolUse(view(largePath));
      strictEqual(Boolean(result?.modifiedResult), intercepted);
      if (intercepted) ok(result?.modifiedResult?.textResultForLlm.includes("[paradoc]"));
      ok(logs.some(({ line, record }) => record.level === level && line.includes(expected)));
      strictEqual(runner.calls.filter((request) => request.schema === JUDGE_SCHEMA).length, 1);
    }
  });

  it("(n) appends structured JSONL diagnostics when configured", async () => {
    const logFile = join(tmp, "paradoc.jsonl");
    const { hooks } = setup({ env: { PARADOC_LOG_FILE: logFile } });
    await hooks.onPostToolUse(view(largePath));
    const record = JSON.parse(readFileSync(logFile, "utf8").trim()) as Record<string, unknown>;
    strictEqual(record.level, "info");
    strictEqual(record.intercepted, true);
  });

  it("(n2) uses the unified diagnostics record shape (ts, no time) in the JSONL log", async () => {
    const logFile = join(tmp, "shape.jsonl");
    const { hooks } = setup({ env: { PARADOC_LOG_FILE: logFile } });
    await hooks.onPostToolUse(view(largePath));
    const record = JSON.parse(readFileSync(logFile, "utf8").trim()) as Record<string, unknown>;
    strictEqual(typeof record.ts, "string");
    ok(!Number.isNaN(Date.parse(String(record.ts))));
    strictEqual("time" in record, false);
    strictEqual(record.level, "info");
    ok(record.stats && typeof record.stats === "object");
  });

  it("(o) serves repeat reads from cache, misses after an edit, and shares the cache across working directories", async () => {
    const { hooks, runner, logs } = setup();
    const first = await hooks.onPostToolUse(view(largePath));
    const second = await hooks.onPostToolUse(view(largePath));
    ok(first?.modifiedResult);
    strictEqual(second?.modifiedResult?.textResultForLlm, first.modifiedResult.textResultForLlm);
    strictEqual(runner.calls.length, 1);
    ok(logs.some(({ line }) => line.includes("cacheHit=true")));

    const otherDir = join(tmp, "other");
    mkdirSync(otherDir, { recursive: true });
    const otherPath = join(otherDir, "fixture.ts");
    writeFileSync(otherPath, buildE2eFixture());
    const shared = await hooks.onPostToolUse(buildViewInput({ path: otherPath, workingDirectory: otherDir, text: "original native view" }));
    ok(shared?.modifiedResult);
    strictEqual(runner.calls.length, 1);

    const editedPath = join(tmp, "edited.ts");
    writeFileSync(editedPath, buildE2eFixture());
    await hooks.onPostToolUse(view(editedPath));
    const callsBefore = runner.calls.length;
    writeFileSync(editedPath, buildE2eFixture() + "\n// edited\n");
    await hooks.onPostToolUse(view(editedPath));
    ok(runner.calls.length > callsBefore);
  });

  it("condenses PDF views and preserves encrypted-PDF native output", async () => {
    const pdfPath = join(tmp, "report.pdf");
    writeFileSync(pdfPath, "%PDF-1.4\nplaceholder");
    const extracted: PdfExtractor = async () => ({ ok: true, pages: 1, text: ["--- page 1 ---", ...Array.from({ length: 400 }, (_, index) => `PDF line ${index + 1}`)].join("\n") });
    const success = setup({
      pdfExtractor: extracted,
      runner: new FakeSubagentRunner({ structured: { excerpts: [{ startLine: 1, endLine: 2, reason: "page marker" }], summary: "page one", confidence: 4 } }),
    });
    const result = await success.hooks.onPostToolUse(view(pdfPath));
    ok(result?.modifiedResult?.textResultForLlm.includes("--- page 1 ---"));

    const encrypted: PdfExtractor = async () => ({ ok: false, reason: "pdf-encrypted", error: "pdf text unavailable", detail: "locked" });
    const fallback = setup({ pdfExtractor: encrypted });
    strictEqual(await fallback.hooks.onPostToolUse(view(pdfPath)), undefined);
    ok(fallback.logs.some(({ record }) => record.level === "warn" && record.fallbackReason === "pdf-encrypted"));
  });

  it("condenses large Markdown and text views while preserving ranged views", async () => {
    const readmePath = join(tmp, "README.md");
    const notesPath = join(tmp, "notes.txt");
    const documentBody = Array.from({ length: 400 }, (_, index) => `Section ${index + 1}: documentation detail`).join("\n");
    writeFileSync(readmePath, documentBody);
    writeFileSync(notesPath, documentBody);

    for (const path of [notesPath, readmePath]) {
      const { hooks, runner } = setup();
      const result = await hooks.onPostToolUse(view(path));
      ok(result?.modifiedResult?.textResultForLlm.includes("--- lines 232-238"));
      ok(runner.calls[0].prompt.includes("inline documentation file"));
    }

    const { hooks, runner } = setup();
    strictEqual(await hooks.onPostToolUse(view(notesPath, { toolArgs: { path: notesPath, view_range: [1, 20] } })), undefined);
    strictEqual(runner.calls.length, 0);
  });

  it("(p) uses an injected cache", async () => {
    const seen: string[] = [];
    const store = new Map<string, any>();
    const cache = {
      get: (key: string) => { seen.push(`get`); return store.get(key); },
      set: (key: string, value: any) => { seen.push(`set`); store.set(key, value); },
    };
    const { hooks, runner } = setup({ cache });
    await hooks.onPostToolUse(view(largePath));
    await hooks.onPostToolUse(view(largePath));
    deepStrictEqual(seen, ["get", "set", "get"]);
    strictEqual(runner.calls.length, 1);
  });

  describe("resolved tuning", () => {
    function tunedDir(name: string, tuning: unknown, lines = 320) {
      const dir = join(tmp, name);
      mkdirSync(join(dir, ".paradoc"), { recursive: true });
      writeFileSync(join(dir, ".paradoc", "config.json"), JSON.stringify({ version: 1, tuning }));
      const path = join(dir, "mid.ts");
      writeFileSync(path, Array.from({ length: lines }, (_, index) => `const mid${index + 1} = ${index + 1};`).join("\n"));
      return { dir, path };
    }
    const viewIn = (item: { dir: string; path: string }) =>
      buildViewInput({ path: item.path, workingDirectory: item.dir, text: "original native view" });

    it("(q) applies project tuning per working directory with one hooks instance", async () => {
      const low = tunedDir("tune-low", { thresholdLines: 300 });
      const dflt = tunedDir("tune-default", {});
      const { hooks, runner } = setup();
      ok((await hooks.onPostToolUse(viewIn(low)))?.modifiedResult);
      strictEqual(runner.calls.length, 1);
      strictEqual(await hooks.onPostToolUse(viewIn(dflt)), undefined);
      strictEqual(runner.calls.length, 1);
    });

    it("(u) process tuning reads configOptions.projectRoot and warns then falls back on invalid values", () => {
      const item = tunedDir("tune-process-invalid", { concurrency: "invalid" });
      const { logs } = setup({ configOptions: { homeDir: tmp, env: {}, projectRoot: item.dir } });
      ok(logs.some((entry) => entry.record.level === "warn" && JSON.stringify(entry.record).includes("concurrency")));
    });

    it("(v) a clean projectRoot yields no config warnings and exactly the interception record", async () => {
      const { hooks, logs } = setup();
      strictEqual(logs.length, 0);
      ok((await hooks.onPostToolUse(view(largePath)))?.modifiedResult);
      strictEqual(logs.length, 1);
    });

    it("(r) explicit options beat project config", async () => {
      const item = tunedDir("tune-explicit", { thresholdLines: 300 });
      const { hooks, runner } = setup({ thresholdLines: 1000 });
      strictEqual(await hooks.onPostToolUse(viewIn(item)), undefined);
      strictEqual(runner.calls.length, 0);
    });

    it("(s) cacheMaxEntries 0 disables repeat-read cache hits", async () => {
      const item = tunedDir("tune-nocache", { thresholdLines: 300 });
      const { hooks, runner } = setup({ configOptions: { homeDir: tmp, env: { PARADOC_CACHE: "off" }, projectRoot: tmp } });
      await hooks.onPostToolUse(viewIn(item));
      await hooks.onPostToolUse(viewIn(item));
      strictEqual(runner.calls.length, 2);
    });

    it("(t) invalid tuning values warn and fall back to defaults", async () => {
      const item = tunedDir("tune-invalid", { thresholdLines: "many" });
      const { hooks, runner, logs } = setup();
      strictEqual(await hooks.onPostToolUse(viewIn(item)), undefined);
      strictEqual(runner.calls.length, 0);
      ok(logs.some(({ record }) => record.level === "warn" && String(record.message).includes("ignoring") && String(record.message).includes("thresholdLines")));
    });
  });
});
