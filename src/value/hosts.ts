/**
 * Host drivers for the value harness.
 *
 * Every corpus item is run twice: once "natively" (the text the host would show the model with no
 * ParaDoc at all) and once through each host's real interception surface. All three hosts are driven
 * through their public entry points — `tool.execute.after`, `onPostToolUse` and the MCP JSON-RPC
 * handler — so the numbers measure the shipped adapters, not a reimplementation of them.
 *
 * Host surfaces (verified against source):
 *   opencode      createParaDocHooks  -> hooks["tool.execute.after"] mutating output.output
 *   copilot-hooks createCopilotHooks  -> onPostToolUse(buildViewInput(...)) -> modifiedResult
 *   copilot-mcp   createMcpServer     -> handleMessage tools/call paradoc_read | paradoc_web_read
 *
 * Web reads exist only on the MCP host: OpenCode and Copilot hooks intercept file views only.
 */
import { readFileSync } from "node:fs";
import { createParaDocHooks, type ParaDocClient } from "../opencode/hooks.js";
import { createCopilotHooks } from "../copilot-cli/hooks.js";
import { createMcpServer } from "../copilot-cli/mcp-server.js";
import { buildViewInput } from "../copilot-cli/probe-fixture.js";
import type { InterceptStats, InterceptionEvent } from "../core/interceptor.js";
import type { FallbackReason } from "../core/models.js";
import type { ResultCache } from "../core/cache.js";
import type { JudgeMode } from "../core/judge.js";
import type { SubagentRunner } from "../core/subagent.js";
import { DEFAULT_PDF_MAX_CHARS, createPdftotextExtractor, readPdfDocument } from "../core/pdf.js";
import { htmlToText } from "../core/web-html.js";
import { maskUrl } from "../core/url-guard.js";
import type { WebFetchOptions } from "../core/web-fetch.js";
import type { CorpusItem, CorpusTuning, FileCorpusItem, SourceType, WebCorpusItem } from "./corpus.js";

export type HostName = "opencode" | "copilot-hooks" | "copilot-mcp";

export const HOST_NAMES: readonly HostName[] = ["opencode", "copilot-hooks", "copilot-mcp"];

/**
 * Host x source-type matrix. OpenCode and Copilot hooks never see a web read, so web items are only
 * measurable on the MCP host; the harness records that instead of pretending the row is zero.
 */
export const HOST_TYPE_MATRIX: Record<HostName, readonly SourceType[]> = {
  opencode: ["source", "text-document", "pdf-text"],
  "copilot-hooks": ["source", "text-document", "pdf-text"],
  "copilot-mcp": ["source", "text-document", "pdf-text", "web-page"],
};

/** One parsed host diagnostics record: { level, message, ...InterceptionEvent, stats }. */
export interface HostDiagnosticRecord {
  level: string;
  message: string;
  event?: InterceptionEvent;
  stats?: InterceptStats;
}

export interface HostRunOptions {
  item: FileCorpusItem | WebCorpusItem;
  /** Fresh runner for this run only, so runs never share model state. */
  runner: SubagentRunner;
  /** Fresh cache for this run only. */
  cache?: ResultCache;
  /** Corpus temp dir: used as homeDir, projectRoot and cwd (never process.cwd()). */
  dir: string;
  /** Simulated model latency, forwarded to the runner factory by the caller. */
  latencyMs?: number;
  /** Interceptor deadline for this run. */
  timeoutMs?: number;
  /** Judge mode override. */
  judge?: JudgeMode;
}

export interface HostRunResult {
  host: HostName;
  /** Text the host would show the model with no ParaDoc at all. */
  nativeText: string;
  /** Text the host actually shows after the hook/tool ran. */
  renderedText: string;
  /** Raw HTML size for web items (the native baseline is the converted text). */
  nativeRawHtmlChars?: number;
  /** True when the host replaced its own output (hooks hosts) or returned a ParaDoc payload (MCP). */
  changed: boolean;
  /** Interception outcome as the interceptor itself reported it. */
  wasIntercepted: boolean;
  /** Fallback reason from the interception event. */
  fallbackReason: FallbackReason | null;
  /** Fallback reason as the host delivered it (MCP only; hooks never surface one). */
  resultFallbackReason: FallbackReason | null;
  diagnostics: HostDiagnosticRecord[];
  stats?: InterceptStats;
  event?: InterceptionEvent;
  /** Subagent calls the host actually made. */
  calls: number;
}

export interface Host {
  name: HostName;
  supports(item: CorpusItem): boolean;
  run(options: HostRunOptions): Promise<HostRunResult>;
}

/** Knobs a host adapter accepts directly, versus those only the tuning env layer can carry. */
export interface ItemTuning {
  options: {
    thresholdLines?: number;
    timeoutMs?: number;
    chunkLines?: number;
    chunkOverlapLines?: number;
    maxFileBytes?: number;
    judge?: { mode: JudgeMode };
  };
  /** MEM091: minTokens/thresholdTokens/pdfMaxChars/pdfTimeoutMs are tuning-only. */
  env: Record<string, string>;
}

export function tuningForItem(item: CorpusItem, tuning: CorpusTuning | undefined = item.tuning): ItemTuning {
  const t = tuning ?? {};
  const options: ItemTuning["options"] = {};
  if (t.thresholdLines !== undefined) options.thresholdLines = t.thresholdLines;
  if (t.chunkLines !== undefined) options.chunkLines = t.chunkLines;
  if (t.chunkOverlapLines !== undefined) options.chunkOverlapLines = t.chunkOverlapLines;
  if (t.maxFileBytes !== undefined) options.maxFileBytes = t.maxFileBytes;
  if (t.judge !== undefined) options.judge = { mode: t.judge };
  const env: Record<string, string> = {};
  if (t.minTokens !== undefined) env.PARADOC_MIN_TOKENS = String(t.minTokens);
  if (t.thresholdTokens !== undefined) env.PARADOC_THRESHOLD_TOKENS = String(t.thresholdTokens);
  if (t.pdfMaxChars !== undefined) env.PARADOC_PDF_MAX_CHARS = String(t.pdfMaxChars);
  if (t.pdfTimeoutMs !== undefined) env.PARADOC_PDF_TIMEOUT_MS = String(t.pdfTimeoutMs);
  return { options, env };
}

/**
 * The unmodified host output for an item: file contents as the host would return them, the extracted
 * PDF text for PDFs (a host that reads a PDF at all shows extracted text), and the converted page
 * text for web pages. Missing or unreadable files have no native text.
 */
export async function nativeTextFor(item: FileCorpusItem | WebCorpusItem): Promise<{ text: string; rawHtmlChars?: number }> {
  if (item.kind === "web") {
    // Mirror the document the MCP host actually serves for a page: htmlToText output plus the
    // provenance header readWebDocument prepends (`# <title>`, `Source: <masked url>`, blank).
    // Without the same header the native baseline and the host reply are different documents and
    // containment could not be compared at all.
    const url = new URL(item.url);
    const converted = htmlToText(item.html, { baseUrl: url });
    const header = [...(converted.title ? [`# ${converted.title}`] : []), `Source: ${maskUrl(url)}`, ""];
    const lines = [...header, ...converted.text.split("\n")];
    if (lines.at(-1) === "") lines.pop();
    return { text: lines.join("\n"), rawHtmlChars: item.html.length };
  }
  if (item.sourceType === "pdf-text") {
    const read = await readPdfDocument(item.path, {
      extractor: item.pdfExtractor ?? createPdftotextExtractor(),
      maxChars: DEFAULT_PDF_MAX_CHARS,
    });
    return { text: read.ok ? read.content : "" };
  }
  try {
    return { text: readFileSync(item.path, "utf8") };
  } catch {
    return { text: "" };
  }
}

function toDiagnostic(input: Record<string, unknown>): HostDiagnosticRecord {
  const record = { ...input };
  const level = record.level;
  const message = record.message;
  const stats = record.stats as InterceptStats | undefined;
  delete record.level;
  delete record.message;
  delete record.stats;
  const event = typeof record.filePath === "string" && typeof record.intercepted === "boolean" ? (record as unknown as InterceptionEvent) : undefined;
  return {
    level: String(level ?? ""),
    message: String(message ?? ""),
    ...(event ? { event } : {}),
    ...(stats ? { stats } : {}),
  };
}

function lastEvent(diagnostics: HostDiagnosticRecord[]): InterceptionEvent | undefined {
  for (let i = diagnostics.length - 1; i >= 0; i--) {
    const event = diagnostics[i].event;
    if (event) return event;
  }
  return undefined;
}

function lastStats(diagnostics: HostDiagnosticRecord[]): InterceptStats | undefined {
  for (let i = diagnostics.length - 1; i >= 0; i--) {
    const stats = diagnostics[i].stats;
    if (stats) return stats;
  }
  return undefined;
}

function runnerCalls(runner: SubagentRunner): number {
  const calls = (runner as { calls?: unknown[] }).calls;
  return Array.isArray(calls) ? calls.length : 0;
}

/** `[paradoc] fallback: <reason>` (interception-stage fallback) or `paradoc: <error> (<reason>):` (guard failure). */
export function parseToolFallback(text: string): FallbackReason | null {
  const fallback = /^\[paradoc\] fallback: ([a-z-]+)/.exec(text);
  if (fallback) return fallback[1] as FallbackReason;
  const guard = /^paradoc: [^\n]*? \(([a-z-]+)\):/.exec(text);
  if (guard) return guard[1] as FallbackReason;
  return null;
}

function baseResult(host: HostName, options: HostRunOptions, diagnostics: HostDiagnosticRecord[]) {
  const event = lastEvent(diagnostics);
  return {
    host,
    diagnostics,
    event,
    stats: lastStats(diagnostics),
    wasIntercepted: event?.intercepted ?? false,
    fallbackReason: event?.fallbackReason ?? null,
    calls: runnerCalls(options.runner),
  };
}

function webFetchOptionsFor(item: FileCorpusItem | WebCorpusItem): WebFetchOptions | undefined {
  if (item.kind !== "web") return undefined;
  return {
    transport: item.transport,
    resolveHost: item.resolveHost,
    ...(item.tuning?.webMaxBytes !== undefined ? { maxBytes: item.tuning.webMaxBytes } : {}),
    ...(item.tuning?.webMaxRedirects !== undefined ? { maxRedirects: item.tuning.webMaxRedirects } : {}),
  };
}

// ── OpenCode hooks ──────────────────────────────────────────────────────────

async function runOpenCode(options: HostRunOptions): Promise<HostRunResult> {
  const item = options.item as FileCorpusItem;
  const tuning = tuningForItem(item);
  const entries: Array<{ body: { level: string; message: string; extra?: Record<string, unknown> } }> = [];
  // Stub client shaped exactly like the live OpenCode client used by host-parity tests.
  const client = {
    session: { create: async () => ({}), prompt: async () => ({}), delete: async () => ({}) },
    app: { log: async (entry: (typeof entries)[number]) => { entries.push(entry); } },
  } as unknown as ParaDocClient;

  const hooks = createParaDocHooks({
    client,
    directory: options.dir,
    runner: options.runner,
    configOptions: { homeDir: options.dir, env: tuning.env },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.judge ? { judge: { mode: options.judge } } : {}),
    ...tuning.options,
    ...(options.cache ? { cache: options.cache } : {}),
    ...(item.pdfExtractor ? { pdfExtractor: item.pdfExtractor } : {}),
  });

  const native = await nativeTextFor(item);
  const out = { title: item.path, output: native.text, metadata: {} };
  const args: Record<string, unknown> = { filePath: item.path };
  if (item.ranged) {
    args.offset = item.ranged.startLine - 1;
    args.limit = item.ranged.endLine - item.ranged.startLine + 1;
  }
  await hooks["tool.execute.after"]({ tool: "read", sessionID: "value-harness", callID: "value-call", args }, out);

  const diagnostics = entries.map((entry) => toDiagnostic({ level: entry.body.level, message: entry.body.message, ...(entry.body.extra ?? {}) }));
  const base = baseResult("opencode", options, diagnostics);
  return {
    ...base,
    nativeText: native.text,
    renderedText: out.output,
    changed: out.output !== native.text,
    // Hooks never replace the host output on a guard failure or a fallback: the native text is intact.
    resultFallbackReason: null,
  };
}

// ── Copilot hooks ───────────────────────────────────────────────────────────

async function runCopilotHooks(options: HostRunOptions): Promise<HostRunResult> {
  const item = options.item as FileCorpusItem;
  const tuning = tuningForItem(item);
  const records: Record<string, unknown>[] = [];
  const hooks = createCopilotHooks({
    runner: options.runner,
    env: {},
    configOptions: { homeDir: options.dir, env: tuning.env, projectRoot: options.dir },
    logSink: (_line, record) => {
      records.push(record as Record<string, unknown>);
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.judge ? { judge: { mode: options.judge } } : {}),
    ...tuning.options,
    ...(options.cache ? { cache: options.cache } : {}),
    ...(item.pdfExtractor ? { pdfExtractor: item.pdfExtractor } : {}),
  });

  const native = await nativeTextFor(item);
  const toolArgs: Record<string, unknown> = { path: item.path };
  if (item.ranged) toolArgs.view_range = [item.ranged.startLine, item.ranged.endLine];
  const result = await hooks.onPostToolUse(
    buildViewInput({ path: item.path, workingDirectory: options.dir, text: native.text, toolArgs }),
  );
  const rendered = result?.modifiedResult?.textResultForLlm;
  const diagnostics = records.map(toDiagnostic);
  const base = baseResult("copilot-hooks", options, diagnostics);
  return {
    ...base,
    nativeText: native.text,
    renderedText: rendered ?? native.text,
    changed: rendered !== undefined,
    resultFallbackReason: null,
  };
}

// ── Copilot MCP server ──────────────────────────────────────────────────────

async function runCopilotMcp(options: HostRunOptions): Promise<HostRunResult> {
  const item = options.item;
  const tuning = tuningForItem(item);
  const webFetchOptions = webFetchOptionsFor(item);
  const lines: string[] = [];
  const server = createMcpServer({
    runner: options.runner,
    cwd: options.dir,
    env: {},
    configOptions: { homeDir: options.dir, env: tuning.env },
    stderr: (line) => {
      lines.push(line);
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.judge ? { judge: { mode: options.judge } } : {}),
    ...tuning.options,
    ...(options.cache ? { cache: options.cache } : {}),
    ...(item.kind === "file" && item.pdfExtractor ? { pdfExtractor: item.pdfExtractor } : {}),
    ...(webFetchOptions ? { webFetchOptions } : {}),
  });

  const native = await nativeTextFor(item);
  const args: Record<string, unknown> = { question: item.question };
  if (item.kind === "web") args.url = item.url;
  else args.path = item.path;
  if (item.ranged) {
    args.start_line = item.ranged.startLine;
    args.end_line = item.ranged.endLine;
  }
  const response = await server.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: item.kind === "web" ? "paradoc_web_read" : "paradoc_read", arguments: args },
  });
  const tool = (response as { result?: { content?: Array<{ text?: string }>; isError?: boolean } } | undefined)?.result;
  const rendered = tool?.content?.[0]?.text ?? "";
  const diagnostics = lines.map((line) => toDiagnostic(parseDiagnosticLine(line) ?? { level: "debug", message: line }));
  const base = baseResult("copilot-mcp", options, diagnostics);
  return {
    ...base,
    nativeText: native.text,
    nativeRawHtmlChars: native.rawHtmlChars,
    renderedText: rendered,
    changed: true,
    // The MCP tool names the reason it failed; hooks do not surface one at all.
    resultFallbackReason: parseToolFallback(rendered),
  };
}

/** Diagnostics arrive to the MCP server as the byte-stable text line `[paradoc] <level>: <message> <json>`. */
function parseDiagnosticLine(line: string): Record<string, unknown> | undefined {
  const match = /^\[paradoc\] (debug|info|warn|error): /.exec(line);
  if (!match) return undefined;
  const level = match[1];
  const jsonStart = line.indexOf("{", match[0].length);
  if (jsonStart < 0) return { level, message: line.slice(match[0].length) };
  try {
    return { level, message: line.slice(match[0].length, jsonStart).trim(), ...(JSON.parse(line.slice(jsonStart)) as Record<string, unknown>) };
  } catch {
    return { level, message: line.slice(match[0].length) };
  }
}

/** Build all three hosts. `filter` narrows the matrix for tests. */
export function createHosts(filter?: readonly HostName[]): Host[] {
  const wanted = filter ?? HOST_NAMES;
  const drivers: Record<HostName, (options: HostRunOptions) => Promise<HostRunResult>> = {
    opencode: runOpenCode,
    "copilot-hooks": runCopilotHooks,
    "copilot-mcp": runCopilotMcp,
  };
  return wanted.map((name) => ({
    name,
    supports: (item: CorpusItem) => HOST_TYPE_MATRIX[name].includes(item.sourceType),
    run: drivers[name],
  }));
}
