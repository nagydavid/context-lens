import { SubagentAnswer } from "./models.js";
import { ExcerptRange, normalizeRanges } from "./parse.js";

export interface ChunkWindow {
  startLine: number;
  endLine: number;
}

export interface ChunkAnswer {
  window: ChunkWindow;
  answer: SubagentAnswer;
}

export function planChunks(
  lineCount: number,
  { chunkLines, overlapLines = 0 }: { chunkLines: number; overlapLines?: number }
): ChunkWindow[] {
  if (!Number.isFinite(lineCount) || lineCount < 1) return [];

  const totalLines = Math.trunc(lineCount);
  if (!Number.isFinite(chunkLines) || !Number.isInteger(chunkLines) || chunkLines < 1 || totalLines <= chunkLines) {
    return [{ startLine: 1, endLine: totalLines }];
  }

  const requestedOverlap = Number.isFinite(overlapLines) ? Math.trunc(overlapLines) : 0;
  const overlap = Math.max(0, Math.min(requestedOverlap, chunkLines - 1));
  const step = chunkLines - overlap;
  const windows: ChunkWindow[] = [];

  for (let startLine = 1; startLine <= totalLines; startLine += step) {
    const endLine = Math.min(startLine + chunkLines - 1, totalLines);
    windows.push({ startLine, endLine });
    if (endLine === totalLines) break;
  }

  return windows;
}

export function mergeChunkAnswers(
  answers: ChunkAnswer[],
  lineCount: number
): {
  ranges: ExcerptRange[];
  summary: string;
  confidence: number | undefined;
  contributing: number;
} {
  const ranges: ExcerptRange[] = [];
  const summaries: string[] = [];
  const confidences: number[] = [];
  let contributing = 0;

  for (const { window, answer } of answers) {
    const inWindow = answer.excerpts
      .map((excerpt) => clampToWindow(excerpt, window))
      .filter((range): range is ExcerptRange => range !== undefined);
    if (inWindow.length === 0) continue;

    contributing += 1;
    ranges.push(...inWindow);
    const summary = answer.summary.trim();
    if (summary) summaries.push(summary);
    confidences.push(answer.confidence);
  }

  return {
    ranges: normalizeRanges(ranges, lineCount, Math.max(10, 5 * contributing)),
    summary: summaries.join("\n"),
    confidence: confidences.length > 0 ? Math.max(...confidences) : undefined,
    contributing,
  };
}

function clampToWindow(
  excerpt: ExcerptRange,
  window: ChunkWindow
): ExcerptRange | undefined {
  let startLine = Math.trunc(excerpt.startLine);
  let endLine = Math.trunc(excerpt.endLine);
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return undefined;
  if (startLine > endLine) [startLine, endLine] = [endLine, startLine];
  if (endLine < window.startLine || startLine > window.endLine) return undefined;

  return {
    startLine: Math.max(startLine, window.startLine),
    endLine: Math.min(endLine, window.endLine),
    ...(excerpt.reason ? { reason: excerpt.reason } : {}),
  };
}
