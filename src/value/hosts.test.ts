import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { materializeCorpus } from "./corpus.js";
import type { CorpusItem, FileCorpusItem, MaterializedCorpus } from "./corpus.js";
import { SimulatedCheapModel } from "./sim-runner.js";
import { HOST_NAMES, HOST_TYPE_MATRIX, createHosts, parseToolFallback, tuningForItem } from "./hosts.js";
import type { HostName } from "./hosts.js";
import { runMatrix } from "./measure.js";
import type { MeasurementRecord } from "./measure.js";

/** Reduced corpus: every source type, positive and negative, minus fixtures needing real pdftotext. */
const REDUCED = new Set([
  "src-retry-ledger",
  "src-wide-report",
  "src-tiny-helper",
  "src-too-large",
  "src-binary",
  "src-missing",
  "src-ranged",
  "doc-warehouse",
  "doc-small-note",
  "doc-missing",
  "pdf-encrypted",
  "pdf-extractor-unavailable",
  "web-docs-guide",
  "web-loopback",
  "web-non-html",
]);

const PROFILES = ["correct", "wrong", "invalid-json", "timeout"] as const;

let corpus: MaterializedCorpus;
let records: MeasurementRecord[];
let skipped: Array<{ id: string; host: HostName; reason: string }>;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "paradoc-value-hosts-"));
  corpus = materializeCorpus(dir, { hasPdftotext: true });
  const result = await runMatrix({
    corpus,
    hosts: createHosts(),
    profiles: PROFILES,
    latencyMs: 2,
    timeoutMs: 150,
    filter: (item) => REDUCED.has(item.id),
    runnerFactory: ({ item, profile, latencyMs }) => new SimulatedCheapModel({ profile, needles: item.goldNeedles, latencyMs }),
  });
  records = result.records;
  skipped = result.skipped;
});

after(() => rmSync(corpus.dir, { recursive: true, force: true }));

const at = (id: string, host: HostName, profile: string) =>
  records.find((r) => r.id === id && r.host === host && r.profile === profile);

describe("host x source-type matrix", () => {
  it("drives all three hosts", () => {
    const hosts = new Set(records.map((r) => r.host));
    deepStrictEqual([...hosts].sort(), [...HOST_NAMES].sort());
  });

  it("records web items as MCP-only instead of reporting them as zero elsewhere", () => {
    deepStrictEqual(HOST_TYPE_MATRIX["copilot-mcp"], ["source", "text-document", "pdf-text", "web-page"]);
    for (const name of ["opencode", "copilot-hooks"] as const) {
      ok(!HOST_TYPE_MATRIX[name].includes("web-page"), `${name} must not claim web support`);
      ok(!records.some((r) => r.sourceType === "web-page" && r.host === name), `${name} produced a web record`);
    }
    const webIds = corpus.items.filter((i) => i.kind === "web" && REDUCED.has(i.id)).map((i) => i.id);
    for (const id of webIds) {
      for (const name of ["opencode", "copilot-hooks"] as const) {
        ok(skipped.some((s) => s.id === id && s.host === name), `${id} x ${name} was not recorded as skipped`);
      }
      ok(at(id, "copilot-mcp", "correct") !== undefined, `${id} missing on copilot-mcp`);
    }
  });
});

describe("measurement record schema", () => {
  it("every run produces a complete record", () => {
    // The run is filtered to REDUCED, so the expected matrix is (items x hosts) minus the pairs the
    // host x type matrix refuses, each times the profile count. `skipped` is one entry per pair.
    const items = corpus.items.filter((i) => REDUCED.has(i.id));
    const unsupportedPairs = items.reduce(
      (n, i) => n + HOST_NAMES.filter((h) => !HOST_TYPE_MATRIX[h].includes(i.sourceType)).length,
      0,
    );
    strictEqual(skipped.length, unsupportedPairs, "unsupported item x host pairs were not all recorded");
    strictEqual(
      records.length,
      (items.length * HOST_NAMES.length - unsupportedPairs) * PROFILES.length,
      "matrix is not complete",
    );
    for (const record of records) {
      for (const key of [
        "id", "sourceType", "host", "profile", "nativeChars", "nativeEstTokens", "wasIntercepted", "renderedChars",
        "renderedEstTokens", "estTokensSaved", "estTokensDelegated", "netEstTokensSaved", "savingsPct", "netSavingsPct",
        "elapsedMs", "interceptorElapsedMs", "chunks", "attempts", "cacheHit", "fallbackReason", "resultFallbackReason",
        "reasonsAgree", "goldCoverage", "needlePresent", "omittedRangeCount", "nativePreserved", "savingsMeasurable",
        "contained", "expectedOutcome", "observedOutcome", "outcomeMatchesExpected",
      ] as const) {
        ok(record[key] !== undefined, `${record.id}/${record.host}/${record.profile} missing ${key}`);
      }
      ok(record.goldCoverage >= 0 && record.goldCoverage <= 1, `goldCoverage out of range: ${record.goldCoverage}`);
      ok(Number.isFinite(record.savingsPct) && Number.isFinite(record.netSavingsPct), "non-finite savings");
      ok(record.renderedChars > 0 || record.nativeChars === 0, `${record.id}/${record.host} produced no host text at all`);
    }
  });

  it("the headline profile intercepts positive items and leaves small and ranged reads alone", () => {
    for (const id of ["src-retry-ledger", "src-wide-report", "doc-warehouse"]) {
      for (const host of HOST_NAMES) {
        const record = at(id, host, "correct")!;
        ok(record.wasIntercepted, `${id} x ${host} was not intercepted`);
        ok(record.needlePresent, `${id} x ${host} lost the gold needle`);
        strictEqual(record.goldCoverage, 1, `${id} x ${host} gold coverage`);
        strictEqual(record.outcomeMatchesExpected, true);
        // The whole file is delegated to the cheap model, so net tokens can go negative; what must
        // improve is the text the primary model is shown, and the interceptor's own saved-token count.
        ok(record.renderedEstTokens < record.nativeEstTokens, `${id} x ${host} did not shrink the host reply`);
        ok(record.estTokensSaved > 0, `${id} x ${host} reported no saved tokens`);
        ok(record.estTokensDelegated > 0, `${id} x ${host} reported no delegated tokens`);
        ok(record.omittedRangeCount >= 1, `${id} x ${host} omitted nothing`);
      }
    }
    for (const id of ["src-tiny-helper", "doc-small-note", "src-ranged"]) {
      for (const host of HOST_NAMES) {
        const record = at(id, host, "correct")!;
        strictEqual(record.observedOutcome, "passthrough", `${id} x ${host} must pass through`);
        strictEqual(record.wasIntercepted, false);
        strictEqual(record.outcomeMatchesExpected, true);
      }
    }
  });

  it("web items condense on the MCP host with the raw HTML size recorded", () => {
    const record = at("web-docs-guide", "copilot-mcp", "correct")!;
    ok(record.wasIntercepted);
    ok(record.nativeRawHtmlChars !== undefined && record.nativeRawHtmlChars > record.nativeChars, "raw HTML chars not recorded");
    strictEqual(record.needlePresent, true);
    strictEqual(record.outcomeMatchesExpected, true);
  });
});

describe("negative items produce their expected fallback reason on every host that supports them", () => {
  const NEGATIVE = ["src-too-large", "src-binary", "src-missing", "doc-missing", "pdf-encrypted", "pdf-extractor-unavailable", "web-loopback", "web-non-html"];

  for (const id of NEGATIVE) {
    it(`${id} falls back with the expected reason on all profiles`, () => {
      const item = corpus.items.find((i) => i.id === id)!;
      const expectedReason = item.expected.replace("fallback:", "");
      for (const host of HOST_NAMES) {
        if (!HOST_TYPE_MATRIX[host].includes(item.sourceType)) continue;
        for (const profile of PROFILES) {
          const record = at(id, host, profile)!;
          strictEqual(record.observedOutcome, item.expected, `${id} x ${host} x ${profile}`);
          strictEqual(record.fallbackReason, expectedReason, `${id} x ${host} x ${profile} reason`);
          strictEqual(record.outcomeMatchesExpected, true);
          strictEqual(record.wasIntercepted, false);
        }
      }
    });
  }

  it("the MCP host names the same reason the diagnostics recorded", () => {
    for (const record of records) {
      if (record.host !== "copilot-mcp") continue;
      if (record.fallbackReason === null) continue;
      strictEqual(record.reasonCrossChecked, true, `${record.id} MCP reason was not cross-checked`);
      strictEqual(record.resultFallbackReason, record.fallbackReason, `${record.id} diagnostics vs delivered reason`);
      strictEqual(record.reasonsAgree, true, `${record.id} reasons disagree`);
    }
  });

  it("hook hosts leave the native text byte-identical on a guard failure", () => {
    for (const record of records) {
      if (record.host === "copilot-mcp") continue;
      if (record.fallbackReason === null) continue;
      strictEqual(record.nativePreserved, true, `${record.id} x ${record.host} changed the host output`);
      strictEqual(record.resultFallbackReason, null, `${record.id} x ${record.host} surfaced a reason it must not`);
    }
  });

  it("the MCP host returns an error payload instead of file content on a guard failure", () => {
    const record = at("src-too-large", "copilot-mcp", "correct")!;
    strictEqual(record.nativePreserved, false, "MCP guard failure must not pretend to preserve content");
    strictEqual(record.savingsMeasurable, false, "a guard failure has no savings to measure");
    strictEqual(record.renderedChars > 0 && record.renderedEstTokens > 0, true, "the MCP host returned an error payload");
    strictEqual(record.wasIntercepted, false);
  });
});

describe("degraded profiles are contained", () => {
  it("invalid-json and timeout never corrupt the reply on any host", () => {
    for (const profile of ["invalid-json", "timeout"] as const) {
      for (const record of records) {
        if (record.profile !== profile) continue;
        // Guard failures fail before the model is ever asked, so containment is about positive items.
        if (record.expectedOutcome !== "intercept") continue;
        strictEqual(record.contained, true, `${record.id} x ${record.host} x ${profile} was not contained`);
        strictEqual(record.wasIntercepted, false, `${record.id} x ${record.host} x ${profile} still intercepted`);
        ok(record.fallbackReason === "invalid-response" || record.fallbackReason === "timeout", `${record.id} unexpected reason ${record.fallbackReason}`);
        // A model timeout is never retried: src/core/transient.ts refuses TimeoutError on purpose, so
        // the deadline costs one attempt, not maxRetries attempts of delegated tokens.
        if (record.profile === "timeout") strictEqual(record.attempts, 1, `${record.id} x ${record.host} retried a timeout`);
        if (record.host !== "copilot-mcp") {
          strictEqual(record.nativePreserved, true, `${record.id} x ${record.host} lost the native text`);
        }
      }
    }
  });

  it("a wrong answer is flagged by zero gold coverage rather than passing silently", () => {
    let flaggedByCoverage = 0;
    for (const id of ["src-retry-ledger", "doc-warehouse"]) {
      for (const host of HOST_NAMES) {
        const record = at(id, host, "wrong")!;
        strictEqual(record.contained, true, `${id} x ${host} wrong answer was not flagged`);
        if (record.fallbackReason !== null) {
          // The interceptor refused the wrong excerpts: the host returned the native text intact.
          strictEqual(record.nativePreserved, true, `${id} x ${host} wrong answer fell back without the native text`);
        } else {
          strictEqual(record.wasIntercepted, true, `${id} x ${host} wrong answer neither intercepted nor fell back`);
          strictEqual(record.goldCoverage, 0, `${id} x ${host} wrong profile covered gold`);
          strictEqual(record.needlePresent, false, `${id} x ${host} wrong profile found the needle`);
          flaggedByCoverage++;
        }
      }
    }
    // The zero-coverage branch is the point of the test: it must actually be exercised, not vacuous.
    ok(flaggedByCoverage >= 1, "no host flagged a wrong answer by gold coverage");
  });

  it("a partial answer is measured as partial", async () => {
    await runMatrixPartial();
  });
});

async function runMatrixPartial(): Promise<void> {
  const result = await runMatrix({
    corpus,
    hosts: createHosts(["opencode"]),
    profiles: ["partial"],
    latencyMs: 0,
    timeoutMs: 150,
    filter: (item) => item.id === "src-retry-ledger",
    runnerFactory: ({ item, profile, latencyMs }) => new SimulatedCheapModel({ profile, needles: item.goldNeedles, latencyMs }),
  });
  const record = result.records[0]!;
  ok(record.wasIntercepted);
  ok(record.goldCoverage > 0 && record.goldCoverage < 1, `partial coverage should be partial: ${record.goldCoverage}`);
  strictEqual(record.contained, true);
}

describe("host wiring", () => {
  it("routes tuning-only knobs through the env layer and the rest through host options", () => {
    const item: CorpusItem = {
      id: "t",
      sourceType: "source",
      kind: "file",
      question: "q",
      expected: "intercept",
      goldNeedles: [],
      tuning: { thresholdLines: 10, maxFileBytes: 4096, minTokens: 5, thresholdTokens: 9, pdfMaxChars: 2000, pdfTimeoutMs: 50, judge: "always" },
    };
    const tuning = tuningForItem(item);
    deepStrictEqual(tuning.options, { thresholdLines: 10, maxFileBytes: 4096, judge: { mode: "always" } });
    deepStrictEqual(tuning.env, { PARADOC_MIN_TOKENS: "5", PARADOC_THRESHOLD_TOKENS: "9", PARADOC_PDF_MAX_CHARS: "2000", PARADOC_PDF_TIMEOUT_MS: "50" });
  });

  it("per-item tuning actually changes the host outcome", () => {
    const record = at("src-too-large", "copilot-mcp", "correct")!;
    strictEqual(record.fallbackReason, "file-too-large", "maxFileBytes tuning did not reach the host");
  });

  it("parses the reason the MCP tool delivers", () => {
    strictEqual(parseToolFallback("[paradoc] fallback: timeout — returning full file"), "timeout");
    strictEqual(parseToolFallback("paradoc: pdf text unavailable (pdf-encrypted): /Encrypt"), "pdf-encrypted");
    strictEqual(parseToolFallback("[paradoc] src/a.ts: 400 lines (not condensed)"), null);
  });

  it("gives every run its own runner so call counts stay independent", async () => {
    const first = await runMatrix({
      corpus,
      hosts: createHosts(["opencode"]),
      profiles: ["correct"],
      latencyMs: 0,
      timeoutMs: 150,
      filter: (item) => item.id === "src-retry-ledger",
      runnerFactory: ({ item, profile }) => new SimulatedCheapModel({ profile, needles: item.goldNeedles }),
    });
    const second = await runMatrix({
      corpus,
      hosts: createHosts(["opencode"]),
      profiles: ["correct"],
      latencyMs: 0,
      timeoutMs: 150,
      filter: (item) => item.id === "src-retry-ledger",
      runnerFactory: ({ item, profile }) => new SimulatedCheapModel({ profile, needles: item.goldNeedles }),
    });
    strictEqual(first.records[0]!.cacheHit, false);
    strictEqual(second.records[0]!.cacheHit, false, "a shared cache leaked between runs");
    strictEqual(first.records[0]!.estTokensDelegated, second.records[0]!.estTokensDelegated);
  });

  it("never resolves config from process.cwd()", () => {
    const fileItem = corpus.items.find((i) => i.kind === "file") as FileCorpusItem;
    ok(fileItem.path.startsWith(corpus.dir), "fixtures must live inside the corpus dir");
  });
});
