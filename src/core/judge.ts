import type { FileExcerpt } from "./models.js";
import { getResponseObject } from "./parse.js";
import type { SubagentResult } from "./subagent.js";

export type JudgeMode = "off" | "low-confidence" | "always";

export interface JudgeOptions {
  mode: JudgeMode;
  confidenceThreshold?: number;
  timeoutMs?: number;
}

export const DEFAULT_JUDGE_CONFIDENCE_THRESHOLD = 3;

export const JUDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["sufficient", "insufficient"] },
    reason: { type: "string" },
  },
};

export function buildJudgePrompt({
  question,
  excerpts,
  summary,
}: {
  question: string;
  excerpts: FileExcerpt[];
  summary: string;
}): string {
  const excerptBlocks = excerpts.map((excerpt) => {
    const numberedLines = excerpt.content
      .split("\n")
      .map((line, index) => `${excerpt.startLine + index}| ${line}`)
      .join("\n");
    return `Excerpt (lines ${excerpt.startLine}-${excerpt.endLine}):\n${numberedLines}`;
  });

  return [
    "Decide whether the supplied excerpts clearly answer the question.",
    "Do not use tools.",
    'Reply with ONLY a JSON object matching {"verdict":"sufficient"|"insufficient","reason":"..."}.',
    "Use insufficient only if the excerpts clearly cannot answer the question.",
    "",
    `Question:\n${question}`,
    "",
    `Subagent summary:\n${summary}`,
    "",
    "Excerpts:",
    ...excerptBlocks,
  ].join("\n");
}

export type JudgeVerdict =
  | { ok: true; verdict: "sufficient" | "insufficient"; reason?: string }
  | { ok: false; detail: string };

export function parseJudgeVerdict(result: SubagentResult): JudgeVerdict {
  const parsed = getResponseObject(result);
  if (!parsed) {
    return { ok: false, detail: "Judge response did not contain a JSON object." };
  }
  if (!("verdict" in parsed)) {
    return { ok: false, detail: "Judge response is missing a verdict." };
  }
  if (typeof parsed.verdict !== "string") {
    return { ok: false, detail: "Judge verdict must be a string." };
  }

  const verdict = parsed.verdict.trim().toLowerCase();
  if (verdict !== "sufficient" && verdict !== "insufficient") {
    return { ok: false, detail: `Unknown judge verdict: ${parsed.verdict}.` };
  }

  const reason =
    typeof parsed.reason === "string" && parsed.reason.trim()
      ? parsed.reason
      : undefined;
  return { ok: true, verdict, ...(reason ? { reason } : {}) };
}

export function shouldRunJudge(
  judge: JudgeOptions | undefined,
  confidence: number | undefined
): boolean {
  if (!judge || judge.mode === "off") return false;
  if (judge.mode === "always") return true;
  if (judge.mode !== "low-confidence") return false;

  const threshold = Number.isFinite(judge.confidenceThreshold)
    ? judge.confidenceThreshold!
    : DEFAULT_JUDGE_CONFIDENCE_THRESHOLD;
  return confidence === undefined || confidence < threshold;
}
