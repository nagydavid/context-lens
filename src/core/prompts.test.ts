import { ok, strictEqual } from "node:assert";
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

  it("numbers only the requested window with absolute lines", () => {
    const fileContent = Array.from({ length: 952 }, (_, index) => {
      if (index === 949) return "excluded line";
      if (index === 950) return "selected line";
      return `line ${index + 1}`;
    }).join("\n");
    const prompt = buildSubagentPrompt({
      filePath: "large.ts",
      fileContent,
      question: "Find the selection",
      questionSource: "explicit",
      agentContext: {},
      window: { startLine: 951, endLine: 952 },
    });

    ok(prompt.includes("951| selected line"));
    ok(!prompt.includes("950| excluded line"));
    ok(prompt.includes("return an empty excerpts array with confidence 1"));
    ok(prompt.includes("NUMBERED FILE CONTENT (lines 951-952):"));
  });

  it("keeps the no-window prompt byte-identical", () => {
    const prompt = buildSubagentPrompt({
      filePath: "a.ts",
      fileContent: "one\ntwo",
      question: "What changed?",
      questionSource: "explicit",
      agentContext: { goal: "review" },
    });

    strictEqual(prompt, `You select excerpts from an inline source file for a coding agent. Do not use tools.

FILE: a.ts
QUESTION: What changed?
The question was supplied explicitly.
AGENT CONTEXT:
Goal: review

Return 1-5 precise excerpt ranges that answer the question. Include 1-2 surrounding lines of context where useful. Use the numbered source lines exactly.
Assign integer confidence 1-5: 1 means the file likely does not answer the question; 2 means weak evidence; 3 means partial answer; 4 means strong answer; 5 means excerpts fully answer it.

Return ONLY valid JSON with this shape:
{"excerpts":[{"startLine":1,"endLine":2,"reason":"short reason"}],"summary":"concise finding","confidence":4}

NUMBERED FILE CONTENT:
1| one
2| two`);
  });
});
