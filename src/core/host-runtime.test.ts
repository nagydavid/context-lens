import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FakeSubagentRunner } from "./fake-runner.js";
import {
  createDiagnostics,
  createHostRuntime,
  describeEvent,
  displayPathFor,
  errorMessage,
  explicitFromOptions,
  isRecord,
  validLine,
} from "./host-runtime.js";
import type { DiagnosticRecord } from "./host-runtime.js";
import type { InterceptionEvent } from "./interceptor.js";
import { DEFAULT_TUNING } from "./tuning.js";

let tmp: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "paradoc-host-runtime-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("shared helpers", () => {
  it("isRecord accepts plain objects only", () => {
    assert.equal(isRecord({}), true);
    assert.equal(isRecord({ a: 1 }), true);
    assert.equal(isRecord([]), false);
    assert.equal(isRecord(null), false);
    assert.equal(isRecord("x"), false);
  });

  it("errorMessage extracts Error messages and stringifies the rest", () => {
    assert.equal(errorMessage(new Error("boom")), "boom");
    assert.equal(errorMessage("plain"), "plain");
    assert.equal(errorMessage(42), "42");
  });

  it("validLine accepts integers >= 1 only", () => {
    assert.equal(validLine(1), true);
    assert.equal(validLine(12), true);
    assert.equal(validLine(0), false);
    assert.equal(validLine(-3), false);
    assert.equal(validLine(1.5), false);
    assert.equal(validLine("2"), false);
    assert.equal(validLine(undefined), false);
  });

  it("explicitFromOptions maps only defined keys", () => {
    assert.deepStrictEqual(explicitFromOptions({}), {});
    assert.deepStrictEqual(
      explicitFromOptions({ thresholdLines: 10, timeoutMs: undefined, judge: undefined }),
      { thresholdLines: 10 },
    );
    assert.deepStrictEqual(
      explicitFromOptions({
        thresholdLines: 1,
        timeoutMs: 2,
        concurrency: 3,
        chunkLines: 4,
        chunkOverlapLines: 5,
        judge: { mode: "always" },
      }),
      { thresholdLines: 1, timeoutMs: 2, concurrency: 3, chunkLines: 4, chunkOverlapLines: 5, judge: "always" },
    );
    // judge without a mode contributes nothing.
    assert.deepStrictEqual(explicitFromOptions({ judge: {} as never }), {});
  });

  it("describeEvent renders intercepted, fallback and passthrough events", () => {
    const intercepted: InterceptionEvent = {
      filePath: "a/big.ts", lineCount: 400, intercepted: true,
      elapsedMs: 12.4, confidence: 4, chunks: 2, cacheHit: true,
      judge: { verdict: "sufficient", elapsedMs: 5 },
    };
    assert.equal(
      describeEvent(intercepted),
      "intercepted a/big.ts (400 lines, confidence 4, chunks=2, cacheHit=true, judge=sufficient, 12ms)",
    );
    const fallback: InterceptionEvent = {
      filePath: "a/big.ts", lineCount: 400, intercepted: false,
      fallbackReason: "subagent-error", detail: "boom",
    };
    assert.equal(describeEvent(fallback), "fallback subagent-error for a/big.ts: boom");
    const passthrough: InterceptionEvent = { filePath: "a/small.ts", lineCount: 3, intercepted: false };
    assert.equal(describeEvent(passthrough), "passthrough a/small.ts (3 lines)");
    const judgeError: InterceptionEvent = {
      filePath: "a/big.ts", lineCount: 400, intercepted: true, elapsedMs: 1,
      judge: { verdict: undefined, error: "judge parse failed", elapsedMs: 2 },
    };
    assert.equal(
      describeEvent(judgeError),
      "intercepted a/big.ts (400 lines, confidence ?, judge=error, 1ms) judge error: judge parse failed",
    );
  });

  it("displayPathFor relativizes paths inside the root and keeps others", () => {
    assert.equal(displayPathFor("/root/src/a.ts", "/root"), "src/a.ts");
    assert.equal(displayPathFor("src/a.ts", "/root"), "src/a.ts");
    assert.equal(displayPathFor("/root", "/root"), "/root");
    assert.equal(displayPathFor("../outside.ts", "/root"), "../outside.ts");
    assert.equal(displayPathFor("/other/abs.ts", "/root"), "/other/abs.ts");
  });
});

describe("createDiagnostics", () => {
  it("delivers the text line and the { ts, level, message, ...extra } record to the sink", () => {
    const delivered: Array<{ line: string; record: DiagnosticRecord }> = [];
    const { log } = createDiagnostics({ sink: (line, record) => delivered.push({ line, record }) });
    log("warn", "something happened", { code: 7, note: "x" });
    assert.equal(delivered.length, 1);
    const { line, record } = delivered[0];
    assert.equal(line, '[paradoc] warn: something happened {"code":7,"note":"x"}');
    assert.equal(record.level, "warn");
    assert.equal(record.message, "something happened");
    assert.equal(record.code, 7);
    assert.equal(record.note, "x");
    assert.ok(typeof record.ts === "string" && !Number.isNaN(Date.parse(record.ts)));
    // ts is the first key so JSONL records lead with it.
    assert.equal(Object.keys(record)[0], "ts");
  });

  it("omits the extra JSON object when no extra is given", () => {
    const delivered: Array<{ line: string }> = [];
    const { log } = createDiagnostics({ sink: (line) => delivered.push({ line }) });
    log("info", "plain");
    assert.equal(delivered[0].line, "[paradoc] info: plain {}");
  });

  it("swallows sink failures", () => {
    const { log } = createDiagnostics({
      sink: () => {
        throw new Error("sink exploded");
      },
    });
    assert.doesNotThrow(() => log("error", "still fine"));
  });

  it("falls back to stderr when no sink is provided", () => {
    const lines: string[] = [];
    const { log } = createDiagnostics({ stderr: (line) => lines.push(line) });
    log("debug", "to stderr", { k: 1 });
    assert.deepEqual(lines, ['[paradoc] debug: to stderr {"k":1}']);
  });

  it("appends JSONL records to logFile best-effort and swallows write failures", async () => {
    const logFile = join(tmp, "diagnostics.jsonl");
    const { log } = createDiagnostics({ logFile, stderr: () => {} });
    log("info", "first", { a: 1 });
    log("warn", "second");
    const records = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.length, 2);
    assert.equal(records[0].level, "info");
    assert.equal(records[0].a, 1);
    assert.ok(typeof records[0].ts === "string");
    assert.equal(records[1].message, "second");

    const broken = createDiagnostics({ logFile: join(tmp, "missing-dir", "x.jsonl"), stderr: () => {} });
    assert.doesNotThrow(() => broken.log("info", "unpersistable"));
    await tick();
  });
});

describe("createHostRuntime", () => {
  const quietLog = (): Array<{ level: string; message: string; extra?: Record<string, unknown> }> => {
    const logs: Array<{ level: string; message: string; extra?: Record<string, unknown> }> = [];
    return logs;
  };

  function runtimeFor(overrides: Partial<Parameters<typeof createHostRuntime>[0]> = {}) {
    const logs = quietLog();
    const runtime = createHostRuntime({
      projectRoot: tmp,
      configOptions: { homeDir: tmp, env: {} },
      log: (level, message, extra) => logs.push({ level, message, ...(extra ? { extra } : {}) }),
      runner: new FakeSubagentRunner({ structured: { excerpts: [{ startLine: 1, endLine: 2 }], summary: "s", confidence: 3 } }),
      ...overrides,
    });
    return { runtime, logs };
  }

  it("builds an LRU cache when cacheMaxEntries > 0 and disables it at 0", () => {
    const enabled = runtimeFor();
    assert.ok(enabled.runtime.cache, "default tuning should build a cache");

    const zero = runtimeFor({ configOptions: { homeDir: tmp, env: { PARADOC_CACHE: "0" } } });
    assert.equal(zero.runtime.cache, undefined);

    const supplied = { get: () => undefined, set: () => undefined };
    const passed = runtimeFor({ cache: supplied, configOptions: { homeDir: tmp, env: { PARADOC_CACHE: "0" } } });
    assert.equal(passed.runtime.cache, supplied, "a supplied cache is used even when tuning disables the built one");
  });

  it("resolves precedence explicit > env and reports provenance in sources", () => {
    const { runtime } = runtimeFor({
      configOptions: { homeDir: tmp, env: { PARADOC_THRESHOLD: "300" } },
      explicit: { thresholdLines: 500 },
    });
    assert.equal(runtime.settings.thresholdLines, 500);
    assert.equal(runtime.sources.thresholdLines, "explicit");
    assert.equal(runtime.settings.timeoutMs, DEFAULT_TUNING.timeoutMs);
    assert.equal(runtime.sources.timeoutMs, "default");
  });

  it("warns through log when an env value is invalid and keeps the default", () => {
    const { runtime, logs } = runtimeFor({
      configOptions: { homeDir: tmp, env: { PARADOC_THRESHOLD: "lots" } },
    });
    assert.equal(runtime.settings.thresholdLines, DEFAULT_TUNING.thresholdLines);
    assert.equal(runtime.sources.thresholdLines, "default");
    assert.ok(
      logs.some((entry) => entry.level === "warn" && entry.message.includes("PARADOC_THRESHOLD")),
      JSON.stringify(logs),
    );
  });

  it("resolves tuning per root: project config applies only to its own root", () => {
    const tunedRoot = mkdtempSync(join(tmp, "tuned-root-"));
    try {
      mkdirSync(join(tunedRoot, ".paradoc"), { recursive: true });
      writeFileSync(join(tunedRoot, ".paradoc", "config.json"), JSON.stringify({ version: 1, tuning: { thresholdLines: 300 } }));
      const { runtime } = runtimeFor();
      assert.equal(runtime.tuningFor(tunedRoot).thresholdLines, 300);
      assert.equal(runtime.tuningFor(tmp).thresholdLines, DEFAULT_TUNING.thresholdLines);
      assert.equal(runtime.tuningFor(tunedRoot), runtime.tuningFor(tunedRoot), "per-root tuning is cached");
    } finally {
      rmSync(tunedRoot, { recursive: true, force: true });
    }
  });

  it("interceptorFor returns the same instance per root and different ones per root", () => {
    const { runtime } = runtimeFor();
    const rootA = join(tmp, "root-a");
    const rootB = join(tmp, "root-b");
    const a1 = runtime.interceptorFor(rootA);
    const a2 = runtime.interceptorFor(rootA);
    const b1 = runtime.interceptorFor(rootB);
    assert.equal(a1, a2);
    assert.notEqual(a1, b1);
    assert.equal(runtime.modelSelectorFor(rootA), runtime.modelSelectorFor(rootA));
    assert.notEqual(runtime.modelSelectorFor(rootA), runtime.modelSelectorFor(rootB));
  });

  it("builds the runner lazily through the factory and reuses it", () => {
    let built = 0;
    const { runtime } = runtimeFor({
      runner: undefined,
    });
    // runtimeFor always supplies an instance; rebuild with a factory instead.
    const logs = quietLog();
    const lazy = createHostRuntime({
      projectRoot: tmp,
      configOptions: { homeDir: tmp, env: {} },
      log: (level, message) => logs.push({ level, message }),
      runner: (settings) => {
        built += 1;
        assert.equal(settings.concurrency, DEFAULT_TUNING.concurrency);
        return new FakeSubagentRunner({ structured: { excerpts: [{ startLine: 1, endLine: 2 }], summary: "s", confidence: 3 } });
      },
    });
    assert.equal(built, 0, "startup must not build the runner");
    const interceptor = lazy.interceptorFor(tmp);
    assert.equal(built, 1);
    assert.equal(lazy.interceptorFor(tmp), interceptor);
    assert.equal(built, 1, "the factory runs at most once");
  });

  it("logs interception events with stats riding along", async () => {
    const file = join(tmp, "big.ts");
    writeFileSync(file, Array.from({ length: 400 }, (_, i) => `const line_${i + 1} = ${i + 1};`).join("\n"));
    const { runtime, logs } = runtimeFor();
    const interceptor = runtime.interceptorFor(tmp);
    const result = await interceptor.intercept({
      filePath: file,
      projectRoot: tmp,
      question: "which line?",
      agentContext: {},
    });
    await tick();
    assert.ok(result.wasIntercepted);
    const event = logs.find((entry) => entry.level === "info" && entry.extra?.intercepted === true);
    assert.ok(event, JSON.stringify(logs));
    assert.ok(event.extra && "stats" in event.extra, "logger payload must include stats");
    const stats = (event.extra as { stats: Record<string, unknown> }).stats;
    assert.equal(stats.intercepted, 1);
    assert.ok(String(event.message).startsWith(`intercepted ${file} (`));
  });
});
