import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  ModelSelector,
  ReadInterceptor,
  eventLogLevel,
  readTextFile,
  statFile,
  type ConfigOptions,
  type InterceptionEvent,
  type InterceptionResult,
  type JudgeOptions,
  type SubagentRunner,
} from "../core/index.js";
import { renderInterceptionResult } from "../opencode/render.js";
import { createCopilotRunner } from "./subagent.js";

export const CONTEXT_LENS_READ_TOOL = {
  name: "context_lens_read",
  description: "Read a large file with a question; returns only the relevant line ranges with confidence. Use start_line/end_line for exact ranges (never condensed).",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      question: { type: "string" },
      start_line: { type: "integer", minimum: 1 },
      end_line: { type: "integer", minimum: 1 },
    },
    required: ["path", "question"],
    additionalProperties: false,
  },
} as const;

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_HINT = "Call context_lens_read again with start_line/end_line to see exact content; ranged reads are never condensed.";

type LogLevel = "debug" | "info" | "warn" | "error";
type JsonRpcId = string | number | null;
export type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: { code: number; message: string } };
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError: boolean };

export interface McpServerOptions {
  runner?: SubagentRunner;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  configOptions?: Pick<ConfigOptions, "homeDir" | "env">;
  thresholdLines?: number;
  chunkLines?: number;
  chunkOverlapLines?: number;
  concurrency?: number;
  timeoutMs?: number;
  maxFileBytes?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  judge?: JudgeOptions;
  stderr?: (line: string) => void;
  logFile?: string;
}

interface ReadDependencies {
  cwd: string;
  env: NodeJS.ProcessEnv;
  interceptor: ReadInterceptor;
  maxFileBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeEvent(event: InterceptionEvent): string {
  const judge = event.judge ? `, judge=${event.judge.verdict ?? "error"}` : "";
  const judgeError = event.judge?.error ? ` judge error: ${event.judge.error}` : "";
  if (event.intercepted) return `intercepted ${event.filePath} (${event.lineCount} lines, confidence ${event.confidence ?? "?"}${event.chunks !== undefined ? `, chunks=${event.chunks}` : ""}${judge}, ${Math.round(event.elapsedMs ?? 0)}ms)${judgeError}`;
  if (event.fallbackReason) return `fallback ${event.fallbackReason} for ${event.filePath}${event.detail ? `: ${event.detail}` : ""}${judge}`;
  return `passthrough ${event.filePath} (${event.lineCount} lines)`;
}

function toolText(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

function numbered(content: string, startLine = 1): string {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => `${String(startLine + index).padStart(5, "0")}| ${line}`).join("\n");
}

function guardError(read: { error: string; reason: string; detail: string }): ToolResult {
  return toolText(`context-lens: ${read.error} (${read.reason}): ${read.detail}`, true);
}

function readGuarded(filePath: string, maxFileBytes?: number) {
  const stat = statFile(filePath, maxFileBytes);
  return stat.ok ? readTextFile(filePath) : stat;
}

function validLine(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export function toToolResult(result: InterceptionResult, displayPath: string): ToolResult {
  if (result.error) return toolText(`context-lens: ${result.error} (${result.fallback?.reason ?? "unreadable"}): ${result.fallback?.detail ?? ""}`, true);
  if (result.wasIntercepted) return toolText(renderInterceptionResult(result, { displayPath, hint: MCP_HINT }));
  const full = result.excerpts[0]?.content ?? "";
  const header = result.fallback
    ? `[context-lens] fallback: ${result.fallback.reason} — returning full file`
    : `[context-lens] ${displayPath}: ${result.fullLineCount} lines (not condensed)`;
  return toolText(`${header}\n${numbered(full)}`);
}

/** Handles the public tool arguments; ranged reads deliberately bypass interception. */
export async function handleContextLensRead(args: unknown, deps: ReadDependencies): Promise<ToolResult> {
  if (!isRecord(args)) return toolText("context-lens: arguments must be an object", true);
  if (typeof args.path !== "string" || args.path.trim() === "") return toolText("context-lens: path must be a non-empty string", true);
  if (typeof args.question !== "string" || args.question.trim() === "") return toolText("context-lens: question must be a non-empty string", true);
  const filePath = resolve(deps.cwd, args.path);
  const ranged = Object.prototype.hasOwnProperty.call(args, "start_line") || Object.prototype.hasOwnProperty.call(args, "end_line");
  if (ranged || deps.env.CONTEXT_LENS_CHILD === "1") {
    if ((Object.prototype.hasOwnProperty.call(args, "start_line") && !validLine(args.start_line)) ||
        (Object.prototype.hasOwnProperty.call(args, "end_line") && !validLine(args.end_line))) {
      return toolText("context-lens: invalid range", true);
    }
    const read = readGuarded(filePath, deps.maxFileBytes);
    if (!read.ok) return guardError(read);
    const lines = read.content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (deps.env.CONTEXT_LENS_CHILD === "1" && !ranged) {
      return toolText(`[context-lens] ${args.path}: ${lines.length} lines (child process; not condensed)\n${numbered(read.content)}`);
    }
    const start = (args.start_line as number | undefined) ?? 1;
    const end = Math.min((args.end_line as number | undefined) ?? lines.length, lines.length);
    if (start > lines.length || start > end) return toolText("context-lens: invalid range", true);
    const content = lines.slice(start - 1, end).join("\n");
    return toolText(renderInterceptionResult({
      filePath,
      fullLineCount: lines.length,
      wasIntercepted: false,
      excerpts: [{ startLine: start, endLine: end, content }],
      summary: "",
      question: args.question.trim(),
      questionSource: "explicit",
      totalLinesReturned: end - start + 1,
      contextSaved: 0,
    }, { displayPath: args.path, hint: MCP_HINT }));
  }
  const result = await deps.interceptor.intercept({ filePath, projectRoot: deps.cwd, question: args.question.trim(), agentContext: {} });
  return toToolResult(result, args.path);
}

function response(id: JsonRpcId, result: unknown): JsonRpcResponse { return { jsonrpc: "2.0", id, result }; }
function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse { return { jsonrpc: "2.0", id, error: { code, message } }; }

export function createMcpServer(options: McpServerOptions = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const logFile = options.logFile ?? env.CONTEXT_LENS_LOG_FILE;
  const log = (level: LogLevel, message: string, extra: Record<string, unknown> = {}): void => {
    const record = { time: new Date().toISOString(), level, message, ...extra };
    const line = `[context-lens] ${level}: ${message} ${JSON.stringify(extra)}`;
    try { (options.stderr ?? ((text) => process.stderr.write(text)))(`${line}\n`); } catch { /* best effort */ }
    if (logFile) try { appendFileSync(logFile, `${JSON.stringify(record)}\n`, "utf8"); } catch { /* best effort */ }
  };
  const selector = new ModelSelector({ ...options.configOptions, projectRoot: cwd, onWarning: (message) => log("warn", message) });
  let runner = options.runner;
  let interceptor: ReadInterceptor | undefined;
  const interceptorFor = () => interceptor ??= new ReadInterceptor({
    runner: runner ??= createCopilotRunner({ concurrency: options.concurrency }), modelResolver: selector.resolve,
    thresholdLines: options.thresholdLines, chunkLines: options.chunkLines, chunkOverlapLines: options.chunkOverlapLines,
    timeoutMs: options.timeoutMs, maxFileBytes: options.maxFileBytes,
    maxRetries: options.maxRetries, retryDelayMs: options.retryDelayMs, judge: options.judge,
    logger: (event) => log(eventLogLevel(event), describeEvent(event), { ...event }),
  });
  return {
    async handleMessage(msg: unknown): Promise<JsonRpcResponse | undefined> {
      const id = isRecord(msg) && (typeof msg.id === "string" || typeof msg.id === "number" || msg.id === null) ? msg.id : null;
      if (!isRecord(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(id, -32600, "Invalid Request");
      const notification = !Object.prototype.hasOwnProperty.call(msg, "id");
      if (notification) return undefined;
      try {
        if (msg.method === "initialize") {
          const requested = isRecord(msg.params) ? msg.params.protocolVersion : undefined;
          const protocolVersion = typeof requested === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
          return response(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "context-lens", version: "0.1.0" } });
        }
        if (msg.method === "ping") return response(id, {});
        if (msg.method === "tools/list") return response(id, { tools: [CONTEXT_LENS_READ_TOOL] });
        if (msg.method === "tools/call") {
          if (!isRecord(msg.params) || msg.params.name !== "context_lens_read") return rpcError(id, -32602, "Invalid params");
          return response(id, await handleContextLensRead(msg.params.arguments, { cwd, env, interceptor: interceptorFor(), maxFileBytes: options.maxFileBytes }));
        }
        return rpcError(id, -32601, "Method not found");
      } catch (error) {
        log("error", "request handling failed", { detail: error instanceof Error ? error.message : String(error) });
        return rpcError(id, -32603, "Internal error");
      }
    },
  };
}

export async function serveStdio(server: ReturnType<typeof createMcpServer>, options: { input: Readable; output: Writable; onError?: (error: Error) => void }): Promise<void> {
  const inflight = new Set<Promise<void>>();
  const onOutputError = (error: Error & { code?: string }) => {
    if (error.code !== "EPIPE") options.onError?.(error);
  };
  options.output.on("error", onOutputError);
  const write = (value: JsonRpcResponse) => {
    try { options.output.write(`${JSON.stringify(value)}\n`); }
    catch (error) { onOutputError(error as Error & { code?: string }); }
  };
  const run = (line: string) => {
    const pending = (async () => {
      try {
        const message = JSON.parse(line) as unknown;
        const result = await server.handleMessage(message);
        if (result) write(result);
      } catch (error) {
        if (error instanceof SyntaxError) write(rpcError(null, -32700, "Parse error"));
        else options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    })();
    inflight.add(pending);
    void pending.finally(() => inflight.delete(pending));
  };
  const reader = createInterface({ input: options.input, crlfDelay: Infinity });
  reader.on("line", (line) => { const trimmed = line.trim(); if (trimmed) run(trimmed); });
  await new Promise<void>((resolve) => reader.on("close", resolve));
  await Promise.all([...inflight]);
}
