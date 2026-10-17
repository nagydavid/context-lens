import { resolve } from "path";
import { cacheKey, PROMPT_VERSION, sha256, type ResultCache } from "./cache.js";
import { planChunks } from "./chunking.js";
import { NetworkError, runChunkedRead, TimeoutError } from "./fanout.js";
import { readTextFile, statFile } from "./file-guard.js";
import type { FallbackReason, InterceptionResult, JudgeOutcome, ReadRequest } from "./models.js";
import { buildJudgePrompt, JUDGE_SCHEMA, parseJudgeVerdict, shouldRunJudge, type JudgeOptions } from "./judge.js";
import { normalizeRanges, parseSubagentResult, sliceExcerpts } from "./parse.js";
import { buildSubagentPrompt } from "./prompts.js";
import { resolveQuestion } from "./question.js";
import { SUBAGENT_ANSWER_SCHEMA } from "./subagent.js";
import { isTransientError } from "./transient.js";
import type { ResolvedModel, ResolvedModelSource } from "./model-selector.js";
import type { SubagentResult, SubagentRunner } from "./subagent.js";

const DEFAULT_THRESHOLD_LINES = 350;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 100;
// Below this a delegation costs more than it saves, even past the line threshold.
const DEFAULT_MIN_TOKENS = 1_000;
// Long-line files (minified, generated) are intercepted on size even under the line threshold.
const DEFAULT_THRESHOLD_TOKENS = 8_000;

type Model = { providerID: string; modelID: string } | undefined;

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
  chunks?: number;
  judge?: JudgeOutcome;
  cacheHit?: boolean;
  /** Estimated tokens kept out of the primary model's context. */
  estTokensSaved?: number;
  /** Estimated tokens sent to the cheap model (absent on cache hits). */
  estTokensDelegated?: number;
}

export function eventLogLevel(event: InterceptionEvent): "info" | "warn" | "debug" {
  if (event.judge?.error) return "warn";
  if (event.intercepted) return "info";
  if (event.fallbackReason) return "warn";
  return "debug";
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
  timeoutMs?: number;
  chunkLines?: number;
  chunkOverlapLines?: number;
  model?: Model;
  modelResolver?: () => Promise<ResolvedModel | undefined>;
  logger?: (event: InterceptionEvent) => void;
  judge?: JudgeOptions;
  cache?: ResultCache;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ReadInterceptor {
  private readonly options: InterceptOptions;
  private readonly inflight = new Map<string, Promise<InterceptionResult>>();
  private readonly counters: InterceptStats = {
    intercepted: 0, passthrough: 0, bypassed: 0, fallbacks: 0, cacheHits: 0,
    delegations: 0, delegationMs: 0, estTokensSaved: 0, estTokensDelegated: 0,
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
    let event: InterceptionEvent = { filePath, lineCount, intercepted: false };
    let modelResolved = false;
    let modelSource: "explicit" | ResolvedModelSource | "none" = "none";
    let modelResolutionDetail: string | undefined;

    try {
      const resolvedPath = this.resolvePath(filePath, projectRoot);
      const stat = statFile(resolvedPath, this.options.maxFileBytes);
      const read = stat.ok ? readTextFile(resolvedPath) : stat;
      if (!read.ok) {
        event = { filePath, lineCount: 0, intercepted: false, fallbackReason: read.reason, detail: read.detail, ...(read.size !== undefined ? { fileBytes: read.size } : {}) };
        return { filePath, fullLineCount: 0, wasIntercepted: false, excerpts: [], summary: "", totalLinesReturned: 0, contextSaved: 0, error: read.error, fallback: { reason: read.reason, detail: read.detail } };
      }
      const fileContent = read.content;
      const lines = fileContent.split("\n");
      lineCount = lines.length;
      const fullFileResult = (reason?: FallbackReason, detail?: string, metadata: Partial<InterceptionResult> = {}): InterceptionResult => ({
        filePath, fullLineCount: lineCount, wasIntercepted: false,
        excerpts: [{ startLine: 1, endLine: lineCount, content: fileContent }],
        summary: "", totalLinesReturned: lineCount, contextSaved: 0,
        ...(reason ? { fallback: { reason, ...(detail ? { detail } : {}) } } : {}), ...metadata,
      });

      const fileTokens = estimateTokens(fileContent);
      const eligible =
        fileTokens >= (this.options.thresholdTokens ?? DEFAULT_THRESHOLD_TOKENS) ||
        (lineCount > (this.options.thresholdLines ?? DEFAULT_THRESHOLD_LINES) && fileTokens >= (this.options.minTokens ?? DEFAULT_MIN_TOKENS));
      if (!eligible) {
        event = { filePath, lineCount, intercepted: false };
        return fullFileResult();
      }
      // S03 decides whether requested ranges alter interception semantics.
      void request.startLine;
      void request.endLine;
      const resolvedQuestion = resolveQuestion(request.question, agentContext);
      const commonMetadata = { question: resolvedQuestion.question, questionSource: resolvedQuestion.source } as const;
      if (!this.options.runner) {
        event = { filePath, lineCount, intercepted: false, questionSource: resolvedQuestion.source, fallbackReason: "no-runner" };
        return fullFileResult("no-runner", undefined, commonMetadata);
      }

      let model: Model;
      if (this.options.model) {
        model = this.options.model;
        modelSource = "explicit";
      } else if (this.options.modelResolver) {
        try {
          const resolvedModel = await this.options.modelResolver();
          if (resolvedModel) {
            model = { providerID: resolvedModel.choice.providerID, modelID: resolvedModel.choice.modelID };
            modelSource = resolvedModel.source;
          }
        } catch (error) {
          modelResolutionDetail = `model resolution failed: ${errorMessage(error)}`;
        }
      }
      modelResolved = true;
      const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const windows = planChunks(lineCount, { chunkLines: this.options.chunkLines ?? 0, overlapLines: this.options.chunkOverlapLines ?? 0 });
      const chunked = Number.isFinite(this.options.chunkLines) && Number.isInteger(this.options.chunkLines) && this.options.chunkLines! >= 1 && windows.length > 1;
      const cache = this.options.cache;
      let key = "";
      const lookupStart = performance.now();
      const savedTokens = (r: InterceptionResult) =>
        Math.max(0, fileTokens - estimateTokens(r.excerpts.map((e) => e.content).join("\n") + r.summary));
      const serveShared = (hit: InterceptionResult): InterceptionResult => {
        const elapsedMs = performance.now() - lookupStart;
        const { attempts: _attempts, ...rest } = hit;
        event = {
          filePath, lineCount, intercepted: true, elapsedMs, confidence: hit.confidence, questionSource: resolvedQuestion.source, modelSource,
          estTokensSaved: savedTokens(hit),
          ...(hit.chunks !== undefined ? { chunks: hit.chunks } : {}), ...(hit.judge ? { judge: hit.judge } : {}),
          ...(modelResolutionDetail ? { detail: modelResolutionDetail } : {}), cacheHit: true,
        };
        return { ...rest, filePath, cacheHit: true, elapsedMs };
      };
      if (cache) {
        let hit: InterceptionResult | undefined;
        try {
          key = cacheKey({
            contentSha256: sha256(fileContent), question: resolvedQuestion.question, model, promptVersion: PROMPT_VERSION,
            chunkLines: chunked ? this.options.chunkLines : 0, chunkOverlapLines: chunked ? (this.options.chunkOverlapLines ?? 0) : 0,
            judgeMode: this.options.judge?.mode ?? "off",
          });
          hit = cache.get(key);
        } catch { hit = undefined; }
        if (hit) return serveShared(hit);
        // A concurrent identical read joins the in-flight one. If that one does not produce a
        // cacheable result, fall through and run our own.
        const leader = key ? this.inflight.get(key) : undefined;
        if (leader) {
          const shared = await leader.catch(() => undefined);
          if (shared?.wasIntercepted && !shared.judge?.error) return serveShared(shared);
        }
      }
      const setEvent = (next: InterceptionEvent) => { event = next; };
      const usage = { tokens: 0 };
      const compute = (): Promise<InterceptionResult> => chunked
        ? this.interceptChunks({ filePath, fileContent, lines, windows, model, modelSource, modelResolutionDetail, resolvedQuestion, agentContext, commonMetadata, fullFileResult, timeoutMs, setEvent, usage })
        : this.interceptSingle({ filePath, fileContent, lines, model, modelSource, modelResolutionDetail, resolvedQuestion, agentContext, commonMetadata, fullFileResult, timeoutMs, setEvent, usage });
      let result: InterceptionResult;
      if (cache && key && !this.inflight.has(key)) {
        const pending = compute();
        this.inflight.set(key, pending);
        try { result = await pending; } finally { this.inflight.delete(key); }
      } else {
        result = await compute();
      }
      event = {
        ...event,
        ...(event.intercepted ? { estTokensSaved: savedTokens(result) } : {}),
        ...(usage.tokens > 0 ? { estTokensDelegated: usage.tokens } : {}),
      };
      if (cache && key && result.wasIntercepted && !result.judge?.error) {
        const { cacheHit: _c, elapsedMs: _e, attempts: _a, ...stripped } = result;
        try { cache.set(key, stripped); } catch { /* cache is best-effort */ }
      }
      return result;
    } catch (error) {
      const detail = errorMessage(error);
      event = { filePath, lineCount, intercepted: false, fallbackReason: "unreadable", ...(modelResolved ? { modelSource } : {}), detail: modelResolutionDetail ?? detail };
      return { filePath, fullLineCount: lineCount, wasIntercepted: false, excerpts: [], summary: "", totalLinesReturned: 0, contextSaved: 0, error: detail, fallback: { reason: "unreadable", detail } };
    } finally {
      this.record(event);
      try { this.options.logger?.(event); } catch { /* observability is non-fatal */ }
    }
  }

  private async interceptChunks(args: InterceptArgs & { windows: ReturnType<typeof planChunks> }): Promise<InterceptionResult> {
    const { filePath, fileContent, lines, windows, model, modelSource, modelResolutionDetail, resolvedQuestion, commonMetadata, fullFileResult, timeoutMs, setEvent } = args;
    const startedAt = performance.now();
    const deadline = Date.now() + timeoutMs;
    const outcome = await runChunkedRead({
      lines, windows,
      buildPrompt: (window) => {
        const prompt = buildSubagentPrompt({ filePath, fileContent, question: resolvedQuestion.question, questionSource: resolvedQuestion.source, agentContext: args.agentContext, window });
        args.usage.tokens += estimateTokens(prompt); // ponytail: chunk retries not counted
        return prompt;
      },
      run: (prompt, state, isAborted) => this.runWithDeadline(prompt, model, state, deadline, timeoutMs, isAborted),
    });
    const elapsedMs = performance.now() - startedAt;
    const attempts = outcome.attempts > 1 ? { attempts: outcome.attempts } : {};
    if (!outcome.ok) {
      const detail = modelResolutionDetail ? `${modelResolutionDetail}; ${outcome.detail}` : outcome.detail;
      const result = fullFileResult(outcome.reason, outcome.detail, { ...commonMetadata, elapsedMs, ...attempts, chunks: windows.length });
      setEvent({ filePath, lineCount: lines.length, intercepted: false, elapsedMs, questionSource: resolvedQuestion.source, fallbackReason: outcome.reason, modelSource, ...attempts, chunks: windows.length, detail });
      return result;
    }
    const excerpts = sliceExcerpts(lines, outcome.merged.ranges);
    const totalLinesReturned = countExcerptLines(excerpts);
    const result: InterceptionResult = { filePath, fullLineCount: lines.length, wasIntercepted: true, excerpts, summary: outcome.merged.summary, confidence: outcome.merged.confidence, ...commonMetadata, elapsedMs, totalLinesReturned, contextSaved: contextSaved(lines.length, totalLinesReturned), ...attempts, chunks: windows.length };
    const event: InterceptionEvent = { filePath, lineCount: lines.length, intercepted: true, elapsedMs, confidence: outcome.merged.confidence, questionSource: resolvedQuestion.source, modelSource, ...attempts, chunks: windows.length, ...(modelResolutionDetail ? { detail: modelResolutionDetail } : {}) };
    return this.applyJudge(args, { result, event });
  }

  private async interceptSingle(args: InterceptArgs): Promise<InterceptionResult> {
    const { filePath, fileContent, lines, model, modelSource, modelResolutionDetail, resolvedQuestion, commonMetadata, fullFileResult, timeoutMs, setEvent } = args;
    const prompt = buildSubagentPrompt({ filePath, fileContent, question: resolvedQuestion.question, questionSource: resolvedQuestion.source, agentContext: args.agentContext });
    const startedAt = performance.now();
    const state = { attempts: 0 };
    const attempts = () => state.attempts > 1 ? { attempts: state.attempts } : {};
    try {
      const response = await this.runWithDeadline(prompt, model, state, Date.now() + timeoutMs, timeoutMs);
      const elapsedMs = performance.now() - startedAt;
      const parsed = parseSubagentResult(response);
      if (!parsed.ok) return this.singleFallback(parsed.reason, parsed.detail, args, elapsedMs, attempts());
      const ranges = normalizeRanges(parsed.answer.excerpts, lines.length);
      if (!ranges.length) return this.singleFallback("no-valid-excerpts", undefined, args, elapsedMs, attempts());
      const excerpts = sliceExcerpts(lines, ranges);
      const totalLinesReturned = countExcerptLines(excerpts);
      const result: InterceptionResult = { filePath, fullLineCount: lines.length, wasIntercepted: true, excerpts, summary: parsed.answer.summary, confidence: parsed.answer.confidence, ...commonMetadata, elapsedMs, totalLinesReturned, contextSaved: contextSaved(lines.length, totalLinesReturned), ...attempts() };
      const event: InterceptionEvent = { filePath, lineCount: lines.length, intercepted: true, elapsedMs, confidence: parsed.answer.confidence, questionSource: resolvedQuestion.source, modelSource, ...attempts(), ...(modelResolutionDetail ? { detail: modelResolutionDetail } : {}) };
      return this.applyJudge(args, { result, event });
    } catch (error) {
      const reason: FallbackReason = error instanceof TimeoutError ? "timeout" : error instanceof NetworkError ? "network-error" : "subagent-error";
      return this.singleFallback(reason, errorMessage(error), args, performance.now() - startedAt, attempts());
    } finally {
      // Every attempt resends the complete prompt, so retries multiply the cheap-model input.
      args.usage.tokens += estimateTokens(prompt) * Math.max(1, state.attempts);
    }
  }

  private singleFallback(reason: FallbackReason, detail: string | undefined, args: InterceptArgs, elapsedMs: number, attempts: { attempts?: number }): InterceptionResult {
    const { filePath, lines, modelSource, modelResolutionDetail, resolvedQuestion, commonMetadata, fullFileResult, setEvent } = args;
    const result = fullFileResult(reason, detail, { ...commonMetadata, elapsedMs });
    setEvent({ filePath, lineCount: lines.length, intercepted: false, elapsedMs, questionSource: resolvedQuestion.source, fallbackReason: reason, modelSource, ...attempts, ...(modelResolutionDetail ? { detail: modelResolutionDetail } : detail ? { detail } : {}) });
    return result;
  }

  private async applyJudge(args: InterceptArgs, success: { result: InterceptionResult; event: InterceptionEvent }): Promise<InterceptionResult> {
    const { result, event } = success;
    if (!shouldRunJudge(this.options.judge, result.confidence)) {
      args.setEvent(event);
      return result;
    }

    const configuredTimeout = this.options.judge?.timeoutMs;
    const judgeTimeout = Number.isFinite(configuredTimeout) && configuredTimeout! > 0
      ? configuredTimeout!
      : args.timeoutMs;
    const startedAt = performance.now();
    let judge: JudgeOutcome;
    try {
      const response = await this.runWithDeadline(
        buildJudgePrompt({ question: args.resolvedQuestion.question, excerpts: result.excerpts, summary: result.summary }),
        args.model,
        { attempts: 0 },
        Date.now() + judgeTimeout,
        judgeTimeout,
        undefined,
        JUDGE_SCHEMA,
      );
      const parsed = parseJudgeVerdict(response);
      const elapsedMs = performance.now() - startedAt;
      if (!parsed.ok) {
        judge = { elapsedMs, error: parsed.detail };
      } else {
        judge = { verdict: parsed.verdict, elapsedMs };
        if (parsed.verdict === "insufficient") {
          const detail = parsed.reason ?? "judge returned insufficient";
          const fallback = args.fullFileResult("judge-rejected", parsed.reason, {
            ...args.commonMetadata, elapsedMs: result.elapsedMs,
            ...(result.attempts ? { attempts: result.attempts } : {}),
            ...(result.chunks !== undefined ? { chunks: result.chunks } : {}), judge,
          });
          args.setEvent({ filePath: args.filePath, lineCount: args.lines.length, intercepted: false, elapsedMs: result.elapsedMs, questionSource: args.resolvedQuestion.source, fallbackReason: "judge-rejected", modelSource: args.modelSource, ...(result.attempts ? { attempts: result.attempts } : {}), ...(result.chunks !== undefined ? { chunks: result.chunks } : {}), judge, detail });
          return fallback;
        }
      }
    } catch (error) {
      judge = { elapsedMs: performance.now() - startedAt, error: errorMessage(error) };
    }
    const judged = { ...result, judge };
    args.setEvent({ ...event, judge });
    return judged;
  }

  private async runWithDeadline(prompt: string, model: Model, state: { attempts: number }, deadline: number, timeoutMs: number, isAborted = () => false, schema: Record<string, unknown> = SUBAGENT_ANSWER_SCHEMA): Promise<SubagentResult> {
    const maxRetries = Math.max(0, this.options.maxRetries ?? DEFAULT_MAX_RETRIES);
    const retryDelayMs = this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      for (let attempt = 1; ; attempt++) {
        if (Date.now() >= deadline || isAborted()) throw new TimeoutError(timeoutMs);
        state.attempts = attempt;
        try {
          return await this.options.runner!.run({ prompt, schema, timeoutMs: Math.max(1, deadline - Date.now()), model });
        } catch (error) {
          if (!isTransientError(error)) throw error;
          if (attempt > maxRetries) throw maxRetries > 0 ? new NetworkError(maxRetries, error) : error;
          if (Date.now() >= deadline || isAborted()) throw new TimeoutError(timeoutMs);
          await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs * attempt));
        }
      }
    };
    const work = loop();
    work.catch(() => undefined);
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), Math.max(0, deadline - Date.now())); })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private resolvePath(filePath: string, projectRoot?: string): string { return resolve(projectRoot || process.cwd(), filePath); }
}

interface InterceptArgs {
  filePath: string;
  fileContent: string;
  lines: string[];
  model: Model;
  modelSource: "explicit" | ResolvedModelSource | "none";
  modelResolutionDetail?: string;
  resolvedQuestion: ReturnType<typeof resolveQuestion>;
  agentContext: ReadRequest["agentContext"];
  commonMetadata: { question: string; questionSource: "explicit" | "inferred" };
  fullFileResult: (reason?: FallbackReason, detail?: string, metadata?: Partial<InterceptionResult>) => InterceptionResult;
  timeoutMs: number;
  setEvent: (event: InterceptionEvent) => void;
  usage: { tokens: number };
}

function countExcerptLines(excerpts: InterceptionResult["excerpts"]): number { return excerpts.reduce((sum, excerpt) => sum + excerpt.endLine - excerpt.startLine + 1, 0); }
function contextSaved(lineCount: number, returned: number): number { return Math.round(((lineCount - returned) / lineCount) * 100); }

export { TimeoutError, NetworkError } from "./fanout.js";
export async function interceptRead(request: ReadRequest, options?: InterceptOptions): Promise<InterceptionResult> { return new ReadInterceptor(options).intercept(request); }
