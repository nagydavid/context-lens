import { AgentContext } from "./models.js";

export function buildCheapModelPrompt(
  filePath: string,
  fileContent: string,
  agentContext: AgentContext
): string {
  const lineCount = fileContent.split("\n").length;

  const contextClues = [
    agentContext.goal && `Goal: ${agentContext.goal}`,
    agentContext.currentTask && `Current task: ${agentContext.currentTask}`,
    agentContext.instructions && `Instructions: ${agentContext.instructions}`,
  ]
    .filter(Boolean)
    .join("\n");

  return `You are a cheap-model read interceptor for a coding agent.

File: ${filePath}
Size: ${lineCount} lines
Agent context:
${contextClues}

TASK: Answer one implicit question based on the agent's context and goal.
- Infer what the agent likely needs from this file
- Find and return the most relevant excerpts (2–5 ranges)
- For each excerpt, include 1–2 lines of surrounding context
- End with a one-line summary of what the excerpts show

RESPONSE FORMAT:
Return ONLY valid JSON, no markdown:
{
  "excerpts": [
    {"startLine": N, "endLine": M, "reason": "short reason"},
    ...
  ],
  "summary": "one-line summary of key findings"
}

FILE CONTENT:
\`\`\`
${fileContent}
\`\`\`

Return excerpts as line numbers (1-indexed). Be precise and concise.`;
}
