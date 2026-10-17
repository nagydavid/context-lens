import { createHash } from "crypto";
import { resolve } from "path";
import { readTextFile, statFile } from "./file-guard.js";
import type {
  FallbackReason,
  InterceptionResult,
  ReadRequest,
  SubagentAnswer,
} from "./models.js";
import { normalizeRanges, parseSubagentResult, sliceExcerpts } from "./parse.js";
import type { ParseOutcome } from "./parse.js";
import { buildSubagentPrompt } from "./prompts.js";
import { resolveQuestion } from "./question.js";
import { SUBAGENT_ANSWER_SCHEMA } from "./subagent.js";
import { isTransientError } from "./transient.js";
import type { ResolvedModel, ResolvedModelSource } from "./model-selector.js";
import type { SubagentRunner } from "./subagent.js";

const DEFAULT_THRESHOLD_LINES = 350;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 100;
// Below this a delegation costs more than it saves, even past the line threshold.
const DEFAULT_MIN_TOKENS = 1_000;
// Long-line files (minified, generated) are intercepted on size even under the line threshold.
const DEFAULT_THRESHOLD_TOKENS = 8_000;
const DEFAULT_CACHE_SIZE = 64;

// ponytail: chars/4 is a lightweight estimate, not a tokenizer; swap one in only if the thresholds need precision.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Counters for one interceptor. Token figures are estimates (chars/4); counts and ms are measured. */
export interface InterceptStats {
  intercepted: number;
  passthrough: number;
  bypassed: number;
  fallbacks: number;
  cacheHits: number;
  delegations: number;
  delegationMs: number;
  estTokensSaved: number;
  estTokensDelegated: number;
}

export interface InterceptionEvent {
  filePath: string;
  lineCount: number;
  intercepted: boolean;
  elapsedMs?: number;
  confidence?: number;
  questionSource?: "explicit" | "inferred";
  fallbackReason?: FallbackReason;
  modelSource?: "explicit" | ResolvedModelSource | "none";
  detail?: string;
  fileBytes?: number;
  attempts?: number;
  cacheHit?: boolean;
  /** Estimated tokens kept out of the primary model's context. */
  estTokensSaved?: number;
  /** Estimated tokens sent to the cheap model (absent on cache hits). */
  estTokensDelegated?: number;
}

export interface InterceptOptions {
  maxFileBytes?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  runner?: SubagentRunner;
  thresholdLines?: number;
  /** Skip delegation under this estimated size even past thresholdLines. */
  minTokens?: number;
  /** Intercept at this estimated size even under thresholdLines. */
  thresholdTokens?: number;
  /** Max cached delegations (exact prompt+model match, in memory); 0 disables. */
  cacheSize?: number;
  timeoutMs?: number;
  model?: { providerID: string; modelID: string };
  modelResolver?: () => Promise<ResolvedModel | undefined>;
  logger?: (event: InterceptionEvent) => void;
}

class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Subagent timed out after ${timeoutMs}ms.`);
    this.name = "TimeoutError";
  }
}

class NetworkError extends Error {
  constructor(readonly retries: number, cause: unknown) {
    super(`network error after ${retries} retries: ${errorMessage(cause)}`);
    this.name = "NetworkError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ReadInterceptor {
  private readonly options: InterceptOptions;
  private readonly cache = new Map<string, SubagentAnswer>();
  private readonly counters: InterceptStats = {
    intercepted: 0,
    passthrough: 0,
    bypassed: 0,
    fallbacks: 0,
    cacheHits: 0,
    delegations: 0,
    delegationMs: 0,
    estTokensSaved: 0,
    estTokensDelegated: 0,
  };

  constructor(options: InterceptOptions = {}) {
    this.options = options;
  }

  stats(): InterceptStats {
    return { ...this.counters };
  }

  /** Harness adapters call this when they skip interception (ranged read, child session, ...). */
  noteBypass(): void {
    this.counters.bypassed++;
  }

  private record(event: InterceptionEvent): void {
    const c = this.counters;
    if (event.intercepted) {
      c.intercepted++;
      c.estTokensSaved += event.estTokensSaved ?? 0;
    } else if (event.fallbackReason) c.fallbacks++;
    else c.passthrough++;
    if (event.cacheHit) c.cacheHits++;
    else if (event.estTokensDelegated !== undefined) {
      c.delegations++;
      c.delegationMs += event.elapsedMs ?? 0;
      c.estTokensDelegated += event.estTokensDelegated;
    }
  }

  async intercept(request: ReadRequest): Promise<InterceptionResult> {
    const { filePath, agentContext, projectRoot } = request;
    let lineCount = 0;
    let event: InterceptionEvent = {
      filePath,
      lineCount,
      intercepted: false,
    };
    let modelResolved = false;
    let modelSource: "explicit" | ResolvedModelSource | "none" = "none";
    let modelResolutionDetail: string | undefined;

    try {
      const resolvedPath = this.resolvePath(filePath, projectRoot);
      const stat = statFile(resolvedPath, this.options.maxFileBytes);
      const read = stat.ok ? readTextFile(resolvedPath) : stat;
      if (!read.ok) {
        event = {
          filePath,
          lineCount: 0,
          intercepted: false,
          fallbackReason: read.reason,
          detail: read.detail,
          ...(read.size !== undefined ? { fileBytes: read.size } : {}),
        };
        return {
          filePath,
          fullLineCount: 0,
          wasIntercepted: false,
          excerpts: [],
          summary: "",
          totalLinesReturned: 0,
          contextSaved: 0,
          error: read.error,
          fallback: { reason: read.reason, detail: read.detail },
        };
      }
      const fileContent = read.content;
      const lines = fileContent.split("\n");
      lineCount = lines.length;
      const thresholdLines = this.options.thresholdLines ?? DEFAULT_THRESHOLD_LINES;

      // S03 decides whether requested ranges alter interception semantics.
      void request.startLine;
      void request.endLine;

      const fullFileResult = (
        reason?: FallbackReason,
        detail?: string,
        metadata: Partial<InterceptionResult> = {}
      ): InterceptionResult => ({
        filePath,
        fullLineCount: lineCount,
        wasIntercepted: false,
        excerpts: [{ startLine: 1, endLine: lineCount, content: fileContent }],
        summary: "",
        totalLinesReturned: lineCount,
        contextSaved: 0,
        ...(reason ? { fallback: { reason, ...(detail ? { detail } : {}) } } : {}),
        ...metadata,
      });

      const fileTokens = estimateTokens(fileContent);
      const eligible =
        fileTokens >= (this.options.thresholdTokens ?? DEFAULT_THRESHOLD_TOKENS) ||
        (lineCount > thresholdLines && fileTokens >= (this.options.minTokens ?? DEFAULT_MIN_TOKENS));
      if (!eligible) {
        const result = fullFileResult();
        event = { filePath, lineCount, intercepted: false };
        return result;
      }

      const resolvedQuestion = resolveQuestion(request.question, agentContext);
      const commonMetadata = {
        question: resolvedQuestion.question,
        questionSource: resolvedQuestion.source,
      } as const;

      if (!this.options.runner) {
        const result = fullFileResult("no-runner", undefined, commonMetadata);
        event = {
          filePath,
          lineCount,
          intercepted: false,
          questionSource: resolvedQuestion.source,
          fallbackReason: "no-runner",
        };
        return result;
      }

      let model: { providerID: string; modelID: string } | undefined;
      if (this.options.model) {
        model = this.options.model;
        modelSource = "explicit";
      } else if (this.options.modelResolver) {
        try {
          const resolvedModel = await this.options.modelResolver();
          if (resolvedModel) {
            model = {
              providerID: resolvedModel.choice.providerID,
              modelID: resolvedModel.choice.modelID,
            };
            modelSource = resolvedModel.source;
          }
        } catch (error: unknown) {
          modelResolutionDetail = `model resolution failed: ${errorMessage(error)}`;
        }
      }
      modelResolved = true;

      const prompt = buildSubagentPrompt({
        filePath,
        fileContent,
        question: resolvedQuestion.question,
        questionSource: resolvedQuestion.source,
        agentContext,
      });
      // The prompt embeds path, content, question and context, so prompt+model is the whole cache identity.
      const cacheKey = createHash("sha256")
        .update(`${model?.providerID}/${model?.modelID}\0${prompt}`)
        .digest("hex");
      const cached = this.cacheGet(cacheKey);
      const startedAt = performance.now();
      let elapsedMs: number;
      const attemptState = { attempts: 0 };
      const attemptsField = () =>
        attemptState.attempts > 1 ? { attempts: attemptState.attempts } : {};
      // Every attempt resends the complete prompt, so retries multiply the cheap-model input.
      const promptTokens = estimateTokens(prompt);
      const delegated = () =>
        cached
          ? { cacheHit: true }
          : { estTokensDelegated: promptTokens * Math.max(1, attemptState.attempts) };

      try {
        const response = cached ? undefined : await this.runWithTimeout(prompt, model, attemptState);
        elapsedMs = performance.now() - startedAt;
        const parsed: ParseOutcome = cached
          ? { ok: true, answer: cached }
          : parseSubagentResult(response!);
        if (!parsed.ok) {
          const result = fullFileResult(parsed.reason, parsed.detail, {
            ...commonMetadata,
            elapsedMs,
          });
          event = {
            filePath,
            lineCount,
            intercepted: false,
            elapsedMs,
            questionSource: resolvedQuestion.source,
            fallbackReason: parsed.reason,
            modelSource,
            ...delegated(),
            ...attemptsField(),
            detail: modelResolutionDetail ?? parsed.detail,
          };
          return result;
        }

        const ranges = normalizeRanges(parsed.answer.excerpts, lineCount);
        if (ranges.length === 0) {
          const result = fullFileResult("no-valid-excerpts", undefined, {
            ...commonMetadata,
            elapsedMs,
          });
          event = {
            filePath,
            lineCount,
            intercepted: false,
            elapsedMs,
            questionSource: resolvedQuestion.source,
            fallbackReason: "no-valid-excerpts",
            modelSource,
            ...delegated(),
            ...attemptsField(),
            ...(modelResolutionDetail ? { detail: modelResolutionDetail } : {}),
          };
          return result;
        }

        if (!cached) this.cacheSet(cacheKey, parsed.answer);
        const excerpts = sliceExcerpts(lines, ranges);
        const totalLinesReturned = excerpts.reduce(
          (sum, excerpt) => sum + excerpt.endLine - excerpt.startLine + 1,
          0
        );
        const result: InterceptionResult = {
          filePath,
          fullLineCount: lineCount,
          wasIntercepted: true,
          excerpts,
          summary: parsed.answer.summary,
          confidence: parsed.answer.confidence,
          ...commonMetadata,
          elapsedMs,
          totalLinesReturned,
          contextSaved: Math.round(
            ((lineCount - totalLinesReturned) / lineCount) * 100
          ),
        };
        event = {
          filePath,
          lineCount,
          intercepted: true,
          elapsedMs,
          confidence: parsed.answer.confidence,
          questionSource: resolvedQuestion.source,
          modelSource,
          estTokensSaved: Math.max(
            0,
            fileTokens -
              estimateTokens(
                excerpts.map((e) => e.content).join("\n") + parsed.answer.summary
              )
          ),
          ...delegated(),
          ...attemptsField(),
          ...(modelResolutionDetail ? { detail: modelResolutionDetail } : {}),
        };
        return result;
      } catch (error) {
        elapsedMs = performance.now() - startedAt;
        const isTimeout = error instanceof TimeoutError;
        const reason: FallbackReason = isTimeout
          ? "timeout"
          : error instanceof NetworkError
            ? "network-error"
            : "subagent-error";
        const detail = error instanceof Error ? error.message : String(error);
        const result = fullFileResult(reason, detail, {
          ...commonMetadata,
          elapsedMs,
        });
        event = {
          filePath,
          lineCount,
          intercepted: false,
          elapsedMs,
          questionSource: resolvedQuestion.source,
          fallbackReason: reason,
          modelSource,
          ...delegated(),
          ...attemptsField(),
          detail: modelResolutionDetail ?? detail,
        };
        return result;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      event = {
        filePath,
        lineCount,
        intercepted: false,
        fallbackReason: "unreadable",
        ...(modelResolved ? { modelSource } : {}),
        detail: modelResolutionDetail ?? detail,
      };
      return {
        filePath,
        fullLineCount: lineCount,
        wasIntercepted: false,
        excerpts: [],
        summary: "",
        totalLinesReturned: 0,
        contextSaved: 0,
        error: detail,
        fallback: { reason: "unreadable", detail },
      };
    } finally {
      this.record(event);
      try {
        this.options.logger?.(event);
      } catch {
        // Observability must not alter read behaviour.
      }
    }
  }

  private cacheGet(key: string): SubagentAnswer | undefined {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // refresh LRU position
      this.cache.set(key, hit);
    }
    return hit;
  }

  private cacheSet(key: string, answer: SubagentAnswer): void {
    const size = this.options.cacheSize ?? DEFAULT_CACHE_SIZE;
    if (size <= 0) return;
    this.cache.set(key, answer);
    if (this.cache.size > size) this.cache.delete(this.cache.keys().next().value!);
  }

  private resolvePath(filePath: string, projectRoot?: string): string {
    return resolve(projectRoot || process.cwd(), filePath);
  }

  private async runWithTimeout(
    prompt: string,
    model: { providerID: string; modelID: string } | undefined,
    state: { attempts: number },
  ) {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = Math.max(0, this.options.maxRetries ?? DEFAULT_MAX_RETRIES);
    const retryDelayMs = this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      for (let attempt = 1; ; attempt++) {
        state.attempts = attempt;
        try {
          return await this.options.runner!.run({
            prompt,
            schema: SUBAGENT_ANSWER_SCHEMA,
            timeoutMs: Math.max(1, deadline - Date.now()),
            model,
          });
        } catch (error) {
          if (!isTransientError(error)) throw error;
          if (attempt > maxRetries) {
            throw maxRetries > 0 ? new NetworkError(maxRetries, error) : error;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs * attempt));
        }
      }
    };
    const work = loop();
    // An abandoned loop may settle after the timeout wins the race.
    work.catch(() => undefined);
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * One-shot convenience: builds a fresh interceptor, so the cache and stats never outlive the call.
 * Hold a ReadInterceptor across reads (as the harness adapters do) to benefit from either.
 */
export async function interceptRead(
  request: ReadRequest,
  options?: InterceptOptions
): Promise<InterceptionResult> {
  return new ReadInterceptor(options).intercept(request);
}
