import type { FileExcerpt, InterceptionResult } from "../core/index.js";

export const HINT =
  "Note: this read was condensed by paradoc. Re-read with an explicit offset and limit to see exact or full content; ranged reads are never condensed.";

function renderExcerpt(excerpt: FileExcerpt): string[] {
  const header = `--- lines ${excerpt.startLine}-${excerpt.endLine}${excerpt.reason ? ` — ${excerpt.reason}` : ""}`;
  const lines = excerpt.content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const numbered = lines.map(
    (text, i) => `${String(excerpt.startLine + i).padStart(5, "0")}| ${text}`,
  );
  return ["", header, ...numbered];
}

/** Line ranges not shown, e.g. "1-11, 40-120"; excerpts are sorted and non-overlapping. */
function omittedRanges(result: InterceptionResult): string {
  const gaps: string[] = [];
  let next = 1;
  for (const { startLine, endLine } of result.excerpts) {
    if (startLine > next) gaps.push(startLine - 1 === next ? `${next}` : `${next}-${startLine - 1}`);
    next = endLine + 1;
  }
  if (next <= result.fullLineCount) gaps.push(next === result.fullLineCount ? `${next}` : `${next}-${result.fullLineCount}`);
  return gaps.join(", ");
}

export function renderInterceptionResult(
  result: InterceptionResult,
  options?: { displayPath?: string; hint?: string },
): string {
  const out: string[] = [
    `[paradoc] ${options?.displayPath ?? result.filePath}: showing ${result.totalLinesReturned} of ${result.fullLineCount} lines (${Math.round(result.contextSaved)}% context saved)`,
    `Question (${result.questionSource ?? "inferred"}): ${result.question ?? "(none)"}`,
  ];
  if (result.confidence !== undefined) out.push(`Confidence: ${result.confidence}/5`);
  if (result.summary) out.push(`Summary: ${result.summary}`);
  for (const excerpt of result.excerpts) out.push(...renderExcerpt(excerpt));
  const omitted = omittedRanges(result);
  if (omitted) out.push("", `Omitted lines: ${omitted} (read these with an explicit range if needed)`);
  out.push("", options?.hint ?? HINT);
  return out.join("\n");
}
