/**
 * Named value thresholds for the S02 harness, and the check that enforces them.
 *
 * Every limit below was set from a real run of the harness (`npm run value`, simulated model latency
 * 20 ms, interceptor deadline 1000 ms) and then loosened with margin, so the check catches a real
 * regression instead of flaking on ordinary run-to-run noise. The measured figure each limit was
 * derived from is recorded next to it.
 *
 * What the numbers mean (see src/value/measure.ts for the formulas):
 *   savingsPct      — token reduction the *main* model sees: native estimate vs host reply estimate.
 *   netSavingsPct   — the same figure minus the tokens the cheap model was *given*. With the shipped
 *                     default (chunkLines 0) the whole document is delegated once, so net savings is
 *                     negative for a single-chunk document: the main model's context shrinks by ~96%,
 *                     but the cheap model was fed the full document. The net figure is the honest
 *                     accounting, and the thresholds below are floors on it.
 *   addedLatencyMs  — p95 wall clock of intercepted 'correct' runs minus the simulated model latency,
 *                     i.e. what ParaDoc's own work adds on top of the model call.
 *
 * Positive items are the corpus items whose expected outcome is "intercept"; negative items are every
 * other item (passthrough and guard-fallback fixtures).
 */
import type { FallbackReason } from "../core/models.js";
import type { AccuracyProfile } from "./sim-runner.js";
import type { AggregateRow, MeasurementRecord } from "./measure.js";
import type { SourceType } from "./corpus.js";

/** The profile the savings/quality thresholds are measured on. */
export const HEADLINE_PROFILE: AccuracyProfile = "correct";

/** Expected fallback reason for each profile used by failure-profile-only validation. */
export const FAILURE_PROFILE_REASONS: Readonly<Partial<Record<AccuracyProfile, FallbackReason>>> = {
  "invalid-json": "invalid-response",
  timeout: "timeout",
};

/** Simulated model latency the latency limits were derived against (the CLI default). */
export const REFERENCE_SIMULATED_LATENCY_MS = 20;

/**
 * Fallbacks that happen *after* a successful read, where the host must hand back the original text.
 * Guard-stage fallbacks (file-too-large, unsafe-url, …) deliberately return a short error instead of
 * the content, so native preservation is not required for them.
 */
export const INTERCEPTION_STAGE_REASONS: ReadonlySet<FallbackReason> = new Set<FallbackReason>([
  "no-runner",
  "subagent-error",
  "timeout",
  "invalid-response",
  "invalid-confidence",
  "no-valid-excerpts",
  "judge-rejected",
]);

export interface SourceThreshold {
  sourceType: SourceType;
  /** Floor on mean net savings % of positive items under the headline profile. Measured: -14.2. */
  minNetSavingsPct: number;
  /** Floor on mean main-model savings % of positive items under the headline profile. Measured: 96.3. */
  minSavingsPct: number;
  /** Floor on mean gold coverage of positive items under the headline profile. Measured: 1.00. */
  minGoldCoverage: number;
  /** Ceiling on fallback rate over positive items under the headline profile. Measured: 0.00. */
  maxFallbackRate: number;
  /** Ceiling on p95 added latency (ms) of intercepted positive runs. Measured: 3 ms. */
  maxAddedLatencyMs: number;
}

export const SOURCE_THRESHOLDS: Record<SourceType, SourceThreshold> = {
  source: {
    sourceType: "source",
    minNetSavingsPct: -25,
    minSavingsPct: 90,
    minGoldCoverage: 0.95,
    maxFallbackRate: 0.1,
    maxAddedLatencyMs: 250,
  },
  "text-document": {
    sourceType: "text-document",
    minNetSavingsPct: -25,
    minSavingsPct: 90,
    minGoldCoverage: 0.95,
    maxFallbackRate: 0.1,
    maxAddedLatencyMs: 250,
  },
  "pdf-text": {
    sourceType: "pdf-text",
    // PDFs pay an extra pdftotext subprocess call, so the latency floor is looser. Measured: 23 ms.
    minNetSavingsPct: -20,
    minSavingsPct: 90,
    minGoldCoverage: 0.95,
    maxFallbackRate: 0.1,
    maxAddedLatencyMs: 350,
  },
  "web-page": {
    sourceType: "web-page",
    minNetSavingsPct: -20,
    minSavingsPct: 90,
    minGoldCoverage: 0.95,
    maxFallbackRate: 0.1,
    maxAddedLatencyMs: 250,
  },
};

export interface GlobalThresholds {
  /** Every negative item must produce its expected outcome on every host and profile. */
  negativeItemsMustMatch: boolean;
  /** Interception-stage fallbacks must return the item's native text. */
  interceptionFallbacksMustPreserveNative: boolean;
  /** The profile defined to exclude the gold answer must actually miss it when it is intercepted.
   *  Only `wrong` is checked: `partial` shortens the *context* around the answer, and on fixtures whose
   *  gold is a needle rather than a range (PDF, web) the needle line legitimately survives, so full
   *  needle coverage there is not a false success. */
  wrongProfileMustMissGold: boolean;
  /** The reason the host delivered must not contradict the reason the interceptor logged. */
  reasonsMustAgree: boolean;
  /** Profiles that must miss the gold when they are intercepted. */
  profilesThatMustMissGold: readonly AccuracyProfile[];
}

export const GLOBAL_THRESHOLDS: GlobalThresholds = {
  negativeItemsMustMatch: true,
  interceptionFallbacksMustPreserveNative: true,
  wrongProfileMustMissGold: true,
  reasonsMustAgree: true,
  profilesThatMustMissGold: ["wrong"],
};

export interface ThresholdViolation {
  /** Stable machine name, e.g. `source.minNetSavingsPct` or `negative-outcome`. */
  name: string;
  /** Offending item / host / profile when the violation is per-record, otherwise the source type. */
  scope: string;
  measured: number;
  limit: number;
  detail: string;
}

export interface ThresholdReport {
  ok: boolean;
  violations: ThresholdViolation[];
}

export function isPositiveRecord(record: MeasurementRecord): boolean {
  return record.expectedOutcome === "intercept";
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1))];
}

/** Records the savings/quality thresholds apply to: headline profile, positive items only. */
export function headlinePositiveRecords(records: readonly MeasurementRecord[]): MeasurementRecord[] {
  return records.filter((r) => r.profile === HEADLINE_PROFILE && isPositiveRecord(r));
}

/**
 * Mean net savings % of positive headline records, measured the same way the aggregate table measures
 * it: only records whose savings are meaningful (the host returned content for the item).
 */
export function positiveNetSavingsByType(records: readonly MeasurementRecord[]): Map<SourceType, { mean: number; n: number }> {
  const out = new Map<SourceType, { mean: number; n: number }>();
  for (const record of headlinePositiveRecords(records)) {
    if (!record.savingsMeasurable) continue;
    const entry = out.get(record.sourceType) ?? { mean: 0, n: 0 };
    entry.mean += record.netSavingsPct;
    entry.n += 1;
    out.set(record.sourceType, entry);
  }
  for (const [type, entry] of out) out.set(type, { mean: entry.n === 0 ? 0 : entry.mean / entry.n, n: entry.n });
  return out;
}

export interface EvaluateOptions {
  /** Simulated model latency used by this run; subtracted from latency when checking added latency. */
  simulatedLatencyMs?: number;
  /** Source types to skip (e.g. pdf-text when pdftotext is absent and the corpus skipped those items). */
  skipSourceTypes?: readonly SourceType[];
  /** Headline checks measure savings; failure-profile checks validate safe native fallbacks instead. */
  mode?: "headline" | "failure-profile";
}

/**
 * Check a harness run against the named thresholds.
 * `aggregates` is used for the fallback-reason histogram in violation messages; the numeric checks are
 * computed from `records` so they stay independent of how the table was grouped.
 */
export function evaluateThresholds(
  aggregates: readonly AggregateRow[],
  records: readonly MeasurementRecord[],
  options: EvaluateOptions = {},
): ThresholdReport {
  const simulatedLatencyMs = options.simulatedLatencyMs ?? REFERENCE_SIMULATED_LATENCY_MS;
  const skip = new Set<SourceType>(options.skipSourceTypes ?? []);
  const mode = options.mode ?? "headline";
  const violations: ThresholdViolation[] = [];

  // ── per source type, headline profile, positive items ──
  const savings = positiveNetSavingsByType(records);
  if (mode === "headline") for (const [sourceType, threshold] of Object.entries(SOURCE_THRESHOLDS) as Array<[SourceType, SourceThreshold]>) {
    if (skip.has(sourceType)) continue;
    const positive = headlinePositiveRecords(records).filter((r) => r.sourceType === sourceType);
    if (positive.length === 0) {
      violations.push({
        name: `${sourceType}.noPositiveRecords`,
        scope: sourceType,
        measured: 0,
        limit: 1,
        detail: `the headline profile ${HEADLINE_PROFILE} produced no positive ${sourceType} records; use --failure-profiles for failure-only runs`,
      });
      continue;
    }

    const net = savings.get(sourceType);
    if (net && net.mean < threshold.minNetSavingsPct) {
      violations.push({
        name: `${sourceType}.minNetSavingsPct`,
        scope: sourceType,
        measured: Number(net.mean.toFixed(2)),
        limit: threshold.minNetSavingsPct,
        detail: `mean net savings ${net.mean.toFixed(1)}% is below the ${threshold.minNetSavingsPct}% floor (${net.n} positive records)`,
      });
    }

    const measurable = positive.filter((r) => r.savingsMeasurable);
    const sav = mean(measurable.map((r) => r.savingsPct));
    if (sav < threshold.minSavingsPct) {
      violations.push({
        name: `${sourceType}.minSavingsPct`,
        scope: sourceType,
        measured: Number(sav.toFixed(2)),
        limit: threshold.minSavingsPct,
        detail: `mean main-model savings ${sav.toFixed(1)}% is below the ${threshold.minSavingsPct}% floor`,
      });
    }

    const gold = mean(positive.map((r) => r.goldCoverage));
    if (gold < threshold.minGoldCoverage) {
      violations.push({
        name: `${sourceType}.minGoldCoverage`,
        scope: sourceType,
        measured: Number(gold.toFixed(2)),
        limit: threshold.minGoldCoverage,
        detail: `mean gold coverage ${gold.toFixed(2)} is below the ${threshold.minGoldCoverage} floor`,
      });
    }

    const fallbackRate = positive.filter((r) => r.fallbackReason !== null).length / positive.length;
    if (fallbackRate > threshold.maxFallbackRate) {
      const row = aggregates.find((a) => a.sourceType === sourceType);
      const reasons = row ? Object.keys(row.fallbackReasons).join(", ") : "unknown";
      violations.push({
        name: `${sourceType}.maxFallbackRate`,
        scope: sourceType,
        measured: Number(fallbackRate.toFixed(2)),
        limit: threshold.maxFallbackRate,
        detail: `fallback rate ${(fallbackRate * 100).toFixed(0)}% on positive items exceeds ${(threshold.maxFallbackRate * 100).toFixed(0)}% (reasons seen for this type: ${reasons})`,
      });
    }

    const intercepted = positive.filter((r) => r.wasIntercepted);
    const added = p95(intercepted.map((r) => r.elapsedMs - simulatedLatencyMs));
    if (added > threshold.maxAddedLatencyMs) {
      violations.push({
        name: `${sourceType}.maxAddedLatencyMs`,
        scope: sourceType,
        measured: Number(added.toFixed(1)),
        limit: threshold.maxAddedLatencyMs,
        detail: `p95 added latency ${added.toFixed(0)} ms exceeds ${threshold.maxAddedLatencyMs} ms`,
      });
    }
  }

  // ── failure-profile-only positive-item checks ──
  if (mode === "failure-profile") {
    const failureRecords = records.filter((record) => isPositiveRecord(record) && FAILURE_PROFILE_REASONS[record.profile] !== undefined);
    if (failureRecords.length === 0) {
      violations.push({
        name: "failure-profile.no-positive-records",
        scope: "run",
        measured: 0,
        limit: 1,
        detail: "no positive records were produced for the configured failure profiles",
      });
    }
    for (const record of failureRecords) {
      const expectedReason = FAILURE_PROFILE_REASONS[record.profile]!;
      const scope = `${record.id} x ${record.host} x ${record.profile}`;
      if (record.wasIntercepted) {
        violations.push({
          name: "failure-profile.intercepted",
          scope,
          measured: 1,
          limit: 0,
          detail: `failure profile ${record.profile} intercepted instead of falling back with native text`,
        });
      }
      if (record.fallbackReason !== expectedReason) {
        violations.push({
          name: "failure-profile.reason",
          scope,
          measured: 0,
          limit: 1,
          detail: `failure profile ${record.profile} expected fallback reason ${expectedReason}, got ${record.fallbackReason ?? "none"}`,
        });
      }
      if (!record.nativePreserved) {
        violations.push({
          name: "failure-profile.native-not-preserved",
          scope,
          measured: 0,
          limit: 1,
          detail: `failure profile ${record.profile} did not preserve the native text`,
        });
      }
    }
  }

  // ── global rules ──
  if (GLOBAL_THRESHOLDS.negativeItemsMustMatch) {
    for (const record of records) {
      if (isPositiveRecord(record) || record.outcomeMatchesExpected) continue;
      violations.push({
        name: "negative-outcome",
        scope: `${record.id} x ${record.host} x ${record.profile}`,
        measured: 0,
        limit: 1,
        detail: `expected ${record.expectedOutcome}, got ${record.observedOutcome}`,
      });
    }
  }

  if (GLOBAL_THRESHOLDS.interceptionFallbacksMustPreserveNative) {
    for (const record of records) {
      if (!record.fallbackReason || !INTERCEPTION_STAGE_REASONS.has(record.fallbackReason as FallbackReason)) continue;
      if (record.nativePreserved) continue;
      violations.push({
        name: "native-not-preserved",
        scope: `${record.id} x ${record.host} x ${record.profile}`,
        measured: 0,
        limit: 1,
        detail: `interception-stage fallback (${record.fallbackReason}) did not return the native text`,
      });
    }
  }

  if (GLOBAL_THRESHOLDS.wrongProfileMustMissGold) {
    for (const record of records) {
      if (!GLOBAL_THRESHOLDS.profilesThatMustMissGold.includes(record.profile)) continue;
      if (!record.wasIntercepted || record.goldCoverage < 1) continue;
      violations.push({
        name: "wrong-profile-faked-success",
        scope: `${record.id} x ${record.host} x ${record.profile}`,
        measured: Number(record.goldCoverage.toFixed(2)),
        limit: 0.99,
        detail: `profile ${record.profile} is defined to exclude the gold answer yet reported full gold coverage — the corpus or the simulated model no longer discriminates`,
      });
    }
  }

  if (GLOBAL_THRESHOLDS.reasonsMustAgree) {
    for (const record of records) {
      if (record.reasonsAgree) continue;
      violations.push({
        name: "reason-mismatch",
        scope: `${record.id} x ${record.host} x ${record.profile}`,
        measured: 0,
        limit: 1,
        detail: `interceptor logged ${record.fallbackReason ?? "none"} but the host delivered ${record.resultFallbackReason ?? "none"}`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}
