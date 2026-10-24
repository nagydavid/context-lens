import { configPath, readConfigObject } from "./config.js";
import type { ConfigOptions } from "./config.js";
import type { JudgeMode } from "./judge.js";
import { DEFAULT_PDF_MAX_CHARS, DEFAULT_PDF_TIMEOUT_MS } from "./pdf.js";

export interface TuningSettings {
  thresholdLines: number;
  timeoutMs: number;
  concurrency: number;
  chunkLines: number;
  chunkOverlapLines: number;
  judge: JudgeMode;
  cacheMaxEntries: number;
  /** Skip delegation under this estimated size even past thresholdLines. */
  minTokens: number;
  /** Intercept at this estimated size even under thresholdLines. */
  thresholdTokens: number;
  /** Maximum time allowed for PDF text extraction. */
  pdfTimeoutMs: number;
  /** Maximum extracted PDF text length. */
  pdfMaxChars: number;
}

export type TuningSource = "explicit" | "env" | "project" | "global" | "default";

export const DEFAULT_TUNING: Readonly<TuningSettings> = Object.freeze({
  thresholdLines: 350,
  timeoutMs: 30000,
  concurrency: 1,
  chunkLines: 0,
  chunkOverlapLines: 0,
  judge: "off",
  cacheMaxEntries: 64,
  minTokens: 1000,
  thresholdTokens: 8000,
  pdfTimeoutMs: DEFAULT_PDF_TIMEOUT_MS,
  pdfMaxChars: DEFAULT_PDF_MAX_CHARS,
});

export interface TuningOptions extends ConfigOptions {
  explicit?: Partial<TuningSettings>;
}

type Key = keyof TuningSettings;
/** Public alias so the write seam (and hosts) can enumerate validated keys. */
export type TuningKey = Key;
const KEYS = Object.keys(DEFAULT_TUNING) as Key[];
/** Every tuning key accepted by loadTuning, saveTuning and clearTuning. */
export const TUNING_KEYS: readonly TuningKey[] = KEYS;

export function isTuningKey(value: unknown): value is TuningKey {
  return typeof value === "string" && KEYS.includes(value as Key);
}
const JUDGE_MODES: readonly string[] = ["off", "low-confidence", "always"];
const MIN: Record<Exclude<Key, "judge">, number> = {
  thresholdLines: 1,
  timeoutMs: 1,
  concurrency: 1,
  chunkLines: 0,
  chunkOverlapLines: 0,
  cacheMaxEntries: 0,
  minTokens: 1,
  thresholdTokens: 1,
  pdfTimeoutMs: 1,
  pdfMaxChars: 1,
};

const ENV_NAMES: Record<Key, string> = {
  thresholdLines: "PARADOC_THRESHOLD",
  timeoutMs: "PARADOC_TIMEOUT_MS",
  concurrency: "PARADOC_CONCURRENCY",
  chunkLines: "PARADOC_CHUNK_LINES",
  chunkOverlapLines: "PARADOC_CHUNK_OVERLAP",
  judge: "PARADOC_JUDGE",
  cacheMaxEntries: "PARADOC_CACHE",
  minTokens: "PARADOC_MIN_TOKENS",
  thresholdTokens: "PARADOC_THRESHOLD_TOKENS",
  pdfTimeoutMs: "PARADOC_PDF_TIMEOUT_MS",
  pdfMaxChars: "PARADOC_PDF_MAX_CHARS",
};

export type TuningCheck = { ok: true; value: number | JudgeMode } | { ok: false; reason: string };

function check(key: Key, value: unknown, fromEnv: boolean): TuningCheck {
  if (key === "judge") {
    return typeof value === "string" && JUDGE_MODES.includes(value)
      ? { ok: true, value: value as JudgeMode }
      : { ok: false, reason: "expected off, low-confidence or always" };
  }
  let n: unknown = value;
  if (fromEnv) {
    const text = typeof value === "string" ? value.trim() : "";
    if (key === "cacheMaxEntries" && text === "off") return { ok: true, value: 0 };
    n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  }
  const min = MIN[key];
  if (typeof n !== "number" || !Number.isInteger(n) || n < min) {
    return { ok: false, reason: `expected an integer >= ${min}` };
  }
  return { ok: true, value: n };
}

/** Validate one candidate value with the same rules loadTuning applies to config-file values. */
export function validateTuningValue(key: TuningKey, value: unknown): TuningCheck {
  return check(key, value, false);
}

function safeWarn(options: ConfigOptions, message: string): void {
  try {
    options.onWarning?.(message);
  } catch {
    // Warning callbacks must not affect tuning resolution.
  }
}

function readTuningBlock(
  scope: "project" | "global",
  options: ConfigOptions,
): { path: string; block: Record<string, unknown> } | undefined {
  const path = configPath(scope, options);
  const config = readConfigObject(path, options);
  if (!config || config.tuning === undefined) return undefined;
  const block = config.tuning;
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    safeWarn(options, `paradoc: ignoring ${path}: invalid tuning`);
    return undefined;
  }
  return { path, block: block as Record<string, unknown> };
}

function defaults(): { settings: TuningSettings; sources: Record<Key, TuningSource> } {
  const sources = {} as Record<Key, TuningSource>;
  for (const key of KEYS) sources[key] = "default";
  return { settings: { ...DEFAULT_TUNING }, sources };
}

export function loadTuning(options: TuningOptions = {}): {
  settings: TuningSettings;
  sources: Record<Key, TuningSource>;
} {
  try {
    const env = options.env ?? process.env;
    const explicit = options.explicit ?? {};
    const project = readTuningBlock("project", options);
    const global = readTuningBlock("global", options);
    const { settings, sources } = defaults();
    const target = settings as unknown as Record<Key, number | string>;

    for (const key of KEYS) {
      const layers: Array<[TuningSource, string, unknown, boolean]> = [
        ["explicit", `explicit ${key}`, explicit[key], false],
        ["env", env[ENV_NAMES[key]] === undefined ? "" : ENV_NAMES[key], env[ENV_NAMES[key]], true],
        ["project", project?.path ?? "", project?.block[key], false],
        ["global", global?.path ?? "", global?.block[key], false],
      ];
      for (const [source, label, value, fromEnv] of layers) {
        if (value === undefined) continue;
        const result = check(key, value, fromEnv);
        if (result.ok) {
          target[key] = result.value;
          sources[key] = source;
          break;
        }
        const origin = source === "explicit" || source === "env" ? label : `${label} tuning.${key}`;
        safeWarn(options, `paradoc: ignoring ${origin}: ${result.reason}`);
      }
    }

    if (settings.chunkLines > 0) {
      const derived = Math.min(50, settings.chunkLines - 1);
      if (sources.chunkOverlapLines === "default") {
        settings.chunkOverlapLines = derived;
      } else if (settings.chunkOverlapLines >= settings.chunkLines) {
        safeWarn(
          options,
          `paradoc: ignoring ${sources.chunkOverlapLines} chunkOverlapLines: must be smaller than chunkLines`,
        );
        settings.chunkOverlapLines = derived;
        sources.chunkOverlapLines = "default";
      }
    }
    return { settings, sources };
  } catch (error: unknown) {
    safeWarn(
      options,
      `paradoc: could not load tuning: ${error instanceof Error ? error.message : String(error)}`,
    );
    return defaults();
  }
}

export function tuningToInterceptorOptions(settings: TuningSettings): {
  thresholdLines: number;
  timeoutMs: number;
  chunkLines: number;
  chunkOverlapLines: number;
  minTokens: number;
  thresholdTokens: number;
  pdfTimeoutMs: number;
  pdfMaxChars: number;
  judge: { mode: JudgeMode };
} {
  return {
    thresholdLines: settings.thresholdLines,
    timeoutMs: settings.timeoutMs,
    chunkLines: settings.chunkLines,
    chunkOverlapLines: settings.chunkOverlapLines,
    minTokens: settings.minTokens,
    thresholdTokens: settings.thresholdTokens,
    pdfTimeoutMs: settings.pdfTimeoutMs,
    pdfMaxChars: settings.pdfMaxChars,
    judge: { mode: settings.judge },
  };
}
