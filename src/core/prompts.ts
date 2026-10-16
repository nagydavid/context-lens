import { AgentContext } from "./models.js";
import { resolveQuestion } from "./question.js";

export interface BuildSubagentPromptOptions {
  filePath: string;
  fileContent: string;
  question: string;
  questionSource: "explicit" | "inferred";
  agentContext: AgentContext;
}

export function buildSubagentPrompt({
  filePath,
  fileContent,
  question,
  questionSource,
  agentContext,
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
