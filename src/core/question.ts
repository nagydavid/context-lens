import { AgentContext } from "./models.js";

const DEFAULT_QUESTION =
  "What is the main purpose of this file and what are its key exports, types and entry points?";
const MAX_INFERRED_LENGTH = 500;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function resolveQuestion(
  question: string | undefined,
  context: AgentContext
): { question: string; source: "explicit" | "inferred" } {
  const explicit = nonEmpty(question);
  if (explicit) return { question: explicit, source: "explicit" };

  const topic =
    nonEmpty(context.currentTask) ??
    nonEmpty(context.goal) ??
    nonEmpty(context.instructions);
  if (!topic) return { question: DEFAULT_QUESTION, source: "inferred" };

  return {
    question: `What in this file is relevant to: ${topic}`.slice(
      0,
      MAX_INFERRED_LENGTH
    ),
    source: "inferred",
  };
}
