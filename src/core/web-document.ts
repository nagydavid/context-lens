import type { AgentContext, FallbackReason, InterceptionResult } from "./models.js";
import { sha256 } from "./cache.js";
import type { ReadInterceptor } from "./interceptor.js";
import { maskUrl, parseWebUrl } from "./url-guard.js";
import { fetchWebDocument, type WebFetchOptions } from "./web-fetch.js";
import { htmlToText } from "./web-html.js";

export const DEFAULT_MAX_CONVERTED_LINES = 20000;
export const DEFAULT_MAX_CONVERTED_CHARS = 400000;
export const DEFAULT_MAX_FALLBACK_LINES = 400;

export interface WebReadResult extends InterceptionResult {
  /** Masked final URL (query redacted). */
  url: string;
  title?: string;
  truncated?: boolean;
  contentSha256?: string;
  ranged?: boolean;
}

export interface WebReadRequest {
  url: string;
  question?: string;
  agentContext: AgentContext;
  startLine?: number;
  endLine?: number;
}

export interface WebReadDeps {
  interceptor: ReadInterceptor;
  fetchOptions?: WebFetchOptions;
  maxConvertedLines?: number;
  maxConvertedChars?: number;
  maxFallbackLines?: number;
}

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

function failureResult(label: string, reason: FallbackReason, error: string, detail: string): WebReadResult {
  return {
    filePath: label, url: label, fullLineCount: 0, wasIntercepted: false, excerpts: [], summary: "",
    totalLinesReturned: 0, contextSaved: 0, error, fallback: { reason, detail },
  };
}

function validLine(n: number | undefined): boolean {
  return n === undefined || (Number.isInteger(n) && n >= 1);
}

/** Fetches, converts and condenses a documentation URL. Never throws; failures are returned as error results. */
export async function readWebDocument(request: WebReadRequest, deps: WebReadDeps): Promise<WebReadResult> {
  const { interceptor } = deps;
  let label = "<invalid url>";
  const fail = (reason: FallbackReason, error: string, detail: string): WebReadResult => {
    interceptor.reportFailure(label, reason, detail);
    return failureResult(label, reason, error, detail);
  };
  try {
    const parsed = parseWebUrl(request.url, { allowPrivateNetwork: deps.fetchOptions?.allowPrivateNetwork });
    if (!parsed.ok) return fail(parsed.reason, parsed.error, parsed.detail);
    label = maskUrl(parsed.url);

    const fetched = await fetchWebDocument(parsed.url, deps.fetchOptions);
    if (!fetched.ok) return fail(fetched.reason, fetched.error, fetched.detail);

    const finalLabel = maskUrl(fetched.finalUrl);
    label = finalLabel;
    let title: string | undefined;
    let body: string;
    if (HTML_TYPES.has(fetched.mediaType)) {
      const converted = htmlToText(fetched.text, { baseUrl: fetched.finalUrl });
      title = converted.title || undefined;
      body = converted.text;
    } else {
      body = fetched.text.replace(/\r\n?/g, "\n");
    }
    const header = [...(title ? [`# ${title}`] : []), `Source: ${finalLabel}`, ""];
    let lines = [...header, ...body.split("\n")];
    if (lines.at(-1) === "") lines.pop();

    const maxLines = deps.maxConvertedLines ?? DEFAULT_MAX_CONVERTED_LINES;
    const maxChars = deps.maxConvertedChars ?? DEFAULT_MAX_CONVERTED_CHARS;
    let truncated = false;
    let kept = 0;
    let chars = 0;
    for (const line of lines) {
      if (kept >= maxLines || chars + line.length + 1 > maxChars) { truncated = true; break; }
      chars += line.length + 1;
      kept++;
    }
    if (truncated) lines = [...lines.slice(0, kept), `[paradoc: converted page truncated at ${kept} lines]`];
    const content = lines.join("\n");
    const contentSha256 = sha256(content);
    const meta = { url: finalLabel, ...(title ? { title } : {}), contentSha256 };

    if (request.startLine !== undefined || request.endLine !== undefined) {
      interceptor.noteBypass();
      if (!validLine(request.startLine) || !validLine(request.endLine)) {
        return { ...failureResult(finalLabel, "unreadable", "invalid range", ""), fallback: undefined, ...meta };
      }
      const start = request.startLine ?? 1;
      const end = Math.min(request.endLine ?? lines.length, lines.length);
      if (start > lines.length || start > end) {
        return { ...failureResult(finalLabel, "unreadable", "invalid range", ""), fallback: undefined, ...meta };
      }
      return {
        filePath: finalLabel, fullLineCount: lines.length, wasIntercepted: false,
        excerpts: [{ startLine: start, endLine: end, content: lines.slice(start - 1, end).join("\n") }],
        summary: "", totalLinesReturned: end - start + 1, contextSaved: 0,
        ranged: true, ...(truncated ? { truncated } : {}), ...meta,
      };
    }

    const result: WebReadResult = {
      ...(await interceptor.interceptContent({ label: finalLabel, content, documentKind: "web-page", question: request.question, agentContext: request.agentContext })),
      ...meta, ...(truncated ? { truncated } : {}),
    };
    const maxFallback = deps.maxFallbackLines ?? DEFAULT_MAX_FALLBACK_LINES;
    if (!result.wasIntercepted && !result.error && result.excerpts.length === 1 && result.totalLinesReturned > maxFallback) {
      const only = result.excerpts[0];
      result.excerpts = [{ startLine: only.startLine, endLine: only.startLine + maxFallback - 1, content: only.content.split("\n").slice(0, maxFallback).join("\n") }];
      result.totalLinesReturned = maxFallback;
      result.truncated = true;
    }
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail("fetch-failed", detail, detail);
  }
}
