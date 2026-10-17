import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LruResultCache, type ResultCache } from "./cache.js";
import { FakeSubagentRunner } from "./fake-runner.js";
import { eventLogLevel, ReadInterceptor, type InterceptionEvent, type InterceptOptions } from "./interceptor.js";
import { JUDGE_SCHEMA } from "./judge.js";
import { ConcurrencyLimitedRunner } from "./subagent.js";
import type { SubagentRequest, SubagentResult } from "./subagent.js";

const large = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`).join("\n");
const model = { providerID: "p", modelID: "m" };
const answer = (request: SubagentRequest): SubagentResult => {
  const match = request.prompt.match(/This is lines (\d+)-(\d+)/);
  const start = match ? Number(match[1]) : 1;
  return { structured: { excerpts: [{ startLine: start, endLine: start + 1 }], summary: "answer", confidence: 2 } };
};
const isJudge = (request: SubagentRequest) => request.schema === JUDGE_SCHEMA;
const approving = (request: SubagentRequest): SubagentResult => isJudge(request) ? { structured: { verdict: "sufficient" } } : answer(request);

async function withFile(content: string, run: (filePath: string, directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "paradoc-cache-"));
  const filePath = join(directory, "large.txt");
  writeFileSync(filePath, content);
  try { await run(filePath, directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function make(runner: FakeSubagentRunner | ConcurrencyLimitedRunner, options: InterceptOptions = {}) {
  return new ReadInterceptor({ runner, thresholdLines: 1, model, ...options });
}

describe("ReadInterceptor result cache", () => {
  it("serves a repeat read from cache without runner calls", async () => {
    await withFile(large, async (filePath) => {
      const runner = new FakeSubagentRunner(answer);
      const interceptor = make(runner, { cache: new LruResultCache() });
      const first = await interceptor.intercept({ filePath, agentContext: {} });
      const calls = runner.calls.length;
      const second = await interceptor.intercept({ filePath, agentContext: {} });
      strictEqual(runner.calls.length, calls);
      strictEqual(first.cacheHit, undefined);
      strictEqual(second.cacheHit, true);
      deepStrictEqual(second.excerpts, first.excerpts);
      strictEqual(second.summary, first.summary);
      strictEqual(second.confidence, first.confidence);
      strictEqual(second.totalLinesReturned, first.totalLinesReturned);
      strictEqual(second.contextSaved, first.contextSaved);
    });
  });

  describe("misses", () => {
    const cases: Array<[string, (filePath: string) => { first: InterceptOptions; second: InterceptOptions; question?: string; edit?: boolean; chunked?: boolean }]> = [
      ["edited content", () => ({ first: {}, second: {}, edit: true })],
      ["different question", () => ({ first: {}, second: {}, question: "other" })],
      ["different model", () => ({ first: {}, second: { model: { providerID: "p", modelID: "other" } } })],
      ["different chunkLines", () => ({ first: { chunkLines: 1000 }, second: { chunkLines: 1500 }, chunked: true })],
      ["different chunkOverlapLines", () => ({ first: { chunkLines: 1000, chunkOverlapLines: 0 }, second: { chunkLines: 1000, chunkOverlapLines: 10 }, chunked: true })],
      ["different judge mode", () => ({ first: {}, second: { judge: { mode: "always" } } })],
    ];
    for (const [name, build] of cases) {
      it(`misses on ${name}`, async () => {
        await withFile(large, async (filePath) => {
          const cache = new LruResultCache();
          const plan = build(filePath);
          const runner = new FakeSubagentRunner(approving);
          const wrap = (r: FakeSubagentRunner) => plan.chunked ? new ConcurrencyLimitedRunner(r, 4) : r;
          await make(wrap(runner), { cache, ...plan.first }).intercept({ filePath, question: "q", agentContext: {} });
          const calls = runner.calls.length;
          if (plan.edit) writeFileSync(filePath, `${large}\nextra`);
          const second = await make(wrap(runner), { cache, ...plan.second }).intercept({ filePath, question: plan.question ?? "q", agentContext: {} });
          ok(runner.calls.length > calls);
          strictEqual(second.cacheHit, undefined);
        });
      });
    }
  });

  it("does not store runner fallbacks", async () => {
    await withFile(large, async (filePath) => {
      const runner = new FakeSubagentRunner({ text: "garbage" });
      const interceptor = make(runner, { cache: new LruResultCache() });
      const first = await interceptor.intercept({ filePath, agentContext: {} });
      strictEqual(first.wasIntercepted, false);
      const calls = runner.calls.length;
      await interceptor.intercept({ filePath, agentContext: {} });
      ok(runner.calls.length > calls);
    });
  });

  it("does not store judge-rejected results", async () => {
    await withFile(large, async (filePath) => {
      const runner = new FakeSubagentRunner((r) => isJudge(r) ? { structured: { verdict: "insufficient" } } : answer(r));
      const interceptor = make(runner, { cache: new LruResultCache(), judge: { mode: "always" } });
      const first = await interceptor.intercept({ filePath, agentContext: {} });
      strictEqual(first.fallback?.reason, "judge-rejected");
      const calls = runner.calls.length;
      const second = await interceptor.intercept({ filePath, agentContext: {} });
      ok(runner.calls.length > calls);
      strictEqual(second.cacheHit, undefined);
    });
  });

  it("does not store results whose judge errored", async () => {
    await withFile(large, async (filePath) => {
      const runner = new FakeSubagentRunner((r) => isJudge(r) ? { text: "not json" } : answer(r));
      const interceptor = make(runner, { cache: new LruResultCache(), judge: { mode: "always" } });
      const first = await interceptor.intercept({ filePath, agentContext: {} });
      strictEqual(first.wasIntercepted, true);
      ok(first.judge?.error);
      const calls = runner.calls.length;
      const second = await interceptor.intercept({ filePath, agentContext: {} });
      ok(runner.calls.length > calls);
      strictEqual(second.cacheHit, undefined);
    });
  });

  it("survives a cache whose get and set throw", async () => {
    await withFile(large, async (filePath) => {
      const cache: ResultCache = { get() { throw new Error("get"); }, set() { throw new Error("set"); } };
      const runner = new FakeSubagentRunner(answer);
      const interceptor = make(runner, { cache });
      const first = await interceptor.intercept({ filePath, agentContext: {} });
      const second = await interceptor.intercept({ filePath, agentContext: {} });
      strictEqual(first.wasIntercepted, true);
      strictEqual(second.wasIntercepted, true);
      strictEqual(runner.calls.length, 2);
    });
  });

  it("hits for identical content at another path and reports that path", async () => {
    await withFile(large, async (filePath, directory) => {
      const copy = join(directory, "copy.txt");
      copyFileSync(filePath, copy);
      const runner = new FakeSubagentRunner(answer);
      const interceptor = make(runner, { cache: new LruResultCache() });
      await interceptor.intercept({ filePath, agentContext: {} });
      const second = await interceptor.intercept({ filePath: copy, agentContext: {} });
      strictEqual(second.cacheHit, true);
      strictEqual(second.filePath, copy);
      strictEqual(runner.calls.length, 1);
    });
  });

  it("logs hits at info level with cacheHit", async () => {
    await withFile(large, async (filePath) => {
      const events: InterceptionEvent[] = [];
      const interceptor = make(new FakeSubagentRunner(answer), { cache: new LruResultCache(), logger: (event) => events.push(event) });
      await interceptor.intercept({ filePath, agentContext: {} });
      await interceptor.intercept({ filePath, agentContext: {} });
      strictEqual(events[0].cacheHit, undefined);
      strictEqual(events[1].intercepted, true);
      strictEqual(events[1].cacheHit, true);
      strictEqual(eventLogLevel(events[1]), "info");
    });
  });

  it("hits for chunked reads preserving chunks", async () => {
    await withFile(large, async (filePath) => {
      const fake = new FakeSubagentRunner(answer);
      const interceptor = make(new ConcurrencyLimitedRunner(fake, 4), { cache: new LruResultCache(), chunkLines: 1000 });
      const first = await interceptor.intercept({ filePath, agentContext: {} });
      const calls = fake.calls.length;
      const second = await interceptor.intercept({ filePath, agentContext: {} });
      strictEqual(fake.calls.length, calls);
      strictEqual(second.cacheHit, true);
      strictEqual(second.chunks, first.chunks);
      ok((second.chunks ?? 0) > 1);
    });
  });

  describe("concurrent identical reads", () => {
    const slow = (respond: (request: SubagentRequest) => SubagentResult) => {
      let calls = 0;
      return { get calls() { return calls; }, async run(request: SubagentRequest) { calls++; await new Promise((r) => setTimeout(r, 20)); return respond(request); } };
    };

    it("share one runner call and report the follower as a cache hit", async () => {
      await withFile(large, async (filePath) => {
        const runner = slow(answer);
        const interceptor = new ReadInterceptor({ runner, thresholdLines: 1, model, cache: new LruResultCache() });
        const [a, b] = await Promise.all([interceptor.intercept({ filePath, agentContext: {} }), interceptor.intercept({ filePath, agentContext: {} })]);
        strictEqual(runner.calls, 1);
        strictEqual(a.cacheHit, undefined);
        strictEqual(b.cacheHit, true);
        deepStrictEqual(b.excerpts, a.excerpts);
      });
    });

    it("run independently when the first one falls back", async () => {
      await withFile(large, async (filePath) => {
        let n = 0;
        const runner = slow((request) => (n++ === 0 ? { text: "garbage" } : answer(request)));
        const interceptor = new ReadInterceptor({ runner, thresholdLines: 1, model, cache: new LruResultCache() });
        const [a, b] = await Promise.all([interceptor.intercept({ filePath, agentContext: {} }), interceptor.intercept({ filePath, agentContext: {} })]);
        strictEqual(a.wasIntercepted, false);
        strictEqual(b.wasIntercepted, true);
        strictEqual(b.cacheHit, undefined);
        strictEqual(runner.calls, 2);
      });
    });
  });

  it("calls the runner each time without a cache", async () => {
    await withFile(large, async (filePath) => {
      const runner = new FakeSubagentRunner(answer);
      const interceptor = make(runner);
      await interceptor.intercept({ filePath, agentContext: {} });
      const second = await interceptor.intercept({ filePath, agentContext: {} });
      strictEqual(runner.calls.length, 2);
      strictEqual(second.cacheHit, undefined);
    });
  });

  it("never consults the cache for below-threshold files", async () => {
    await withFile("a\nb\nc", async (filePath) => {
      let gets = 0;
      const cache: ResultCache = { get() { gets++; return undefined; }, set() { gets++; } };
      const result = await make(new FakeSubagentRunner(answer), { cache, thresholdLines: 350 }).intercept({ filePath, agentContext: {} });
      strictEqual(result.wasIntercepted, false);
      strictEqual(gets, 0);
    });
  });
});
