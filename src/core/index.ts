export { ReadInterceptor, eventLogLevel, estimateTokens } from "./interceptor.js";
export { renderInterceptionResult, HINT } from "./render.js";
export {
  createHostRuntime,
  createDiagnostics,
  explicitFromOptions,
  isRecord,
  errorMessage,
  validLine,
  describeEvent,
  displayPathFor,
} from "./host-runtime.js";
export type {
  HostRuntime,
  HostRuntimeOptions,
  HostTuningOptions,
  Diagnostics,
  DiagnosticsOptions,
  DiagnosticRecord,
  DiagnosticLevel,
} from "./host-runtime.js";
export { classifyDocument } from "./document.js";
export type { DocumentKind } from "./document.js";
export type { ContentReadRequest, InterceptOptions, InterceptionEvent, InterceptStats } from "./interceptor.js";
export { LruResultCache, PROMPT_VERSION, sha256, cacheKey } from "./cache.js";
export type { ResultCache, CacheKeyInput } from "./cache.js";
export type {
  AgentContext,
  ReadRequest,
  InterceptionResult,
  CheapModelResponse,
  SubagentAnswer,
  FileExcerpt,
  FallbackReason,
  JudgeOutcome,
} from "./models.js";
export {
  buildCheapModelPrompt,
  buildSubagentPrompt,
} from "./prompts.js";
export * from "./file-guard.js";
export {
  DEFAULT_PDF_MAX_CHARS,
  DEFAULT_PDF_TIMEOUT_MS,
  createPdftotextExtractor,
  readPdfDocument,
  normalizePdfText,
} from "./pdf.js";
export type { ExecFileLike, PdfExtraction, PdfExtractor } from "./pdf.js";
export * from "./transient.js";
export { resolveQuestion } from "./question.js";
export {
  getResponseObject,
  normalizeRanges,
  parseSubagentResult,
  sliceExcerpts,
} from "./parse.js";
export type { ExcerptRange, ParseOutcome } from "./parse.js";
export {
  DEFAULT_JUDGE_CONFIDENCE_THRESHOLD,
  JUDGE_SCHEMA,
  buildJudgePrompt,
  parseJudgeVerdict,
  shouldRunJudge,
} from "./judge.js";
export type { JudgeMode, JudgeOptions } from "./judge.js";
export { planChunks, mergeChunkAnswers } from "./chunking.js";
export type { ChunkAnswer, ChunkWindow } from "./chunking.js";
export { runChunkedRead, TimeoutError, NetworkError } from "./fanout.js";
export type { ChunkedOutcome } from "./fanout.js";
export {
  ConcurrencyLimitedRunner,
  SerialRunner,
  SUBAGENT_ANSWER_SCHEMA,
} from "./subagent.js";
export type {
  SubagentRunner,
  SubagentRequest,
  SubagentResult,
} from "./subagent.js";
export { FakeSubagentRunner } from "./fake-runner.js";
export type { FakeSubagentHandler } from "./fake-runner.js";
export {
  configPath,
  loadModelConfig,
  parseModelSpec,
  readConfigObject,
  saveModelConfig,
  validateModelChoice,
} from "./config.js";
export type {
  ConfigOptions,
  ConfigScope,
  ModelChoice,
  ModelSource,
  StoredModel,
} from "./config.js";
export { ModelSelector } from "./model-selector.js";
export type {
  ModelPicker,
  ModelPickResult,
  ModelSelectorOptions,
  ResolvedModel,
  ResolvedModelSource,
} from "./model-selector.js";
export {
  DEFAULT_TUNING,
  loadTuning,
  tuningToInterceptorOptions,
  TUNING_KEYS,
  isTuningKey,
  validateTuningValue,
} from "./tuning.js";
export type { TuningCheck, TuningKey, TuningOptions, TuningSettings, TuningSource } from "./tuning.js";
export { clearTuning, saveTuning } from "./tuning-write.js";
export {
  applyReset,
  applySet,
  CONTROL_USAGE,
  parseControlArgs,
  renderChange,
  renderStatus,
  RESTART_HINT,
  SOURCE_PRECEDENCE,
} from "./controls.js";
export type { ChangeResult, ControlAction } from "./controls.js";
export { buildStatus, statusConfigPaths } from "./status.js";
export type { ParadocStatus, StatusInput, StatusModelSource, TuningSourceMap } from "./status.js";
export { parseWebUrl, isBlockedAddress, maskUrl } from "./url-guard.js";
export { fetchWebDocument, DEFAULT_WEB_TIMEOUT_MS, DEFAULT_WEB_MAX_BYTES } from "./web-fetch.js";
export type { WebTransport, WebTransportRequest, WebTransportResponse, WebFetchOptions, WebFetchResult } from "./web-fetch.js";
export { htmlToText } from "./web-html.js";
export { readWebDocument } from "./web-document.js";
export type { WebReadResult } from "./web-document.js";
