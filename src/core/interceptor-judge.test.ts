import { ok, strictEqual } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FakeSubagentRunner } from "./fake-runner.js";
import { ReadInterceptor } from "./interceptor.js";
import { JUDGE_SCHEMA } from "./judge.js";
import type { SubagentRequest, SubagentResult } from "./subagent.js";

const large = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`).join("\n");
const answer = (request: SubagentRequest): SubagentResult => {
  const match = request.prompt.match(/This is lines (\d+)-(\d+)/);
  const start = match ? Number(match[1]) : 1;
  return { structured: { excerpts: [{ startLine: start, endLine: start + 1 }], summary: "answer", confidence: 2 } };
};
const isJudge = (request: SubagentRequest) => request.schema === JUDGE_SCHEMA;

async function withFile(content: string, run: (filePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "context-lens-judge-"));
  const filePath = join(directory, "large.txt");
  writeFileSync(filePath, content);
  try { await run(filePath); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function interceptor(runner: FakeSubagentRunner, options: ConstructorParameters<typeof ReadInterceptor>[0] = {}) {
  return new ReadInterceptor({ runner, thresholdLines: 1, ...options });
}

describe("ReadInterceptor judge", () => {
  it("keeps excerpts and records an approved judge verdict", async () => {
    await withFile(large, async (filePath) => {
      const events: any[] = [];
      const runner = new FakeSubagentRunner((request) => isJudge(request)
        ? { structured: { verdict: "sufficient" } } : answer(request));
      const result = await interceptor(runner, { judge: { mode: "always" }, logger: (event) => events.push(event) }).intercept({ filePath, agentContext: {} });
      strictEqual(result.wasIntercepted, true);
      strictEqual(result.judge?.verdict, "sufficient");
      strictEqual(events[0].intercepted, true);
      strictEqual(events[0].judge?.verdict, "sufficient");
      strictEqual(runner.calls.length, 2);
    });
  });

  it("uses the full file only for an explicit insufficient verdict", async () => {
    await withFile(large, async (filePath) => {
      const events: any[] = [];
      const runner = new FakeSubagentRunner((request) => isJudge(request)
        ? { structured: { verdict: "insufficient", reason: "missing context" } } : answer(request));
      const result = await interceptor(runner, { judge: { mode: "always" }, logger: (event) => events.push(event) }).intercept({ filePath, agentContext: {} });
      strictEqual(result.wasIntercepted, false);
      strictEqual(result.excerpts[0].content, large);
      strictEqual(result.fallback?.reason, "judge-rejected");
      strictEqual(result.fallback?.detail, "missing context");
      strictEqual(events[0].fallbackReason, "judge-rejected");
      strictEqual(events[0].judge?.verdict, "insufficient");
    });
  });

  for (const [name, judgeResult] of [
    ["throws", () => { throw new Error("judge unavailable"); }],
    ["returns invalid JSON", () => ({ text: "not json" })],
    ["returns an unknown verdict", () => ({ structured: { verdict: "unsure" } })],
  ] as const) {
    it(`keeps excerpts when the judge ${name}`, async () => {
      await withFile(large, async (filePath) => {
        const runner = new FakeSubagentRunner((request) => isJudge(request) ? judgeResult() : answer(request));
        const result = await interceptor(runner, { judge: { mode: "always" } }).intercept({ filePath, agentContext: {} });
        strictEqual(result.wasIntercepted, true);
        ok(result.judge?.error);
        strictEqual(result.judge?.verdict, undefined);
      });
    });
  }

  it("times out the judge independently of the longer read timeout", async () => {
    await withFile(large, async (filePath) => {
      const runner = new FakeSubagentRunner(async (request) => {
        if (isJudge(request)) { await delay(100); return { structured: { verdict: "sufficient" } }; }
        return answer(request);
      });
      const started = performance.now();
      const result = await interceptor(runner, { timeoutMs: 1000, judge: { mode: "always", timeoutMs: 25 } }).intercept({ filePath, agentContext: {} });
      strictEqual(result.wasIntercepted, true);
      ok(result.judge?.error?.includes("timed out"));
      ok(performance.now() - started < 300);
    });
  });

  it("uses a fresh judge deadline after chunked answer calls", async () => {
    await withFile(large, async (filePath) => {
      const runner = new FakeSubagentRunner(async (request) => {
        if (isJudge(request)) return { structured: { verdict: "sufficient" } };
        await delay(20);
        return answer(request);
      });
      const result = await interceptor(runner, { chunkLines: 1000, timeoutMs: 200, judge: { mode: "always", timeoutMs: 75 } }).intercept({ filePath, agentContext: {} });
      const judgeRequest = runner.calls.find(isJudge)!;
      strictEqual(result.chunks, 3);
      strictEqual(result.judge?.verdict, "sufficient");
      ok(judgeRequest.timeoutMs > 60 && judgeRequest.timeoutMs <= 75);
    });
  });

  it("does not call the judge when disabled, absent, or the answer falls back", async () => {
    await withFile(large, async (filePath) => {
      for (const judge of [undefined, { mode: "off" as const }]) {
        const single = new FakeSubagentRunner(answer);
        await interceptor(single, { judge }).intercept({ filePath, agentContext: {} });
        strictEqual(single.calls.filter(isJudge).length, 0);
        strictEqual(single.calls.length, 1);

        const chunked = new FakeSubagentRunner(answer);
        await interceptor(chunked, { chunkLines: 1000, judge }).intercept({ filePath, agentContext: {} });
        strictEqual(chunked.calls.filter(isJudge).length, 0);
        strictEqual(chunked.calls.length, 3);
      }
      const bad = new FakeSubagentRunner(() => ({ text: "bad" }));
      await interceptor(bad, { judge: { mode: "always" } }).intercept({ filePath, agentContext: {} });
      strictEqual(bad.calls.filter(isJudge).length, 0);
    });
  });

  it("does not judge files below the threshold", async () => {
    await withFile("short\nfile", async (filePath) => {
      const runner = new FakeSubagentRunner(answer);
      await new ReadInterceptor({ runner, judge: { mode: "always" } }).intercept({ filePath, agentContext: {} });
      strictEqual(runner.calls.length, 0);
    });
  });

  it("judges one merged chunked response without outside prompt content", async () => {
    await withFile(large, async (filePath) => {
      const runner = new FakeSubagentRunner((request) => isJudge(request)
        ? { structured: { verdict: "sufficient" } } : answer(request));
      const result = await interceptor(runner, { chunkLines: 1000, judge: { mode: "always" } }).intercept({ filePath, agentContext: {} });
      const judges = runner.calls.filter(isJudge);
      strictEqual(judges.length, 1);
      strictEqual(result.chunks, 3);
      ok(!judges[0].prompt.includes("line 500"));
      ok(judges[0].prompt.includes("1| line 1"));
    });
  });

  it("uses the low-confidence threshold and isolates judge retry attempts", async () => {
    await withFile(large, async (filePath) => {
      let judgeCalls = 0;
      const runner = new FakeSubagentRunner((request) => {
        if (!isJudge(request)) return answer(request);
        judgeCalls += 1;
        if (judgeCalls === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
        return { structured: { verdict: "sufficient" } };
      });
      const result = await interceptor(runner, { maxRetries: 1, judge: { mode: "low-confidence", confidenceThreshold: 3 } }).intercept({ filePath, agentContext: {} });
      strictEqual(result.judge?.verdict, "sufficient");
      strictEqual(result.attempts, undefined);
      strictEqual(judgeCalls, 2);

      const confident = new FakeSubagentRunner(() => ({ structured: { excerpts: [{ startLine: 1, endLine: 2 }], summary: "sure", confidence: 3 } }));
      await interceptor(confident, { judge: { mode: "low-confidence", confidenceThreshold: 3 } }).intercept({ filePath, agentContext: {} });
      strictEqual(confident.calls.filter(isJudge).length, 0);
    });
  });
});

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
