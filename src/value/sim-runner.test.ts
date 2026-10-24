import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSubagentPrompt } from "../core/prompts.js";
import { buildJudgePrompt } from "../core/judge.js";
import { parseSubagentResult, sliceExcerpts } from "../core/parse.js";
import { SUBAGENT_ANSWER_SCHEMA } from "../core/subagent.js";
import type { SubagentRequest } from "../core/subagent.js";
import {
  ACCURACY_PROFILES,
  SimulatedCheapModel,
  isJudgePrompt,
  parseNumberedLines,
  parseQuestion,
  type AccuracyProfile,
} from "./sim-runner.js";

const NEEDLE = "seven attempts per window before the ledger quarantines the entry";

/** A file whose answer sits on a known line, so profiles can be checked against it. */
function fixture(needleLine = 31): string[] {
  const lines: string[] = [];
  for (let index = 1; index <= 60; index++) {
    if (index === needleLine) {
      lines.push(`  // retry floor: ${NEEDLE}`);
      continue;
    }
    lines.push(`  step${index}(entry: Entry): number { return entry.amount - base; }`);
  }
  return lines;
}

function promptFor(lines: string[], question = "How many attempts before quarantine?"): string {
  return buildSubagentPrompt({
    filePath: "billing/retry_ledger.ts",
    fileContent: lines.join("\n"),
    question,
    questionSource: "explicit",
    agentContext: { currentTask: "fix the retry budget" },
  });
}

function request(prompt: string, timeoutMs = 1000): SubagentRequest {
  return { prompt, schema: SUBAGENT_ANSWER_SCHEMA, timeoutMs };
}

async function runFor(profile: AccuracyProfile, lines = fixture(), needles: readonly string[] = [NEEDLE]) {
  const runner = new SimulatedCheapModel({ profile, needles });
  const prompt = promptFor(lines);
  const result = await runner.run(request(prompt));
  return { runner, prompt, result, lines };
}

describe("prompt parsing helpers", () => {
  it("extracts the numbered content block and the question from the real prompt shape", () => {
    const prompt = promptFor(fixture());
    const lines = parseNumberedLines(prompt);
    strictEqual(lines.length, 60);
    strictEqual(lines[0]!.line, 1);
    strictEqual(lines[59]!.line, 60);
    ok(lines[30]!.text.includes(NEEDLE));
    strictEqual(parseQuestion(prompt), "How many attempts before quarantine?");
    strictEqual(isJudgePrompt(prompt), false);
    strictEqual(isJudgePrompt(buildJudgePrompt({ question: "q", excerpts: [], summary: "" })), true);
  });

  it("parses a windowed chunk prompt with absolute line numbers", () => {
    const prompt = buildSubagentPrompt({
      filePath: "f.ts",
      fileContent: fixture().join("\n"),
      question: "q",
      questionSource: "explicit",
      agentContext: {},
      window: { startLine: 21, endLine: 40 },
    });
    const lines = parseNumberedLines(prompt);
    strictEqual(lines.length, 20);
    strictEqual(lines[0]!.line, 21);
    strictEqual(lines[lines.length - 1]!.line, 40);
  });
});

describe("SimulatedCheapModel profiles", () => {
  it("lists every accuracy profile the harness sweeps", () => {
    deepStrictEqual([...ACCURACY_PROFILES], ["correct", "partial", "wrong", "invalid-json", "timeout"]);
  });

  it("'correct' reports the exact range around the needle it found in the prompt", async () => {
    const { result, lines } = await runFor("correct");
    const parsed = parseSubagentResult(result);
    ok(parsed.ok, JSON.stringify(parsed));
    strictEqual(parsed.answer.excerpts.length, 1);
    strictEqual(parsed.answer.excerpts[0]!.startLine, 30);
    strictEqual(parsed.answer.excerpts[0]!.endLine, 32);
    strictEqual(parsed.answer.confidence, 5);
    const excerptText = sliceExcerpts(lines, parsed.answer.excerpts)[0]!.content;
    ok(excerptText.includes(NEEDLE));
  });

  it("'partial' reports only half the window", async () => {
    const { result } = await runFor("partial");
    const parsed = parseSubagentResult(result);
    ok(parsed.ok);
    strictEqual(parsed.answer.excerpts.length, 1);
    strictEqual(parsed.answer.excerpts[0]!.startLine, 31);
    strictEqual(parsed.answer.excerpts[0]!.endLine, 32);
    strictEqual(parsed.answer.confidence, 3);
    const content = sliceExcerpts(fixture(), parsed.answer.excerpts)[0]!.content;
    ok(content.includes(NEEDLE));
  });

  it("'wrong' reports a plausible range that excludes the needle", async () => {
    const { result } = await runFor("wrong");
    const parsed = parseSubagentResult(result);
    ok(parsed.ok);
    strictEqual(parsed.answer.confidence, 4);
    const ranges = parsed.answer.excerpts;
    ok(ranges.length >= 1);
    for (const range of ranges) {
      ok(range.startLine <= range.endLine);
      ok(range.startLine > 32 || range.endLine < 30, `range ${range.startLine}-${range.endLine} still contains the needle`);
    }
    const content = sliceExcerpts(fixture(), ranges).map((excerpt) => excerpt.content).join("\n");
    ok(!content.includes(NEEDLE));
  });

  it("'invalid-json' returns prose the parser rejects as an invalid response", async () => {
    const { result } = await runFor("invalid-json");
    const parsed = parseSubagentResult(result);
    ok(!parsed.ok);
    strictEqual(parsed.reason, "invalid-response");
  });

  it("'timeout' outlives the caller deadline and rejects with a timeout", async () => {
    const runner = new SimulatedCheapModel({ profile: "timeout", needles: [NEEDLE], timeoutSlackMs: 10 });
    const started = Date.now();
    let reason = "";
    try {
      await runner.run(request(promptFor(fixture()), 40));
    } catch (error) {
      reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    const elapsed = Date.now() - started;
    ok(elapsed >= 40, `timeout fired after only ${elapsed}ms`);
    strictEqual(reason, "TimeoutError: Subagent timed out after 40ms.");
    strictEqual(runner.calls.length, 1);
  });

  it("every profile records the request it received, like FakeSubagentRunner", async () => {
    for (const profile of ACCURACY_PROFILES) {
      const runner = new SimulatedCheapModel({ profile, needles: [NEEDLE], timeoutSlackMs: 1 });
      const prompt = promptFor(fixture());
      try {
        await runner.run(request(profile === "timeout" ? prompt : prompt, profile === "timeout" ? 5 : 1000));
      } catch {
        // timeout profile rejects on purpose
      }
      strictEqual(runner.calls.length, 1, profile);
      strictEqual(runner.calls[0]!.prompt, prompt, profile);
      strictEqual(runner.results.length, 1, profile);
    }
  });

  it("applies the configured latency delay", async () => {
    const runner = new SimulatedCheapModel({ profile: "correct", needles: [NEEDLE], latencyMs: 30 });
    const started = Date.now();
    await runner.run(request(promptFor(fixture())));
    ok(Date.now() - started >= 25, "latency delay was not applied");
  });
});

describe("SimulatedCheapModel is content-derived, not canned", () => {
  it("follows the needle when it moves to a different line", async () => {
    for (const needleLine of [5, 12, 47]) {
      const lines = fixture(needleLine);
      const { result } = await runFor("correct", lines);
      const parsed = parseSubagentResult(result);
      ok(parsed.ok);
      strictEqual(parsed.answer.excerpts[0]!.startLine, needleLine - 1, `needle at ${needleLine}`);
      strictEqual(parsed.answer.excerpts[0]!.endLine, needleLine + 1, `needle at ${needleLine}`);
    }
  });

  it("follows the needle when the prompt is a chunk window with absolute line numbers", async () => {
    const runner = new SimulatedCheapModel({ profile: "correct", needles: [NEEDLE] });
    const prompt = buildSubagentPrompt({
      filePath: "f.ts",
      fileContent: fixture().join("\n"),
      question: "q",
      questionSource: "explicit",
      agentContext: {},
      window: { startLine: 25, endLine: 40 },
    });
    const result = await runner.run(request(prompt));
    const parsed = parseSubagentResult(result);
    ok(parsed.ok);
    strictEqual(parsed.answer.excerpts[0]!.startLine, 30);
    strictEqual(parsed.answer.excerpts[0]!.endLine, 32);
  });

  it("reports no excerpts when the needle is outside the window it was given", async () => {
    const runner = new SimulatedCheapModel({ profile: "correct", needles: [NEEDLE] });
    const prompt = buildSubagentPrompt({
      filePath: "f.ts",
      fileContent: fixture().join("\n"),
      question: "q",
      questionSource: "explicit",
      agentContext: {},
      window: { startLine: 1, endLine: 20 },
    });
    const parsed = parseSubagentResult(await runner.run(request(prompt)));
    ok(parsed.ok);
    strictEqual(parsed.answer.excerpts.length, 0);
    strictEqual(parsed.answer.confidence, 1);
  });

  it("finds several needles and merges overlapping ranges", async () => {
    const lines = fixture().map((line, index) =>
      index + 1 === 40 ? `  // second fact: ${NEEDLE} (second copy)` : line,
    );
    const { result } = await runFor("correct", lines, [NEEDLE]);
    const parsed = parseSubagentResult(result);
    ok(parsed.ok);
    strictEqual(parsed.answer.excerpts.length, 2);
    strictEqual(parsed.answer.excerpts[0]!.startLine, 30);
    strictEqual(parsed.answer.excerpts[1]!.endLine, 41);
  });

  it("does not invent an answer when the needle is absent from the file", async () => {
    const { result } = await runFor("correct", fixture(), ["a needle that does not exist"]);
    const parsed = parseSubagentResult(result);
    ok(parsed.ok);
    strictEqual(parsed.answer.excerpts.length, 0);
  });
});

describe("SimulatedCheapModel judge prompts", () => {
  it("judges sufficient when the needle is inside the excerpts it is shown", async () => {
    const runner = new SimulatedCheapModel({ profile: "correct", needles: [NEEDLE] });
    const excerpts = sliceExcerpts(fixture(), [{ startLine: 30, endLine: 32 }]);
    const result = await runner.run(request(buildJudgePrompt({ question: "q", excerpts, summary: "found it" })));
    const structured = result.structured as { verdict: string };
    strictEqual(structured.verdict, "sufficient");
  });

  it("judges insufficient when the excerpts miss the needle", async () => {
    const runner = new SimulatedCheapModel({ profile: "wrong", needles: [NEEDLE] });
    const excerpts = sliceExcerpts(fixture(), [{ startLine: 1, endLine: 3 }]);
    const result = await runner.run(request(buildJudgePrompt({ question: "q", excerpts, summary: "wrong answer" })));
    const structured = result.structured as { verdict: string };
    strictEqual(structured.verdict, "insufficient");
  });

  it("the invalid-json profile also fails the judge prompt", async () => {
    const runner = new SimulatedCheapModel({ profile: "invalid-json", needles: [NEEDLE] });
    const excerpts = sliceExcerpts(fixture(), [{ startLine: 30, endLine: 32 }]);
    const result = await runner.run(request(buildJudgePrompt({ question: "q", excerpts, summary: "s" })));
    strictEqual(result.structured, undefined);
    ok(typeof result.text === "string");
  });
});
