/**
 * Measurement records, aggregation and the matrix runner for the value harness.
 *
 * One record per corpus item x host x accuracy profile. Token figures are estimates (chars/4, the
 * same rule the interceptor uses — MEM048); counts and milliseconds are measured.
 *
 * Net savings deliberately subtracts the tokens the cheap model was *given*: a condensation that
 * forwards the whole file to a subagent is not a saving, and the harness refuses to report one.
 */
import { estimateTokens } from "../core/interceptor.js";
import { DEFAULT_MAX_FALLBACK_LINES } from "../core/web-document.js";
import type { ResultCache } from "../core/cache.js";
import { LruResultCache } from "../core/cache.js";
import type { JudgeMode } from "../core/judge.js";
import type { SubagentRunner } from "../core/subagent.js";
import type { AccuracyProfile } from "./sim-runner.js";
import type { CorpusItem, ExpectedOutcome, MaterializedCorpus, SourceType } from "./corpus.js";
import type { Host, HostName, HostRunResult } from "./hosts.js";

export interface MeasurementRecord {
  id: string;
  sourceType: SourceType;
  host: HostName;
  profile: AccuracyProfile;

  nativeChars: number;
  nativeEstTokens: number;
  /** Raw HTML size for web items; the native baseline is the converted text the host serves. */
  nativeRawHtmlChars?: number;

  wasIntercepted: boolean;
  renderedChars: number;
  renderedEstTokens: number;

  /** Token figures reported by the interceptor itself (diagnostics record). */
  estTokensSaved: number;
  estTokensDelegated: number;
  /** Harness-side figure: what the model actually got back, minus what the cheap model was fed. */
  netEstTokensSaved: number;
  savingsPct: number;
  netSavingsPct: number;

  /** Wall clock around the whole host call, and the interceptor's own measured time. */
  elapsedMs: number;
  interceptorElapsedMs: number;

  chunks: number;
  attempts: number;
  cacheHit: boolean;
  confidence?: number;
  judgeVerdict?: "sufficient" | "insufficient";

  fallbackReason: string | null;
  /** Fallback reason as the host delivered it (MCP only) — cross-checked against the event. */
  resultFallbackReason: string | null;
  /** True when the host surfaced a reason, so the cross-check against the event is meaningful. */
  reasonCrossChecked: boolean;
  /** No contradiction between the diagnostics reason and the delivered reason. */
  reasonsAgree: boolean;

  /** 0..1 share of gold lines (or gold needles, when no ranges exist) present in the reply. */
  goldCoverage: number;
  needlePresent: boolean;
  omittedRangeCount: number;
  /** The host still returned the item's original text (byte-identical on hook fallbacks, verbatim up
   *  to the MCP host's own fallback line cap on the MCP host). */
  nativePreserved: boolean;
  /** Savings are only meaningful when the host returned content for the item at all. */
  savingsMeasurable: boolean;
  /** A degraded profile did no harm: it fell back with the native text intact, or missed visibly. */
  contained: boolean;

  expectedOutcome: ExpectedOutcome;
  observedOutcome: ExpectedOutcome;
  outcomeMatchesExpected: boolean;

  notes?: string;
}

export interface AggregateRow {
  sourceType: SourceType;
  host: HostName;
  n: number;
  /** Records whose savings are meaningful (the host returned content for the item). */
  measurableN: number;
  latencyMeanMs: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  savingsPctMean: number;
  netSavingsPctMean: number;
  interceptionRate: number;
  fallbackRate: number;
  goldCoverageMean: number;
  /** Null when no judge ran for this group. */
  judgeSufficientRate: number | null;
  judgedCount: number;
  fallbackReasons: Record<string, number>;
}

export interface SkippedRun {
  id: string;
  host: HostName;
  reason: string;
}

const EXCERPT_HEADER = /^--- lines (\d+)-(\d+)/gm;
const SHOWING_HEADER = /showing \d+ of (\d+) lines/;
const NUMBER_PREFIX = /^\s*\d{5}\| ?/;
/** Lines a host wraps content in: its own headers/markers and the web provenance line. */
const HOST_WRAPPER_LINE = /^(\[paradoc\]|\[paradoc: |Untrusted external web content)/;
/** The MCP host announces an interception-stage fallback with this header. */
const FALLBACK_HEADER = /^\[paradoc\] fallback: /;

/** Remove host chrome lines and un-number the body, so content can be compared with the native text. */
function hostBody(renderedText: string): string {
  return renderedText
    .split("\n")
    .filter((line) => !HOST_WRAPPER_LINE.test(line))
    .map((line) => line.replace(NUMBER_PREFIX, ""))
    .join("\n");
}

/**
 * The item content a reply actually carries. Host chrome (the `[paradoc]` header, the question /
 * confidence / summary lines, the `--- lines N-M — reason` banners, the omitted-ranges line, the
 * hint) is not item content, and a runner reason can quote a gold needle, so answer quality is
 * measured on content only: numbered body lines when the host numbered its reply, otherwise the
 * whole reply (hook hosts pass the native text through unnumbered).
 */
export function replyContentLines(renderedText: string): string[] {
  const lines = renderedText.split("\n");
  const numbered = lines.filter((line) => NUMBER_PREFIX.test(line));
  if (numbered.length === 0) return lines;
  return numbered.map((line) => line.replace(NUMBER_PREFIX, ""));
}

/** Excerpt ranges as the host actually rendered them. */
export function parseExcerptRanges(text: string): Array<{ startLine: number; endLine: number }> {
  const ranges: Array<{ startLine: number; endLine: number }> = [];
  for (const match of text.matchAll(EXCERPT_HEADER)) {
    ranges.push({ startLine: Number(match[1]), endLine: Number(match[2]) });
  }
  return ranges;
}

function overlapLines(
  gold: ReadonlyArray<{ startLine: number; endLine: number }>,
  returned: ReadonlyArray<{ startLine: number; endLine: number }>,
): { covered: number; total: number } {
  let covered = 0;
  let total = 0;
  for (const g of gold) {
    total += g.endLine - g.startLine + 1;
    for (const r of returned) {
      const lo = Math.max(g.startLine, r.startLine);
      const hi = Math.min(g.endLine, r.endLine);
      if (hi >= lo) covered += hi - lo + 1;
    }
  }
  return { covered, total };
}

/** Count line ranges the reply left out, mirroring the renderer's own gap computation. */
export function countOmittedRanges(
  ranges: ReadonlyArray<{ startLine: number; endLine: number }>,
  fullLineCount: number,
): number {
  if (ranges.length === 0 || fullLineCount <= 0) return 0;
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  let gaps = 0;
  let next = 1;
  for (const { startLine, endLine } of sorted) {
    if (startLine > next) gaps++;
    next = Math.max(next, endLine + 1);
  }
  if (next <= fullLineCount) gaps++;
  return gaps;
}

export function goldCoverageFor(item: CorpusItem, renderedText: string, ranges: ReadonlyArray<{ startLine: number; endLine: number }>): number {
  if (item.goldRanges && item.goldRanges.length > 0 && ranges.length > 0) {
    const { covered, total } = overlapLines(item.goldRanges, ranges);
    return total === 0 ? 1 : Math.min(1, covered / total);
  }
  if (item.goldNeedles.length > 0) {
    const found = item.goldNeedles.filter((needle) => renderedText.includes(needle)).length;
    return found / item.goldNeedles.length;
  }
  // Nothing was expected back: nothing can be missing.
  return 1;
}

export function needlePresentFor(item: CorpusItem, renderedText: string): boolean {
  if (item.goldNeedles.length === 0) return true;
  return item.goldNeedles.every((needle) => renderedText.includes(needle));
}

/**
 * Did the host still hand back the item's original text?
 *
 * Hook hosts return it byte-identical. The MCP host numbers its lines and bounds what it returns
 * (web fallback text is capped at DEFAULT_MAX_FALLBACK_LINES in src/core/web-document.ts), so a
 * fallback reply counts as preserved only when it reproduces the native text verbatim from line 1
 * down to that cap. A reply that is merely a short slice of the file is not preserved.
 */
export function nativePreservedFor(nativeText: string, renderedText: string): boolean {
  if (nativeText === "") return true;
  if (renderedText === nativeText) return true;
  const needle = nativeText.replace(/\n+$/, "");
  const body = hostBody(renderedText).replace(/\n+$/, "");
  if (body === "") return false;
  if (body.includes(needle)) return true;
  if (!FALLBACK_HEADER.test(renderedText)) return false;
  const nativeLines = needle.split("\n");
  const bodyLines = body.split("\n");
  if (bodyLines.length > nativeLines.length) return false;
  if (bodyLines.length < Math.min(nativeLines.length, DEFAULT_MAX_FALLBACK_LINES)) return false;
  return nativeLines.slice(0, bodyLines.length).join("\n") === body;
}

/** Outcome the corpus expects vs. the outcome the host actually produced. */
export function observedOutcomeFor(run: HostRunResult): ExpectedOutcome {
  if (run.wasIntercepted) return "intercept";
  if (run.fallbackReason) return `fallback:${run.fallbackReason}`;
  return "passthrough";
}

export function buildRecord(
  item: CorpusItem,
  host: HostName,
  profile: AccuracyProfile,
  run: HostRunResult,
  elapsedMs: number,
): MeasurementRecord {
  const nativeEstTokens = estimateTokens(run.nativeText);
  const renderedEstTokens = estimateTokens(run.renderedText);
  const estTokensSaved = run.event?.estTokensSaved ?? run.stats?.estTokensSaved ?? 0;
  const estTokensDelegated = run.event?.estTokensDelegated ?? run.stats?.estTokensDelegated ?? 0;
  const netEstTokensSaved = nativeEstTokens - renderedEstTokens - estTokensDelegated;
  const savingsPct = nativeEstTokens > 0 ? ((nativeEstTokens - renderedEstTokens) / nativeEstTokens) * 100 : 0;
  const netSavingsPct = nativeEstTokens > 0 ? (netEstTokensSaved / nativeEstTokens) * 100 : 0;

  const ranges = parseExcerptRanges(run.renderedText);
  const contentText = replyContentLines(run.renderedText).join("\n");
  const showing = SHOWING_HEADER.exec(run.renderedText);
  const fullLineCount = showing ? Number(showing[1]) : run.event?.lineCount ?? run.nativeText.split("\n").length;
  const observed = observedOutcomeFor(run);
  const goldCoverage = goldCoverageFor(item, contentText, ranges);
  const nativePreserved = nativePreservedFor(run.nativeText, run.renderedText);
  // A guard failure that returns an error instead of content has no savings to measure.
  const savingsMeasurable = run.nativeText !== "" && (run.wasIntercepted || nativePreserved);
  // A degraded profile is contained when it fell back with the reply intact, or missed visibly.
  const contained =
    profile === "correct"
      ? observed === item.expected
      : run.fallbackReason !== null
        ? nativePreserved
        : goldCoverage < 1 || observed === item.expected;

  return {
    id: item.id,
    sourceType: item.sourceType,
    host,
    profile,
    nativeChars: run.nativeText.length,
    nativeEstTokens,
    ...(run.nativeRawHtmlChars !== undefined ? { nativeRawHtmlChars: run.nativeRawHtmlChars } : {}),
    wasIntercepted: run.wasIntercepted,
    renderedChars: run.renderedText.length,
    renderedEstTokens,
    estTokensSaved,
    estTokensDelegated,
    netEstTokensSaved,
    savingsPct,
    netSavingsPct,
    elapsedMs,
    interceptorElapsedMs: run.event?.elapsedMs ?? 0,
    chunks: run.event?.chunks ?? 1,
    attempts: run.event?.attempts ?? 1,
    cacheHit: run.event?.cacheHit ?? false,
    ...(run.event?.confidence !== undefined ? { confidence: run.event.confidence } : {}),
    ...(run.event?.judge?.verdict !== undefined ? { judgeVerdict: run.event.judge.verdict } : {}),
    fallbackReason: run.fallbackReason,
    resultFallbackReason: run.resultFallbackReason,
    reasonCrossChecked: run.resultFallbackReason !== null,
    reasonsAgree: run.resultFallbackReason === null || run.resultFallbackReason === run.fallbackReason,
    goldCoverage,
    needlePresent: needlePresentFor(item, contentText),
    omittedRangeCount: countOmittedRanges(ranges, fullLineCount),
    nativePreserved,
    savingsMeasurable,
    contained,
    expectedOutcome: item.expected,
    observedOutcome: observed,
    outcomeMatchesExpected: observed === item.expected,
  };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Nearest-rank percentile on an unsorted sample. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

export function aggregate(records: readonly MeasurementRecord[]): AggregateRow[] {
  const groups = new Map<string, MeasurementRecord[]>();
  for (const record of records) {
    const key = `${record.sourceType}\u0000${record.host}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(record);
    else groups.set(key, [record]);
  }

  const rows: AggregateRow[] = [];
  for (const bucket of groups.values()) {
    const latencies = bucket.map((r) => r.elapsedMs);
    const measurable = bucket.filter((r) => r.savingsMeasurable);
    const judged = bucket.filter((r) => r.judgeVerdict !== undefined);
    const fallbackReasons: Record<string, number> = {};
    for (const record of bucket) {
      if (record.fallbackReason) {
        fallbackReasons[record.fallbackReason] = (fallbackReasons[record.fallbackReason] ?? 0) + 1;
      }
    }
    rows.push({
      sourceType: bucket[0].sourceType,
      host: bucket[0].host,
      n: bucket.length,
      measurableN: measurable.length,
      latencyMeanMs: mean(latencies),
      latencyP50Ms: percentile(latencies, 0.5),
      latencyP95Ms: percentile(latencies, 0.95),
      savingsPctMean: mean(measurable.map((r) => r.savingsPct)),
      netSavingsPctMean: mean(measurable.map((r) => r.netSavingsPct)),
      interceptionRate: bucket.filter((r) => r.wasIntercepted).length / bucket.length,
      fallbackRate: bucket.filter((r) => r.fallbackReason !== null).length / bucket.length,
      goldCoverageMean: mean(bucket.map((r) => r.goldCoverage)),
      judgeSufficientRate: judged.length === 0 ? null : judged.filter((r) => r.judgeVerdict === "sufficient").length / judged.length,
      judgedCount: judged.length,
      fallbackReasons,
    });
  }
  rows.sort((a, b) => a.sourceType.localeCompare(b.sourceType) || a.host.localeCompare(b.host));
  return rows;
}

export interface RunMatrixOptions {
  corpus: MaterializedCorpus;
  hosts: Host[];
  profiles: readonly AccuracyProfile[];
  /** A fresh runner per run keeps cache state and call counts independent. */
  runnerFactory: (options: { item: CorpusItem; profile: AccuracyProfile; latencyMs?: number }) => SubagentRunner;
  latencyMs?: number;
  timeoutMs?: number;
  judge?: JudgeMode;
  /** Fresh cache per run by default; pass a factory to share one deliberately. */
  cacheFactory?: () => ResultCache | undefined;
  /** Restrict the corpus (tests use a reduced subset). */
  filter?: (item: CorpusItem) => boolean;
  onProgress?: (message: string) => void;
}

export interface MatrixResult {
  records: MeasurementRecord[];
  skipped: SkippedRun[];
}

/** Run every (item, host, profile) combination the host x type matrix supports. */
export async function runMatrix(options: RunMatrixOptions): Promise<MatrixResult> {
  const records: MeasurementRecord[] = [];
  const skipped: SkippedRun[] = [];
  const cacheFactory = options.cacheFactory ?? (() => new LruResultCache({ maxEntries: 64 }));

  for (const item of options.corpus.items) {
    if (options.filter && !options.filter(item)) continue;
    for (const host of options.hosts) {
      if (!host.supports(item)) {
        skipped.push({ id: item.id, host: host.name, reason: "host-does-not-intercept-this-source-type" });
        continue;
      }
      for (const profile of options.profiles) {
        const runner = options.runnerFactory({ item, profile, latencyMs: options.latencyMs });
        const cache = cacheFactory();
        const startedAt = Date.now();
        const run = await host.run({
          item,
          runner,
          ...(cache ? { cache } : {}),
          dir: options.corpus.dir,
          ...(options.latencyMs !== undefined ? { latencyMs: options.latencyMs } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.judge ? { judge: options.judge } : {}),
        });
        const elapsedMs = Date.now() - startedAt;
        records.push(buildRecord(item, host.name, profile, run, elapsedMs));
        options.onProgress?.(`${item.id} x ${host.name} x ${profile}`);
      }
    }
  }
  return { records, skipped };
}
