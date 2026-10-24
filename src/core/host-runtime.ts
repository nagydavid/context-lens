import { appendFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { LruResultCache, type ResultCache } from "./cache.js";
import type { ConfigOptions, ModelChoice } from "./config.js";
import { eventLogLevel, ReadInterceptor, type InterceptionEvent } from "./interceptor.js";
import type { JudgeOptions } from "./judge.js";
import { ModelSelector, type ModelPicker } from "./model-selector.js";
import type { PdfExtractor } from "./pdf.js";
import type { SubagentRunner } from "./subagent.js";
import {
  buildStatus,
  statusConfigPaths,
  type ParadocStatus,
  type StatusModelSource,
} from "./status.js";
import {
  loadTuning,
  tuningToInterceptorOptions,
  type TuningSettings,
  type TuningSource,
} from "./tuning.js";

/** Small shared helpers used by every host adapter (was duplicated per adapter). */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validLine(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export function describeEvent(event: InterceptionEvent): string {
  const judge = event.judge ? `, judge=${event.judge.verdict ?? "error"}` : "";
  const judgeError = event.judge?.error ? ` judge error: ${event.judge.error}` : "";
  if (event.intercepted) {
    return `intercepted ${event.filePath} (${event.lineCount} lines, confidence ${event.confidence ?? "?"}${event.chunks !== undefined ? `, chunks=${event.chunks}` : ""}${event.cacheHit ? ", cacheHit=true" : ""}${judge}, ${Math.round(event.elapsedMs ?? 0)}ms)${judgeError}`;
  }
  if (event.fallbackReason) {
    return `fallback ${event.fallbackReason} for ${event.filePath}${event.detail ? `: ${event.detail}` : ""}${judge}`;
  }
  return `passthrough ${event.filePath} (${event.lineCount} lines)`;
}

export function displayPathFor(filePath: string, root: string): string {
  const rel = relative(root, resolve(root, filePath));
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? filePath : rel;
}

/** Host options that map onto tuning keys; only defined keys become explicit overrides. */
export interface HostTuningOptions {
  thresholdLines?: number;
  timeoutMs?: number;
  concurrency?: number;
  chunkLines?: number;
  chunkOverlapLines?: number;
  judge?: JudgeOptions;
}

export function explicitFromOptions(options: HostTuningOptions): Partial<TuningSettings> {
  const explicit: Partial<TuningSettings> = {};
  if (options.thresholdLines !== undefined) explicit.thresholdLines = options.thresholdLines;
  if (options.timeoutMs !== undefined) explicit.timeoutMs = options.timeoutMs;
  if (options.concurrency !== undefined) explicit.concurrency = options.concurrency;
  if (options.chunkLines !== undefined) explicit.chunkLines = options.chunkLines;
  if (options.chunkOverlapLines !== undefined) explicit.chunkOverlapLines = options.chunkOverlapLines;
  if (options.judge?.mode !== undefined) explicit.judge = options.judge.mode;
  return explicit;
}

/** Unified diagnostics record shape: { ts, level, message, ...extra }. */
export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

export interface DiagnosticRecord {
  ts: string;
  level: DiagnosticLevel;
  message: string;
  [key: string]: unknown;
}

export interface DiagnosticsOptions {
  /** Host delivery for the text line and the structured record. */
  sink?: (line: string, record: DiagnosticRecord) => void;
  /** JSONL append target (PARADOC_LOG_FILE). Best-effort; every failure is swallowed. */
  logFile?: string;
  /** Default delivery when no sink is provided. */
  stderr?: (line: string) => void;
}

export interface Diagnostics {
  log(level: DiagnosticLevel, message: string, extra?: Record<string, unknown>): void;
}

export function createDiagnostics(options: DiagnosticsOptions = {}): Diagnostics {
  const log = (level: DiagnosticLevel, message: string, extra: Record<string, unknown> = {}): void => {
    const record: DiagnosticRecord = { ts: new Date().toISOString(), level, message, ...extra };
    const line = `[paradoc] ${level}: ${message} ${JSON.stringify(extra)}`;
    try {
      if (options.sink) options.sink(line, record);
      else if (options.stderr) options.stderr(line);
      else process.stderr.write(`${line}\n`);
    } catch {
      // Logging must never alter host behaviour.
    }
    if (options.logFile) {
      try {
        appendFileSync(options.logFile, `${JSON.stringify(record)}\n`, "utf8");
      } catch {
        // Diagnostic persistence is best-effort.
      }
    }
  };
  return { log };
}

export interface HostRuntimeOptions {
  /** Root used for process-scoped tuning (runner concurrency, cache size). */
  projectRoot: string;
  configOptions?: ConfigOptions;
  env?: Record<string, string | undefined>;
  explicit?: Partial<TuningSettings>;
  log: (level: DiagnosticLevel, message: string, extra?: Record<string, unknown>) => void;
  /** Runner instance, or a factory built from the resolved settings (lazy so host startup stays fast). */
  runner?: SubagentRunner | ((settings: TuningSettings) => SubagentRunner);
  cache?: ResultCache;
  /** Model picker forwarded to each per-root ModelSelector. */
  picker?: ModelPicker;
  pdfExtractor?: PdfExtractor;
  judge?: JudgeOptions;
  maxFileBytes?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface HostRuntime {
  /** Process-scoped tuning snapshot. */
  settings: TuningSettings;
  sources: Record<keyof TuningSettings, TuningSource>;
  cache: ResultCache | undefined;
  /** Tuning resolved for one root (cached; the process root reuses `settings`). */
  tuningFor(root: string): TuningSettings;
  modelSelectorFor(root: string): ModelSelector;
  /** Lazily builds and caches one ReadInterceptor per root. */
  interceptorFor(root: string): ReadInterceptor;
  /** Effective settings, provenance, stored model, config paths and interceptor stats for one root. */
  getStatus(root?: string): Promise<ParadocStatus>;
}

/** Shared bootstrap for host adapters: tuning, cache, model selection, interceptor construction. */
export function createHostRuntime(options: HostRuntimeOptions): HostRuntime {
  const env = options.configOptions?.env ?? options.env ?? process.env;
  const warn = (message: string): void => options.log("warn", message);

  const { settings, sources } = loadTuning({
    ...options.configOptions,
    env,
    projectRoot: options.projectRoot,
    explicit: options.explicit,
    onWarning: warn,
  });

  const cache = options.cache ??
    (settings.cacheMaxEntries > 0 ? new LruResultCache({ maxEntries: settings.cacheMaxEntries }) : undefined);

  let runner = typeof options.runner === "function" ? undefined : options.runner;
  const resolveRunner = (): SubagentRunner => {
    if (!runner) runner = (options.runner as (settings: TuningSettings) => SubagentRunner)(settings);
    return runner;
  };

  const tuningCache = new Map<string, TuningSettings>();
  const tuningFor = (root: string): TuningSettings => {
    if (root === options.projectRoot) return settings;
    let tuned = tuningCache.get(root);
    if (!tuned) {
      tuned = loadTuning({
        ...options.configOptions,
        env,
        projectRoot: root,
        explicit: options.explicit,
        onWarning: warn,
      }).settings;
      tuningCache.set(root, tuned);
    }
    return tuned;
  };

  const selectors = new Map<string, ModelSelector>();
  const modelSelectorFor = (root: string): ModelSelector => {
    let selector = selectors.get(root);
    if (!selector) {
      selector = new ModelSelector({
        ...options.configOptions,
        projectRoot: root,
        ...(options.picker ? { picker: options.picker } : {}),
        onWarning: warn,
      });
      selectors.set(root, selector);
    }
    return selector;
  };

  const interceptors = new Map<string, ReadInterceptor>();
  const interceptorFor = (root: string): ReadInterceptor => {
    let interceptor = interceptors.get(root);
    if (!interceptor) {
      const tuned = tuningFor(root);
      interceptor = new ReadInterceptor({
        runner: resolveRunner(),
        cache,
        modelResolver: modelSelectorFor(root).resolve,
        ...tuningToInterceptorOptions(tuned),
        maxFileBytes: options.maxFileBytes,
        maxRetries: options.maxRetries,
        retryDelayMs: options.retryDelayMs,
        ...(options.judge ? { judge: options.judge } : {}),
        ...(options.pdfExtractor ? { pdfExtractor: options.pdfExtractor } : {}),
        // Running totals (counts/ms measured, token figures estimated) ride along on each event.
        logger: (event) => options.log(
          eventLogLevel(event),
          describeEvent(event),
          { ...event, stats: interceptor!.stats() },
        ),
      });
      interceptors.set(root, interceptor);
    }
    return interceptor;
  };

  const getStatus = async (root: string = options.projectRoot): Promise<ParadocStatus> => {
    const warnings: string[] = [];
    const collect = (message: string): void => {
      warnings.push(message);
    };
    const scoped: ConfigOptions = { ...options.configOptions, projectRoot: root };
    const { settings, sources } = loadTuning({ ...scoped, env, explicit: options.explicit, onWarning: collect });
    // Status must never prompt: a picker-less selector reports stored choices only.
    const resolved = await new ModelSelector({ ...scoped, onWarning: collect }).resolve().catch(() => undefined);
    const model: { choice?: ModelChoice; source: StatusModelSource } = resolved
      ? { choice: resolved.choice, source: resolved.source }
      : { source: options.picker ? "picker" : "none" };
    const interceptor = interceptors.get(root);
    return buildStatus({
      settings,
      sources,
      model,
      configPaths: statusConfigPaths(scoped),
      ...(interceptor ? { stats: interceptor.stats() } : {}),
      warnings,
    });
  };

  return { settings, sources, cache, tuningFor, modelSelectorFor, interceptorFor, getStatus };
}
