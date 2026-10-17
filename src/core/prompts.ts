import { AgentContext } from "./models.js";
import { resolveQuestion } from "./question.js";

export interface BuildSubagentPromptOptions {
  filePath: string;
  fileContent: string;
  question: string;
  questionSource: "explicit" | "inferred";
  agentContext: AgentContext;
  window?: { startLine: number; endLine: number };
}

export function buildSubagentPrompt({
  filePath,
  fileContent,
  question,
  questionSource,
  agentContext,
  window,
}: BuildSubagentPromptOptions): string {
  const numberedContent = fileContent
    .split("\n")
    .map((line, index) => `${index + 1}| ${line}`)
    .join("\n");
  const context = [
    agentContext.goal && `Goal: ${agentContext.goal}`,
    agentContext.currentTask && `Current task: ${agentContext.currentTask}`,
    agentContext.instructions && `Instructions: ${agentContext.instructions}`,
  ]
    .filter(Boolean)
    .join("\n");

  if (window) {
    const lines = fileContent.split("\n");
    const totalLines = lines.length;
    let startLine = Math.max(1, Math.min(totalLines, Math.trunc(window.startLine)));
    let endLine = Math.max(1, Math.min(totalLines, Math.trunc(window.endLine)));
    if (startLine > endLine) [startLine, endLine] = [endLine, startLine];
    const windowedContent = lines
      .slice(startLine - 1, endLine)
      .map((line, index) => `${startLine + index}| ${line}`)
      .join("\n");

    return `You select excerpts from an inline source file for a coding agent. Do not use tools.

FILE: ${filePath}
QUESTION: ${question}
${questionSource === "inferred" ? "The question was inferred from agent context." : "The question was supplied explicitly."}
AGENT CONTEXT:
${context || "None supplied."}

Return 1-5 precise excerpt ranges that answer the question. Include 1-2 surrounding lines of context where useful. Use the numbered source lines exactly.
Assign integer confidence 1-5: 1 means the file likely does not answer the question; 2 means weak evidence; 3 means partial answer; 4 means strong answer; 5 means excerpts fully answer it.

Return ONLY valid JSON with this shape:
{"excerpts":[{"startLine":1,"endLine":2,"reason":"short reason"}],"summary":"concise finding","confidence":4}

This is lines ${startLine}-${endLine} of a ${totalLines}-line file. Use the absolute line numbers shown and keep ranges inside ${startLine}-${endLine}. If nothing in this section answers the question, return an empty excerpts array with confidence 1.

NUMBERED FILE CONTENT (lines ${startLine}-${endLine}):
${windowedContent}`;
  }

  return `You select excerpts from an inline source file for a coding agent. Do not use tools.

FILE: ${filePath}
QUESTION: ${question}
${questionSource === "inferred" ? "The question was inferred from agent context." : "The question was supplied explicitly."}
AGENT CONTEXT:
${context || "None supplied."}

Return 1-5 precise excerpt ranges that answer the question. Include 1-2 surrounding lines of context where useful. Use the numbered source lines exactly.
Assign integer confidence 1-5: 1 means the file likely does not answer the question; 2 means weak evidence; 3 means partial answer; 4 means strong answer; 5 means excerpts fully answer it.

Return ONLY valid JSON with this shape:
{"excerpts":[{"startLine":1,"endLine":2,"reason":"short reason"}],"summary":"concise finding","confidence":4}

NUMBERED FILE CONTENT:
${numberedContent}`;
}

/** @deprecated Use resolveQuestion and buildSubagentPrompt. */
export function buildCheapModelPrompt(
  filePath: string,
  fileContent: string,
  agentContext: AgentContext
): string {
  const resolved = resolveQuestion(undefined, agentContext);
  return buildSubagentPrompt({
    filePath,
    fileContent,
    question: resolved.question,
    questionSource: resolved.source,
    agentContext,
  });
}
