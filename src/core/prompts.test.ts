import { ok } from "node:assert";
import { describe, it } from "node:test";
import { buildSubagentPrompt } from "./prompts.js";

describe("buildSubagentPrompt", () => {
  it("includes the question, numbered lines, confidence rubric, and inference marker", () => {
    const prompt = buildSubagentPrompt({
      filePath: "src/example.ts",
      fileContent: "first line\nlast line",
      question: "Which function is public?",
      questionSource: "inferred",
      agentContext: { goal: "inspect the module" },
    });

    ok(prompt.includes("QUESTION: Which function is public?"));
    ok(prompt.includes("1| first line"));
    ok(prompt.includes("2| last line"));
    ok(prompt.includes("question was inferred"));
    ok(prompt.includes("integer confidence 1-5"));
  });
});
