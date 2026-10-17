import { test } from "node:test";
import assert from "node:assert/strict";
import type { InterceptionResult } from "../core/index.js";
import { renderInterceptionResult } from "./render.js";

function base(overrides: Partial<InterceptionResult> = {}): InterceptionResult {
  return {
    filePath: "/repo/big.ts",
    fullLineCount: 400,
    wasIntercepted: true,
    excerpts: [
      { startLine: 10, endLine: 12, content: "a\nb\nc" },
      { startLine: 200, endLine: 201, content: "x\ny" },
    ],
    summary: "Does things",
    totalLinesReturned: 5,
    contextSaved: 98.75,
    confidence: 4,
    question: "what?",
    questionSource: "explicit",
    ...overrides,
  };
}

test("renders excerpts, confidence, summary and hint", () => {
  const out = renderInterceptionResult(base());
  assert.ok(out.includes("[paradoc] /repo/big.ts: showing 5 of 400 lines (99% context saved)"));
  assert.ok(out.includes("Question (explicit): what?"));
  assert.ok(out.includes("lines 10-12"));
  assert.ok(out.includes("lines 200-201"));
  assert.ok(out.includes("Confidence: 4/5"));
  assert.ok(out.includes("Summary: Does things"));
  assert.ok(out.includes("00010| a"));
  assert.ok(out.includes("00012| c"));
  assert.ok(out.includes("00201| y"));
  assert.ok(out.includes("Re-read with an explicit offset and limit"));
  assert.equal(out, renderInterceptionResult(base()));
});

test("omits confidence and empty summary", () => {
  const out = renderInterceptionResult(
    base({ confidence: undefined, summary: "", question: undefined, questionSource: undefined }),
  );
  assert.ok(!out.includes("Confidence:"));
  assert.ok(!out.includes("Summary:"));
  assert.ok(out.includes("Question (inferred): (none)"));
});

test("displayPath overrides filePath", () => {
  const out = renderInterceptionResult(base(), { displayPath: "src/big.ts" });
  assert.ok(out.includes("[paradoc] src/big.ts:"));
  assert.ok(!out.includes("/repo/big.ts"));
});

test("custom hint replaces the default hint", () => {
  const out = renderInterceptionResult(base(), { hint: "Use view_range for the full file." });
  assert.ok(out.includes("Use view_range for the full file."));
  assert.ok(!out.includes("Re-read with an explicit offset and limit"));
});

test("renders reason on the excerpt header", () => {
  const out = renderInterceptionResult(
    base({ excerpts: [{ startLine: 1, endLine: 1, content: "z", reason: "entry point" }] }),
  );
  assert.ok(out.includes("--- lines 1-1 — entry point"));
});

test("trailing newline does not add an empty numbered line", () => {
  const out = renderInterceptionResult(
    base({ excerpts: [{ startLine: 5, endLine: 6, content: "p\nq\n" }] }),
  );
  assert.ok(out.includes("00006| q"));
  assert.ok(!out.includes("00007|"));
});

test("lists omitted line ranges between and around excerpts", () => {
  const out = renderInterceptionResult(base());
  assert.match(out, /Omitted lines: 1-9, 13-199, 202-400 /);
});
