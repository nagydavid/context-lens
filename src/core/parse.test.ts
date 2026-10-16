import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  normalizeRanges,
  parseSubagentResult,
  sliceExcerpts,
} from "./parse.js";

describe("parseSubagentResult", () => {
  it("prefers structured output over text", () => {
    const result = parseSubagentResult({
      structured: { excerpts: [], summary: "structured", confidence: 4 },
      text: '{"excerpts":[],"summary":"text","confidence":1}',
    });

    strictEqual(result.ok, true);
    if (result.ok) strictEqual(result.answer.summary, "structured");
  });

  it("parses fenced JSON and JSON surrounded by prose", () => {
    const fenced = parseSubagentResult({
      text: '```json\n{"excerpts":[],"summary":"fenced","confidence":4}\n```',
    });
    const prose = parseSubagentResult({
      text: 'Answer follows: {"excerpts":[],"summary":"prose","confidence":4} Thanks.',
    });

    strictEqual(fenced.ok, true);
    strictEqual(prose.ok, true);
    if (fenced.ok) strictEqual(fenced.answer.summary, "fenced");
    if (prose.ok) strictEqual(prose.answer.summary, "prose");
  });

  it("rejects garbage text and missing excerpts", () => {
    const garbage = parseSubagentResult({ text: "not JSON" });
    const missingExcerpts = parseSubagentResult({
      structured: { summary: "no excerpts", confidence: 3 },
    });
    const invalidStructured = parseSubagentResult({
      structured: [],
      text: '{"excerpts":[],"summary":"must not be used","confidence":3}',
    });

    deepStrictEqual(garbage, {
      ok: false,
      reason: "invalid-response",
      detail: "Subagent response did not contain a JSON object.",
    });
    strictEqual(missingExcerpts.ok, false);
    strictEqual(invalidStructured.ok, false);
    if (!missingExcerpts.ok) strictEqual(missingExcerpts.reason, "invalid-response");
    if (!invalidStructured.ok) {
      strictEqual(invalidStructured.reason, "invalid-response");
    }
  });

  for (const confidence of [undefined, 0, 6, "abc"]) {
    it(`rejects invalid confidence ${String(confidence)}`, () => {
      const result = parseSubagentResult({
        structured: { excerpts: [], summary: "", confidence },
      });

      strictEqual(result.ok, false);
      if (!result.ok) strictEqual(result.reason, "invalid-confidence");
    });
  }

  it("accepts numeric-string confidence and rounds in-range decimals", () => {
    const numericString = parseSubagentResult({
      structured: { excerpts: [], summary: "", confidence: "4" },
    });
    const decimal = parseSubagentResult({
      structured: { excerpts: [], summary: "", confidence: 3.6 },
    });

    strictEqual(numericString.ok, true);
    strictEqual(decimal.ok, true);
    if (numericString.ok) strictEqual(numericString.answer.confidence, 4);
    if (decimal.ok) strictEqual(decimal.answer.confidence, 4);
  });

  it("coerces summary and drops excerpts without finite line numbers", () => {
    const result = parseSubagentResult({
      structured: {
        excerpts: [
          { startLine: "2", endLine: "4", reason: "needed" },
          { startLine: "no", endLine: 3 },
        ],
        summary: 42,
        confidence: 2,
      },
    });
    const missingSummary = parseSubagentResult({
      structured: { excerpts: [], confidence: 2 },
    });

    deepStrictEqual(result, {
      ok: true,
      answer: {
        excerpts: [{ startLine: 2, endLine: 4, reason: "needed" }],
        summary: "42",
        confidence: 2,
      },
    });
    strictEqual(missingSummary.ok, true);
    if (missingSummary.ok) strictEqual(missingSummary.answer.summary, "");
  });
});

describe("normalizeRanges", () => {
  it("swaps, clamps, drops, and merges overlapping or adjacent ranges", () => {
    const ranges = normalizeRanges(
      [
        { startLine: 7.9, endLine: 3.2, reason: "inverted" },
        { startLine: -3, endLine: 2, reason: "clamped" },
        { startLine: 20, endLine: 30, reason: "outside" },
        { startLine: 8, endLine: 9, reason: "adjacent" },
      ],
      10
    );

    deepStrictEqual(ranges, [
      { startLine: 1, endLine: 9, reason: "clamped; inverted; adjacent" },
    ]);
  });

  it("returns no ranges when every candidate is outside the file", () => {
    deepStrictEqual(
      normalizeRanges(
        [
          { startLine: -4, endLine: -1 },
          { startLine: 11, endLine: 12 },
        ],
        10
      ),
      []
    );
  });

  it("caps disjoint normalized ranges at ten", () => {
    const ranges = Array.from({ length: 11 }, (_, index) => ({
      startLine: index * 2 + 1,
      endLine: index * 2 + 1,
    }));

    strictEqual(normalizeRanges(ranges, 30).length, 10);
  });
});

describe("sliceExcerpts", () => {
  it("uses the actual file lines rather than model-provided content", () => {
    const lines = ["first", "second", "third", "fourth"];
    const excerpts = sliceExcerpts(lines, [
      { startLine: 2, endLine: 3, reason: "model rationale" },
    ]);

    deepStrictEqual(excerpts, [
      {
        startLine: 2,
        endLine: 3,
        content: "second\nthird",
        reason: "model rationale",
      },
    ]);
  });
});
