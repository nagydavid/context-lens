import { appendFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  LruResultCache,
  ModelSelector,
  ReadInterceptor,
  eventLogLevel,
  loadTuning,
  tuningToInterceptorOptions,
  type ConfigOptions,
  type InterceptionEvent,
  type JudgeOptions,
  type ResultCache,
  type SubagentRunner,
  type TuningSettings,
} from "../core/index.js";
import { renderInterceptionResult } from "../opencode/render.js";
import { createCopilotRunner } from "./subagent.js";
import type {
  CopilotHooks,
  CopilotSessionLike,
  CopilotToolResult,
  PostToolUseHookInput,
} from "./types.js";

export const COPILOT_HINT =
  "Note: this view was condensed by context-lens. Re-run view with an explicit view_range to see exact or full content; ranged views are never condensed.";

type LogLevel = "debug" | "info" | "warn" | "error";

export interface CopilotHooksOptions {
  runner?: SubagentRunner;
  /** Result cache shared across all per-directory interceptors. */
  cache?: ResultCache;
  thresholdLines?: number;
  chunkLines?: number;
  chunkOverlapLines?: number;
  concurrency?: number;
  timeoutMs?: number;
  maxFileBytes?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  judge?: JudgeOptions;
  configOptions?: Pick<ConfigOptions, "homeDir" | "env" | "projectRoot">;
  env?: NodeJS.ProcessEnv;
  logSink?: (line: string, record: object) => void;
}

const MAX_TRACKED_SESSIONS = 100;
const MAX_TASK_CHARS = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeEvent(event: InterceptionEvent): string {
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

function displayPathFor(filePath: string, root: string): string {
  const rel = relative(root, resolve(root, filePath));
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? filePath : rel;
}

function hasRangeArgument(args: Record<string, unknown>): boolean {
  return Object.keys(args).some((key) =>
    /range/i.test(key) || ["start_line", "startLine", "end_line", "endLine", "offset", "limit"].includes(key),
  );
}

/** Creates probe-shaped Copilot hooks which never replace a host view on failure. */
export function createCopilotHooks(
  options: CopilotHooksOptions = {},
): CopilotHooks & { setSession(session: CopilotSessionLike): void } {
  const env = options.env ?? process.env;
  let session: CopilotSessionLike | undefined;
  const lastPrompt = new Map<string, string>();

  const log = (level: LogLevel, message: string, extra: Record<string, unknown> = {}): void => {
    const record = { ts: new Date().toISOString(), level, message, ...extra };
    const line = `[context-lens] ${level}: ${message} ${JSON.stringify(extra)}`;
    try {
      if (options.logSink) options.logSink(line, record);
      else process.stderr.write(`${line}\n`);
    } catch {
      // Logging must never alter host behaviour.
    }
    try {
      const pending = session?.log?.(line, record);
      void Promise.resolve(pending).catch(() => undefined);
    } catch {
      // Host session logging is best-effort.
    }
    if (env.CONTEXT_LENS_LOG_FILE) {
      try {
        appendFileSync(env.CONTEXT_LENS_LOG_FILE, `${JSON.stringify(record)}\n`, "utf8");
      } catch {
        // Diagnostic persistence is best-effort.
      }
    }
  };

  const selectors = new Map<string, ModelSelector>();
  const selectorFor = (workingDirectory: string): ModelSelector => {
    let selector = selectors.get(workingDirectory);
    if (!selector) {
      selector = new ModelSelector({
        ...options.configOptions,
        projectRoot: workingDirectory,
        onWarning: (message) => log("warn", message),
      });
      selectors.set(workingDirectory, selector);
    }
    return selector;
  };

  const explicit: Partial<TuningSettings> = {};
  if (options.thresholdLines !== undefined) explicit.thresholdLines = options.thresholdLines;
  if (options.timeoutMs !== undefined) explicit.timeoutMs = options.timeoutMs;
  if (options.concurrency !== undefined) explicit.concurrency = options.concurrency;
  if (options.chunkLines !== undefined) explicit.chunkLines = options.chunkLines;
  if (options.chunkOverlapLines !== undefined) explicit.chunkOverlapLines = options.chunkOverlapLines;
  if (options.judge?.mode !== undefined) explicit.judge = options.judge.mode;
  const tuningEnv = options.configOptions?.env ?? options.env ?? process.env;
  const tuningFor = (projectRoot: string): TuningSettings => loadTuning({
    ...options.configOptions,
    env: tuningEnv,
    projectRoot,
    explicit,
    onWarning: (message) => log("warn", message),
  }).settings;

  // configOptions.projectRoot only picks the project for process-scoped knobs; per-view tuning uses the view workingDirectory.
  const processTuning = tuningFor(options.configOptions?.projectRoot ?? process.cwd());
  const runner = options.runner ?? createCopilotRunner({ concurrency: processTuning.concurrency });
  const cache = options.cache ??
    (processTuning.cacheMaxEntries > 0 ? new LruResultCache({ maxEntries: processTuning.cacheMaxEntries }) : undefined);
  const interceptors = new Map<string, ReadInterceptor>();
  const interceptorFor = (workingDirectory: string): ReadInterceptor => {
    let interceptor = interceptors.get(workingDirectory);
    if (!interceptor) {
      interceptor = new ReadInterceptor({
        runner,
        cache,
        modelResolver: selectorFor(workingDirectory).resolve,
        ...tuningToInterceptorOptions(tuningFor(workingDirectory)),
        maxFileBytes: options.maxFileBytes,
        maxRetries: options.maxRetries,
        retryDelayMs: options.retryDelayMs,
        ...(options.judge ? { judge: options.judge } : {}),
        logger: (event) => log(
          eventLogLevel(event),
          describeEvent(event),
          { ...event },
        ),
      });
      interceptors.set(workingDirectory, interceptor);
    }
    return interceptor;
  };

  return {
    setSession(nextSession) {
      session = nextSession;
    },

    async onUserPromptSubmitted(input) {
      try {
        const prompt = input.prompt.trim().slice(0, MAX_TASK_CHARS);
        if (!prompt) return;
        lastPrompt.delete(input.sessionId);
        lastPrompt.set(input.sessionId, prompt);
        if (lastPrompt.size > MAX_TRACKED_SESSIONS) {
          const oldest = lastPrompt.keys().next().value;
          if (oldest !== undefined) lastPrompt.delete(oldest);
        }
      } catch (error) {
        log("error", `prompt capture failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    async onPostToolUse(input: PostToolUseHookInput) {
      try {
        if (env.CONTEXT_LENS_CHILD === "1") return undefined;
        if (input.toolName !== "view") return undefined;
        if (!isRecord(input.toolArgs)) return undefined;
        const path = input.toolArgs.path;
        if (typeof path !== "string" || path.trim() === "") return undefined;
        if (input.toolResult?.resultType !== "success") return undefined;
        if (hasRangeArgument(input.toolArgs)) return undefined;
        if ((input.toolResult.toolTelemetry as { properties?: { viewType?: string } } | undefined)?.properties?.viewType === "directory") return undefined;

        const resolved = resolve(input.workingDirectory, path);
        try {
          if (statSync(resolved).isDirectory()) return undefined;
        } catch {
          // The interceptor will classify unreadable or missing files as a fallback.
        }

        const result = await interceptorFor(input.workingDirectory).intercept({
          filePath: resolved,
          projectRoot: input.workingDirectory,
          agentContext: { currentTask: lastPrompt.get(input.sessionId) },
        });
        if (!result.wasIntercepted || result.excerpts.length === 0) return undefined;
        const modifiedResult: CopilotToolResult = {
          ...input.toolResult,
          textResultForLlm: renderInterceptionResult(result, {
            displayPath: displayPathFor(path, input.workingDirectory),
            hint: COPILOT_HINT,
          }),
        };
        return { modifiedResult };
      } catch (error) {
        log("error", `view interception failed: ${error instanceof Error ? error.message : String(error)}`, {
          tool: input.toolName,
          sessionId: input.sessionId,
        });
        return undefined;
      }
    },
  };
}
