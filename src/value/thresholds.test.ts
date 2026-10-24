import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FAILURE_PROFILE_REASONS,
  GLOBAL_THRESHOLDS,
  HEADLINE_PROFILE,
  INTERCEPTION_STAGE_REASONS,
  SOURCE_THRESHOLDS,
  evaluateThresholds,
  isPositiveRecord,
  positiveNetSavingsByType,
} from "./thresholds.js";
import type { MeasurementRecord } from "./measure.js";
import type { SourceType } from "./corpus.js";

/** A passing record: every threshold rule is satisfied by this shape. */
function record(overrides: Partial<MeasurementRecord> = {}): MeasurementRecord {
  return {
    id: "src-item",
    sourceType: "source",
    host: "opencode",
    profile: HEADLINE_PROFILE,
    nativeChars: 4000,
    nativeEstTokens: 1000,
    wasIntercepted: true,
    renderedChars: 400,
    renderedEstTokens: 100,
    estTokensSaved: 900,
    estTokensDelegated: 1000,
    netEstTokensSaved: -100,
    savingsPct: 90,
    netSavingsPct: -10,
    elapsedMs: 30,
    interceptorElapsedMs: 25,
    chunks: 1,
    attempts: 1,
    cacheHit: false,
    fallbackReason: null,
    resultFallbackReason: null,
    reasonCrossChecked: false,
    reasonsAgree: true,
    goldCoverage: 1,
    needlePresent: true,
    omittedRangeCount: 1,
    nativePreserved: false,
    savingsMeasurable: true,
    contained: true,
    expectedOutcome: "intercept",
    observedOutcome: "intercept",
    outcomeMatchesExpected: true,
    ...overrides,
  };
}

/** One passing record per source type so the per-type loop has something to check. */
function passingSet(): MeasurementRecord[] {
  const types: SourceType[] = ["source", "text-document", "pdf-text", "web-page"];
  return types.flatMap((sourceType) => [
    record({ id: `${sourceType}-pos`, sourceType }),
    record({
      id: `${sourceType}-neg`,
      sourceType,
      host: "copilot-mcp",
      wasIntercepted: false,
      savingsMeasurable: false,
      savingsPct: 0,
      netSavingsPct: 0,
      estTokensSaved: 0,
      estTokensDelegated: 0,
      netEstTokensSaved: 0,
      renderedEstTokens: 1000,
      goldCoverage: 1,
      fallbackReason: sourceType === "web-page" ? "unsafe-url" : "file-not-found",
      expectedOutcome: sourceType === "web-page" ? "fallback:unsafe-url" : "fallback:file-not-found",
      observedOutcome: sourceType === "web-page" ? "fallback:unsafe-url" : "fallback:file-not-found",
    }),
  ]);
}

const names = (violations: Array<{ name: string }>) => violations.map((v) => v.name);

describe("threshold definitions", () => {
  it("names a threshold set for every corpus source type", () => {
    for (const type of ["source", "text-document", "pdf-text", "web-page"] as const) {
      const t = SOURCE_THRESHOLDS[type];
      strictEqual(t.sourceType, type);
      ok(t.minSavingsPct > 0, `${type} savings floor must be positive`);
      ok(t.maxFallbackRate > 0 && t.maxFallbackRate < 1, `${type} fallback ceiling out of range`);
      ok(t.maxAddedLatencyMs > 0, `${type} latency ceiling must be positive`);
      ok(t.minGoldCoverage > 0 && t.minGoldCoverage <= 1, `${type} gold floor out of range`);
    }
  });

  it("splits fallback reasons into interception-stage and guard-stage", () => {
    ok(INTERCEPTION_STAGE_REASONS.has("timeout"));
    ok(INTERCEPTION_STAGE_REASONS.has("judge-rejected"));
    ok(!INTERCEPTION_STAGE_REASONS.has("file-too-large"), "a guard-stage reason must not demand native text");
    ok(!INTERCEPTION_STAGE_REASONS.has("unsafe-url"));
  });
});

describe("evaluateThresholds", () => {
  it("a healthy run passes with no violations", () => {
    const records = passingSet();
    const report = evaluateThresholds([], records, { simulatedLatencyMs: 20 });
    strictEqual(report.ok, true, JSON.stringify(report.violations));
    strictEqual(report.violations.length, 0);
  });

  it("flags the named net-savings floor when savings collapse", () => {
    const records = passingSet().map((r) => (isPositiveRecord(r) ? record({ ...r, netSavingsPct: -80 }) : r));
    const report = evaluateThresholds([], records, { simulatedLatencyMs: 20 });
    strictEqual(report.ok, false);
    for (const type of ["source", "text-document", "pdf-text", "web-page"]) {
      ok(names(report.violations).includes(`${type}.minNetSavingsPct`), `missing ${type}.minNetSavingsPct`);
    }
  });

  it("flags the main-model savings floor", () => {
    const records = passingSet().map((r) => (isPositiveRecord(r) ? record({ ...r, savingsPct: 12 }) : r));
    const report = evaluateThresholds([], records, { simulatedLatencyMs: 20 });
    ok(names(report.violations).includes("source.minSavingsPct"));
  });

  it("flags gold coverage below the floor", () => {
    const records = passingSet().map((r) => (isPositiveRecord(r) && r.sourceType === "source" ? record({ ...r, goldCoverage: 0.4 }) : r));
    const report = evaluateThresholds([], records, { simulatedLatencyMs: 20 });
    ok(names(report.violations).includes("source.minGoldCoverage"));
    strictEqual(report.violations.find((v) => v.name === "source.minGoldCoverage")?.measured, 0.4);
  });

  it("flags a fallback spike on positive items and names the reasons from the aggregate row", () => {
    const records = passingSet().map((r) =>
      isPositiveRecord(r) && r.sourceType === "source"
        ? record({ ...r, wasIntercepted: false, fallbackReason: "no-valid-excerpts", nativePreserved: true, expectedOutcome: "intercept", observedOutcome: "fallback:no-valid-excerpts", outcomeMatchesExpected: false })
        : r,
    );
    const aggregates = [{ sourceType: "source" as SourceType, host: "opencode" as const, n: 2, measurableN: 1, latencyMeanMs: 1, latencyP50Ms: 1, latencyP95Ms: 1, savingsPctMean: 90, netSavingsPctMean: -10, interceptionRate: 0.5, fallbackRate: 0.5, goldCoverageMean: 1, judgeSufficientRate: null, judgedCount: 0, fallbackReasons: { "no-valid-excerpts": 1 } }];
    const report = evaluateThresholds(aggregates, records, { simulatedLatencyMs: 20 });
    const violation = report.violations.find((v) => v.name === "source.maxFallbackRate");
    ok(violation, `violations: ${names(report.violations).join(", ")}`);
    ok(violation!.detail.includes("no-valid-excerpts"), violation!.detail);
  });

  it("flags added latency above the ceiling but not the simulated model latency itself", () => {
    const records = passingSet().map((r) => (isPositiveRecord(r) && r.sourceType === "web-page" ? record({ ...r, elapsedMs: 4020 }) : r));
    const report = evaluateThresholds([], records, { simulatedLatencyMs: 20 });
    ok(names(report.violations).includes("web-page.maxAddedLatencyMs"), names(report.violations).join(", "));
    // The same wall clock with a 4 s simulated model is not ParaDoc's fault.
    const slowModel = evaluateThresholds([], passingSet().map((r) => (isPositiveRecord(r) ? record({ ...r, elapsedMs: 4020 }) : r)), { simulatedLatencyMs: 4000 });
    strictEqual(slowModel.ok, true, JSON.stringify(slowModel.violations));
  });

  it("names a source type that produced no positive records instead of passing silently", () => {
    const records = passingSet().filter((r) => !(isPositiveRecord(r) && r.sourceType === "pdf-text"));
    const report = evaluateThresholds([], records, { simulatedLatencyMs: 20 });
    ok(names(report.violations).includes("pdf-text.noPositiveRecords"));
    // The same gap is excused when the corpus itself skipped the type.
    const excused = evaluateThresholds([], records, { simulatedLatencyMs: 20, skipSourceTypes: ["pdf-text"] });
    strictEqual(excused.ok, true, JSON.stringify(excused.violations));
  });

  it("keeps the headline no-positive-records guard and points failure-only runs to its mode", () => {
    const records = [
      record({ profile: "invalid-json", wasIntercepted: false, fallbackReason: "invalid-response", nativePreserved: true }),
      record({ profile: "timeout", wasIntercepted: false, fallbackReason: "timeout", nativePreserved: true }),
    ];
    const report = evaluateThresholds([], records, { simulatedLatencyMs: 20 });
    const violation = report.violations.find((v) => v.name === "source.noPositiveRecords");
    ok(violation, names(report.violations).join(", "));
    ok(violation.detail.includes("correct"), violation.detail);
    ok(violation.detail.includes("--failure-profiles"), violation.detail);
  });

  it("passes failure-profile mode for native, non-intercepted expected fallbacks", () => {
    strictEqual(FAILURE_PROFILE_REASONS["invalid-json"], "invalid-response");
    strictEqual(FAILURE_PROFILE_REASONS.timeout, "timeout");
    const records = [
      record({ profile: "invalid-json", wasIntercepted: false, fallbackReason: "invalid-response", nativePreserved: true }),
      record({ profile: "timeout", wasIntercepted: false, fallbackReason: "timeout", nativePreserved: true }),
    ];
    const report = evaluateThresholds([], records, { mode: "failure-profile" });
    strictEqual(report.ok, true, JSON.stringify(report.violations));
  });

  it("flags a failure profile with an unexpected fallback reason", () => {
    const report = evaluateThresholds([], [record({ profile: "invalid-json", wasIntercepted: false, fallbackReason: "timeout", nativePreserved: true })], { mode: "failure-profile" });
    ok(names(report.violations).includes("failure-profile.reason"));
  });

  it("flags a failure profile that intercepts or fails to preserve native text", () => {
    const intercepted = evaluateThresholds([], [record({ profile: "timeout", fallbackReason: "timeout", nativePreserved: true })], { mode: "failure-profile" });
    ok(names(intercepted.violations).includes("failure-profile.intercepted"));
    const unpreserved = evaluateThresholds([], [record({ profile: "timeout", wasIntercepted: false, fallbackReason: "timeout", nativePreserved: false })], { mode: "failure-profile" });
    ok(names(unpreserved.violations).includes("failure-profile.native-not-preserved"));
  });

  it("flags an empty failure-profile run once at run scope", () => {
    const report = evaluateThresholds([], [], { mode: "failure-profile" });
    const violation = report.violations.find((v) => v.name === "failure-profile.no-positive-records");
    ok(violation, names(report.violations).join(", "));
    strictEqual(violation.scope, "run");
  });

  it("defaults to the explicit headline mode", () => {
    const records = passingSet();
    const implicit = evaluateThresholds([], records, { simulatedLatencyMs: 20 });
    const explicit = evaluateThresholds([], records, { simulatedLatencyMs: 20, mode: "headline" });
    strictEqual(JSON.stringify(implicit), JSON.stringify(explicit));
  });

  it("flags a negative item whose outcome does not match the corpus expectation", () => {
    const records = passingSet().map((r) =>
      !isPositiveRecord(r) && r.sourceType === "source"
        ? record({ ...r, id: "src-tiny", expectedOutcome: "passthrough", observedOutcome: "intercept", wasIntercepted: true, fallbackReason: null, outcomeMatchesExpected: false })
        : r,
    );
    const report = evaluateThresholds([], records, { simulatedLatencyMs: 20 });
    const violation = report.violations.find((v) => v.name === "negative-outcome");
    ok(violation, names(report.violations).join(", "));
    ok(violation!.scope.includes("src-tiny x"), violation!.scope);
  });

  it("requires native text on interception-stage fallbacks but not on guard-stage ones", () => {
    const guard = passingSet().map((r) => (!isPositiveRecord(r) && r.sourceType === "source" ? record({ ...r, nativePreserved: false }) : r));
    strictEqual(evaluateThresholds([], guard, { simulatedLatencyMs: 20 }).ok, true, "a guard fallback returning an error must not violate the rule");

    const leaked = passingSet().map((r) =>
      !isPositiveRecord(r) && r.sourceType === "source"
        ? record({ ...r, fallbackReason: "timeout", expectedOutcome: "fallback:timeout", observedOutcome: "fallback:timeout", nativePreserved: false })
        : r,
    );
    const report = evaluateThresholds([], leaked, { simulatedLatencyMs: 20 });
    const violation = report.violations.find((v) => v.name === "native-not-preserved");
    ok(violation, names(report.violations).join(", "));
    ok(violation!.detail.includes("timeout"), violation!.detail);
  });

  it("flags the wrong profile when it is intercepted yet claims full gold coverage", () => {
    const records = [...passingSet(), record({ id: "src-item", sourceType: "source", profile: "wrong", goldCoverage: 1 })];
    const report = evaluateThresholds([], records, { simulatedLatencyMs: 20 });
    const violation = report.violations.find((v) => v.name === "wrong-profile-faked-success");
    ok(violation, names(report.violations).join(", "));
    strictEqual(violation!.scope, "src-item x opencode x wrong");
    // The same profile is fine when it missed the gold.
    const honest = [...passingSet(), record({ id: "src-item", sourceType: "source", profile: "wrong", goldCoverage: 0 })];
    strictEqual(evaluateThresholds([], honest, { simulatedLatencyMs: 20 }).ok, true, JSON.stringify(evaluateThresholds([], honest, { simulatedLatencyMs: 20 }).violations));
    // …or when it fell back with the native text intact (the corpus expects an intercept, so the
    // outcome mismatch on a positive item is not itself a threshold violation).
    const fellBack = [...passingSet(), record({ id: "src-item", sourceType: "source", profile: "timeout", wasIntercepted: false, fallbackReason: "timeout", nativePreserved: true, observedOutcome: "fallback:timeout", outcomeMatchesExpected: false })];
    const fellBackReport = evaluateThresholds([], fellBack, { simulatedLatencyMs: 20 });
    strictEqual(names(fellBackReport.violations).includes("wrong-profile-faked-success"), false);
    strictEqual(fellBackReport.ok, true, JSON.stringify(fellBackReport.violations));
  });

  it("does not demand a miss from profiles that only trim the context around the answer", () => {
    // `partial` keeps the needle line and shortens its context, so on needle-only fixtures (PDF, web)
    // it legitimately reports full coverage. Only the profile defined to exclude the gold is checked.
    const partial = [...passingSet(), record({ id: "pdf-item", sourceType: "pdf-text", profile: "partial", goldCoverage: 1 })];
    const report = evaluateThresholds([], partial, { simulatedLatencyMs: 20 });
    strictEqual(report.ok, true, JSON.stringify(report.violations));
    strictEqual(GLOBAL_THRESHOLDS.profilesThatMustMissGold.length, 1);
    strictEqual(GLOBAL_THRESHOLDS.profilesThatMustMissGold[0], "wrong");
  });

  it("flags a host that delivered a different fallback reason than the interceptor logged", () => {
    const records = passingSet().map((r) => (isPositiveRecord(r) && r.sourceType === "source" ? record({ ...r, resultFallbackReason: "timeout", reasonsAgree: false }) : r));
    const report = evaluateThresholds([], records, { simulatedLatencyMs: 20 });
    ok(names(report.violations).includes("reason-mismatch"), names(report.violations).join(", "));
  });

  it("computes positive net savings only over measurable headline records", () => {
    const records = passingSet();
    const byType = positiveNetSavingsByType(records);
    strictEqual(byType.get("source")!.n, 1, "negative records must not dilute the savings mean");
    strictEqual(byType.get("source")!.mean, -10);
  });

  it("reports every violation with a machine name, a scope and a numeric limit", () => {
    const records = passingSet().map((r) => (isPositiveRecord(r) ? record({ ...r, netSavingsPct: -90, goldCoverage: 0.1, savingsPct: 5 }) : r));
    const report = evaluateThresholds([], records, { simulatedLatencyMs: 20 });
    strictEqual(report.ok, false);
    for (const v of report.violations) {
      ok(v.name.includes("."), `violation name not qualified: ${v.name}`);
      ok(v.scope.length > 0, "violation needs a scope naming the offending item/host or source type");
      ok(Number.isFinite(v.measured) && Number.isFinite(v.limit), "violation needs numeric measured/limit");
      ok(v.detail.length > 0, "violation needs a human-readable detail");
    }
    ok(GLOBAL_THRESHOLDS.profilesThatMustMissGold.includes("wrong"));
  });
});
