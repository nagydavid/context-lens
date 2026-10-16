import type { FileExcerpt, InterceptionResult } from "../core/index.js";

const HINT =
  "Note: this read was condensed by context-lens. Re-read with an explicit offset and limit to see exact or full content; ranged reads are never condensed.";

function renderExcerpt(excerpt: FileExcerpt): string[] {
  const header = `--- lines ${excerpt.startLine}-${excerpt.endLine}${excerpt.reason ? ` — ${excerpt.reason}` : ""}`;
  const lines = excerpt.content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const numbered = lines.map(
    (text, i) => `${String(excerpt.startLine + i).padStart(5, "0")}| ${text}`,
  );
  return ["", header, ...numbered];
}

export function renderInterceptionResult(
  result: InterceptionResult,
  options?: { displayPath?: string },
): string {
  const out: string[] = [
    `[context-lens] ${options?.displayPath ?? result.filePath}: showing ${result.totalLinesReturned} of ${result.fullLineCount} lines (${Math.round(result.contextSaved)}% context saved)`,
    `Question (${result.questionSource ?? "inferred"}): ${result.question ?? "(none)"}`,
  ];
  if (result.confidence !== undefined) out.push(`Confidence: ${result.confidence}/5`);
  if (result.summary) out.push(`Summary: ${result.summary}`);
  for (const excerpt of result.excerpts) out.push(...renderExcerpt(excerpt));
  out.push("", HINT);
  return out.join("\n");
}
