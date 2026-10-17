import { FileExcerpt, SubagentAnswer } from "./models.js";
import { SubagentResult } from "./subagent.js";

export type ParseOutcome =
  | { ok: true; answer: SubagentAnswer }
  | {
      ok: false;
      reason: "invalid-response" | "invalid-confidence";
      detail: string;
    };

export interface ExcerptRange {
  startLine: number;
  endLine: number;
  reason?: string;
}

export function parseSubagentResult(result: SubagentResult): ParseOutcome {
  const parsed = getResponseObject(result);
  if (!parsed) {
    return {
      ok: false,
      reason: "invalid-response",
      detail: "Subagent response did not contain a JSON object.",
    };
  }

  if (!Array.isArray(parsed.excerpts)) {
    return {
      ok: false,
      reason: "invalid-response",
      detail: "Subagent response is missing an excerpts array.",
    };
  }

  const confidence = parseConfidence(parsed.confidence);
  if (confidence === undefined) {
    return {
      ok: false,
      reason: "invalid-confidence",
      detail: "Confidence must be a number from 1 to 5.",
    };
  }

  const excerpts: ExcerptRange[] = [];
  for (const excerpt of parsed.excerpts) {
    if (!isRecord(excerpt)) continue;

    const startLine = Number(excerpt.startLine);
    const endLine = Number(excerpt.endLine);
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) continue;

    const reason = typeof excerpt.reason === "string" ? excerpt.reason : undefined;
    excerpts.push({ startLine, endLine, ...(reason ? { reason } : {}) });
  }

  return {
    ok: true,
    answer: {
      excerpts,
      summary: parsed.summary == null ? "" : String(parsed.summary),
      confidence,
    },
  };
}

export function normalizeRanges(
  excerpts: ExcerptRange[],
  lineCount: number,
  maxRanges = 10
): ExcerptRange[] {
  if (!Number.isFinite(lineCount) || lineCount < 1) return [];

  const normalized = excerpts
    .map(({ startLine, endLine, reason }) => {
      let start = Math.trunc(startLine);
      let end = Math.trunc(endLine);
      if (start > end) [start, end] = [end, start];
      if (end < 1 || start > lineCount) return undefined;

      start = Math.max(1, start);
      end = Math.min(lineCount, end);
      return { startLine: start, endLine: end, ...(reason ? { reason } : {}) };
    })
    .filter((range): range is ExcerptRange => range !== undefined)
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

  const merged: ExcerptRange[] = [];
  for (const range of normalized) {
    const previous = merged[merged.length - 1];
    if (!previous || range.startLine > previous.endLine + 1) {
      merged.push({ ...range });
      continue;
    }

    previous.endLine = Math.max(previous.endLine, range.endLine);
    if (range.reason) {
      previous.reason = previous.reason
        ? `${previous.reason}; ${range.reason}`
        : range.reason;
    }
  }

  return merged.slice(0, maxRanges);
}

export function sliceExcerpts(
  lines: string[],
  ranges: ExcerptRange[]
): FileExcerpt[] {
  return ranges.map(({ startLine, endLine, reason }) => ({
    startLine,
    endLine,
    content: lines.slice(startLine - 1, endLine).join("\n"),
    ...(reason ? { reason } : {}),
  }));
}

function getResponseObject(result: SubagentResult): Record<string, unknown> | undefined {
  if (typeof result.structured === "object" && result.structured !== null) {
    return result.structured as Record<string, unknown>;
  }
  if (typeof result.text !== "string") return undefined;

  const text = stripJsonFence(result.text);
  try {
    return asRecord(JSON.parse(text));
  } catch {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) return undefined;

    try {
      return asRecord(JSON.parse(text.slice(firstBrace, lastBrace + 1)));
    } catch {
      return undefined;
    }
  }
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```json\s*\n?([\s\S]*?)\n?```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseConfidence(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1 || numeric > 5) return undefined;
  return Math.round(numeric);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
