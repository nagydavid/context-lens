import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { ChunkAnswer, planChunks, mergeChunkAnswers } from "./chunking.js";

describe("planChunks", () => {
  it("plans overlapping windows and exact multiples", () => {
    deepStrictEqual(planChunks(3000, { chunkLines: 1000, overlapLines: 50 }), [
      { startLine: 1, endLine: 1000 },
      { startLine: 951, endLine: 1950 },
      { startLine: 1901, endLine: 2900 },
      { startLine: 2851, endLine: 3000 },
    ]);
    deepStrictEqual(planChunks(2000, { chunkLines: 1000, overlapLines: 0 }), [
      { startLine: 1, endLine: 1000 },
      { startLine: 1001, endLine: 2000 },
    ]);
  });

  it("clamps overlap and handles invalid and boundary inputs", () => {
    deepStrictEqual(planChunks(5, { chunkLines: 3, overlapLines: 99 }), [
      { startLine: 1, endLine: 3 },
      { startLine: 2, endLine: 4 },
      { startLine: 3, endLine: 5 },
    ]);
    deepStrictEqual(planChunks(7, { chunkLines: 0 }), [{ startLine: 1, endLine: 7 }]);
    deepStrictEqual(planChunks(7, { chunkLines: Number.NaN }), [{ startLine: 1, endLine: 7 }]);
    deepStrictEqual(planChunks(3, { chunkLines: 3 }), [{ startLine: 1, endLine: 3 }]);
    deepStrictEqual(planChunks(0, { chunkLines: 3 }), []);
    deepStrictEqual(planChunks(2001, { chunkLines: 1000 }), [
      { startLine: 1, endLine: 1000 },
      { startLine: 1001, endLine: 2000 },
      { startLine: 2001, endLine: 2001 },
    ]);
  });

  it("covers every file line", () => {
    const windows = planChunks(37, { chunkLines: 10, overlapLines: 3 });
    for (let line = 1; line <= 37; line += 1) {
      strictEqual(windows.some((window) => line >= window.startLine && line <= window.endLine), true);
    }
  });
});

describe("mergeChunkAnswers", () => {
  it("drops out-of-window ranges, clips partial ranges, and merges adjacent chunk answers", () => {
    const merged = mergeChunkAnswers([
      answer({ startLine: 1, endLine: 10 }, [
        { startLine: -5, endLine: 0 },
        { startLine: 8, endLine: 12, reason: "first" },
      ], " first ", 3),
      answer({ startLine: 11, endLine: 20 }, [
        { startLine: 9, endLine: 13, reason: "second" },
      ], "second", 4),
    ], 20);

    deepStrictEqual(merged, {
      ranges: [{ startLine: 8, endLine: 13, reason: "first; second" }],
      summary: "first\nsecond",
      confidence: 4,
      contributing: 2,
    });
  });

  it("uses confidence from contributing chunks only and handles all-empty answers", () => {
    const ignored = answer({ startLine: 1, endLine: 5 }, [{ startLine: 6, endLine: 8 }], "ignored", 5);
    const useful = answer({ startLine: 6, endLine: 10 }, [{ startLine: 7, endLine: 8 }], "useful", 2);
    const merged = mergeChunkAnswers([ignored, useful], 10);
    strictEqual(merged.confidence, 2);
    strictEqual(merged.contributing, 1);
    deepStrictEqual(mergeChunkAnswers([ignored], 10), {
      ranges: [],
      summary: "",
      confidence: undefined,
      contributing: 0,
    });
  });

  it("raises the normalized range cap for many contributors", () => {
    const answers = [1, 21, 41].map((startLine) => answer(
      { startLine, endLine: startLine + 19 },
      [1, 3, 5, 7, 9].map((offset) => ({ startLine: startLine + offset, endLine: startLine + offset })),
      "range set",
      3
    ));

    const merged = mergeChunkAnswers(answers, 60);
    strictEqual(merged.contributing, 3);
    strictEqual(merged.ranges.length, 15);
  });
});

function answer(
  window: { startLine: number; endLine: number },
  excerpts: { startLine: number; endLine: number; reason?: string }[],
  summary: string,
  confidence: number
): ChunkAnswer {
  return { window, answer: { excerpts, summary, confidence } };
}
