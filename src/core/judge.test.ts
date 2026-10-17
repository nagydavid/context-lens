import { deepStrictEqual, match, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import type { SubagentResult } from "./subagent.js";
import { eventLogLevel } from "./interceptor.js";
import {
  DEFAULT_JUDGE_CONFIDENCE_THRESHOLD,
  JUDGE_SCHEMA,
  buildJudgePrompt,
  parseJudgeVerdict,
  shouldRunJudge,
} from "./judge.js";

describe("JUDGE_SCHEMA", () => {
  it("requires a verdict from the supported enum", () => {
    const properties = JUDGE_SCHEMA.properties as Record<string, unknown>;
    const verdict = properties.verdict as Record<string, unknown>;

    deepStrictEqual(JUDGE_SCHEMA.required, ["verdict"]);
    deepStrictEqual(verdict.enum, ["sufficient", "insufficient"]);
  });
});

describe("buildJudgePrompt", () => {
  it("includes only supplied excerpts with absolute line numbers", () => {
    const prompt = buildJudgePrompt({
      question: "Where is the timeout configured?",
      summary: "The timeout is set near initialization.",
      excerpts: [
        {
          startLine: 120,
          endLine: 122,
          content: "const timeout = 50;\nreturn timeout;\n}",
        },
      ],
    });

    match(prompt, /Where is the timeout configured\?/);
    match(prompt, /The timeout is set near initialization\./);
    match(prompt, /lines 120-122/);
    match(prompt, /120\| const timeout = 50;/);
    match(prompt, /122\| }/);
    strictEqual(prompt.includes("OUTSIDE_EXCERPT_MARKER"), false);
  });
});

describe("parseJudgeVerdict", () => {
  const accepted: Array<[string, SubagentResult]> = [
    ["structured", { structured: { verdict: "sufficient" } }],
    ["plain JSON", { text: '{"verdict":"sufficient"}' }],
    ["fenced JSON", { text: '```json\n{"verdict":"sufficient"}\n```' }],
    ["embedded JSON", { text: 'Decision: {"verdict":"sufficient"} done.' }],
    ["trimmed casing", { text: '{"verdict":" Sufficient "}' }],
  ];
  for (const [name, result] of accepted) {
    it(`accepts ${name}`, () => {
      const parsed = parseJudgeVerdict(result);
      deepStrictEqual(parsed, { ok: true, verdict: "sufficient" });
    });
  }

  it("keeps an insufficient verdict reason", () => {
    deepStrictEqual(
      parseJudgeVerdict({
        structured: { verdict: "insufficient", reason: "Missing the call site." },
      }),
      { ok: true, verdict: "insufficient", reason: "Missing the call site." }
    );
  });

  for (const [name, result, detail] of [
    ["non-JSON text", { text: "not JSON" }, /did not contain/],
    ["missing verdict", { structured: { reason: "none" } }, /missing a verdict/],
    ["unknown verdict", { structured: { verdict: "unsure" } }, /Unknown judge verdict/],
    ["numeric verdict", { structured: { verdict: 1 } }, /must be a string/],
    ["empty result", {}, /did not contain/],
  ] as const) {
    it(`rejects ${name}`, () => {
      const parsed = parseJudgeVerdict(result);
      strictEqual(parsed.ok, false);
      if (!parsed.ok) match(parsed.detail, detail);
    });
  }
});

describe("eventLogLevel", () => {
  it("warns for judge errors before evaluating intercept and fallback state", () => {
    strictEqual(eventLogLevel({ filePath: "a", lineCount: 1, intercepted: true, judge: { elapsedMs: 1, error: "bad JSON" } }), "warn");
    strictEqual(eventLogLevel({ filePath: "a", lineCount: 1, intercepted: true }), "info");
    strictEqual(eventLogLevel({ filePath: "a", lineCount: 1, intercepted: false, fallbackReason: "judge-rejected" }), "warn");
    strictEqual(eventLogLevel({ filePath: "a", lineCount: 1, intercepted: false }), "debug");
  });
});

describe("shouldRunJudge", () => {
  it("disables absent, off, and unknown modes", () => {
    strictEqual(shouldRunJudge(undefined, 1), false);
    strictEqual(shouldRunJudge({ mode: "off" }, 1), false);
    strictEqual(
      shouldRunJudge({ mode: "unexpected" } as never, 1),
      false
    );
  });

  it("runs always mode regardless of confidence", () => {
    strictEqual(shouldRunJudge({ mode: "always" }, undefined), true);
  });

  it("runs low-confidence only below its threshold", () => {
    const judge = { mode: "low-confidence" as const };
    strictEqual(shouldRunJudge(judge, 2), true);
    strictEqual(shouldRunJudge(judge, DEFAULT_JUDGE_CONFIDENCE_THRESHOLD), false);
    strictEqual(shouldRunJudge(judge, undefined), true);
    strictEqual(
      shouldRunJudge({ mode: "low-confidence", confidenceThreshold: 4 }, 3),
      true
    );
    strictEqual(
      shouldRunJudge({ mode: "low-confidence", confidenceThreshold: Number.NaN }, 3),
      false
    );
  });
});
