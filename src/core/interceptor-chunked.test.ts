import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildSubagentPrompt } from "./prompts.js";
import { ReadInterceptor } from "./interceptor.js";
import { ConcurrencyLimitedRunner, type SubagentRequest, type SubagentResult, type SubagentRunner } from "./subagent.js";

const content = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`).join("\n");

async function withFile(run: (filePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "context-lens-chunks-"));
  const filePath = join(directory, "large.txt");
  writeFileSync(filePath, content);
  try { await run(filePath); } finally { rmSync(directory, { recursive: true, force: true }); }
}

class TrackingRunner implements SubagentRunner {
  calls: SubagentRequest[] = [];
  inFlight = 0;
  maxInFlight = 0;
  constructor(private readonly handler: (request: SubagentRequest) => SubagentResult | Promise<SubagentResult>) {}
  async run(request: SubagentRequest): Promise<SubagentResult> {
    this.calls.push(request);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try { return await this.handler(request); } finally { this.inFlight -= 1; }
  }
}

function rangeFor(request: SubagentRequest): [number, number] {
  const match = request.prompt.match(/This is lines (\d+)-(\d+)/);
  if (!match) throw new Error("window missing from prompt");
  return [Number(match[1]), Number(match[2])];
}

function answerFor(request: SubagentRequest): SubagentResult {
  const [start] = rangeFor(request);
  return { structured: { excerpts: [{ startLine: start + 1, endLine: start + 2 }], summary: `at ${start}`, confidence: start === 1 ? 3 : 5 } };
}

describe("ReadInterceptor chunked fan-out", () => {
  it("fans out windows to the concurrency limit and slices real file lines", async () => {
    await withFile(async (filePath) => {
      const events: Array<{ chunks?: number }> = [];
      const fake = new TrackingRunner(async (request) => { await delay(10); return answerFor(request); });
      const result = await new ReadInterceptor({ runner: new ConcurrencyLimitedRunner(fake, 3), chunkLines: 1000, chunkOverlapLines: 50, logger: (event) => events.push(event) }).intercept({ filePath, agentContext: {} });
      strictEqual(fake.calls.length, 4);
      ok(fake.maxInFlight > 1 && fake.maxInFlight <= 3);
      strictEqual(result.wasIntercepted, true);
      strictEqual(result.chunks, 4);
      strictEqual(events[0].chunks, 4);
      strictEqual(result.confidence, 5);
      for (const excerpt of result.excerpts) strictEqual(excerpt.content, content.split("\n").slice(excerpt.startLine - 1, excerpt.endLine).join("\n"));
    });
  });

  it("merges duplicate overlap ranges and has serial-equivalent output", async () => {
    await withFile(async (filePath) => {
      const handler = (request: SubagentRequest): SubagentResult => ({ structured: { excerpts: [{ startLine: 960, endLine: 970 }], summary: "overlap", confidence: 4 } });
      const parallel = await new ReadInterceptor({ runner: new ConcurrencyLimitedRunner(new TrackingRunner(handler), 3), chunkLines: 1000, chunkOverlapLines: 50 }).intercept({ filePath, agentContext: {} });
      const serialFake = new TrackingRunner(handler);
      const serial = await new ReadInterceptor({ runner: new ConcurrencyLimitedRunner(serialFake, 1), chunkLines: 1000, chunkOverlapLines: 50 }).intercept({ filePath, agentContext: {} });
      strictEqual(parallel.excerpts.length, 1);
      strictEqual(parallel.excerpts[0].startLine, 960);
      strictEqual(parallel.excerpts[0].endLine, 970);
      const { elapsedMs: parallelElapsed, ...parallelComparable } = parallel;
      const { elapsedMs: serialElapsed, ...serialComparable } = serial;
      void parallelElapsed; void serialElapsed;
      deepStrictEqual(serialComparable, parallelComparable);
      strictEqual(serialFake.calls.length, 4);
      strictEqual(serialFake.maxInFlight, 1);
    });
  });

  it("falls back for chunk errors, malformed answers, and empty chunk answers", async () => {
    await withFile(async (filePath) => {
      const cases: Array<[string, (request: SubagentRequest) => SubagentResult]> = [
        ["subagent-error", (request) => { if (rangeFor(request)[0] === 951) throw new Error("chunk unavailable"); return answerFor(request); }],
        ["invalid-response", (request) => rangeFor(request)[0] === 951 ? { text: "not json" } : answerFor(request)],
        ["invalid-confidence", (request) => rangeFor(request)[0] === 951 ? { structured: { excerpts: [], summary: "bad", confidence: 8 } } : answerFor(request)],
      ];
      for (const [reason, handler] of cases) {
        const events: Array<{ detail?: string }> = [];
        const result = await new ReadInterceptor({ runner: new ConcurrencyLimitedRunner(new TrackingRunner(handler), 1), chunkLines: 1000, chunkOverlapLines: 50, logger: (event) => events.push(event) }).intercept({ filePath, agentContext: {} });
        strictEqual(result.fallback?.reason, reason);
        ok(events[0].detail?.startsWith("chunk 2/4:"));
        strictEqual(result.excerpts[0].content, content);
      }
      const empty = await new ReadInterceptor({ runner: new TrackingRunner(() => ({ structured: { excerpts: [], summary: "", confidence: 1 } })), chunkLines: 1000, chunkOverlapLines: 50 }).intercept({ filePath, agentContext: {} });
      strictEqual(empty.fallback?.reason, "no-valid-excerpts");
    });
  });

  it("retries transient chunk errors and reports the maximum attempts", async () => {
    await withFile(async (filePath) => {
      let firstChunkAttempts = 0;
      const runner = new TrackingRunner((request) => {
        if (rangeFor(request)[0] === 1 && firstChunkAttempts++ === 0) {
          throw Object.assign(new Error("network reset"), { code: "ECONNRESET" });
        }
        return answerFor(request);
      });
      const result = await new ReadInterceptor({ runner: new ConcurrencyLimitedRunner(runner, 3), chunkLines: 1000, chunkOverlapLines: 50, maxRetries: 1, retryDelayMs: 1 }).intercept({ filePath, agentContext: {} });
      strictEqual(result.wasIntercepted, true);
      strictEqual(result.attempts, 2);
      strictEqual(runner.calls.length, 5);
    });
  });

  it("uses one shared deadline and preserves the unchunked prompt", async () => {
    await withFile(async (filePath) => {
      const slow = new TrackingRunner(async () => { await delay(150); return { structured: { excerpts: [{ startLine: 1, endLine: 2 }], summary: "slow", confidence: 4 } }; });
      const started = performance.now();
      const timeout = await new ReadInterceptor({ runner: new ConcurrencyLimitedRunner(slow, 1), chunkLines: 1000, chunkOverlapLines: 50, timeoutMs: 200 }).intercept({ filePath, agentContext: {} });
      strictEqual(timeout.fallback?.reason, "timeout");
      ok((timeout.elapsedMs ?? Infinity) < 600);

      const shortPath = join(tmpdir(), `context-lens-short-${Date.now()}.txt`);
      const shortContent = Array.from({ length: 900 }, (_, index) => `line ${index + 1}`).join("\n");
      writeFileSync(shortPath, shortContent);
      try {
        const runner = new TrackingRunner(() => ({ structured: { excerpts: [{ startLine: 1, endLine: 2 }], summary: "one", confidence: 4 } }));
        const result = await new ReadInterceptor({ runner, thresholdLines: 1, chunkLines: 1000 }).intercept({ filePath: shortPath, agentContext: {} });
        strictEqual(runner.calls.length, 1);
        strictEqual(result.chunks, undefined);
        strictEqual(runner.calls[0].prompt, buildSubagentPrompt({ filePath: shortPath, fileContent: shortContent, question: "What is the main purpose of this file and what are its key exports, types and entry points?", questionSource: "inferred", agentContext: {} }));
      } finally { rmSync(shortPath, { force: true }); }
      const unsetRunner = new TrackingRunner(() => ({ structured: { excerpts: [{ startLine: 1, endLine: 2 }], summary: "unset", confidence: 4 } }));
      const unset = await new ReadInterceptor({ runner: unsetRunner }).intercept({ filePath, agentContext: {} });
      strictEqual(unsetRunner.calls.length, 1);
      strictEqual(unset.chunks, undefined);
      void started;
    });
  });
});

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
