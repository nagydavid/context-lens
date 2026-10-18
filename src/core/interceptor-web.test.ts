import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { LruResultCache } from "./cache.js";
import { FakeSubagentRunner } from "./fake-runner.js";
import { ReadInterceptor, type InterceptionEvent } from "./interceptor.js";

const LABEL = "https://example.com/docs/guide";
const excerpt = {
  excerpts: [{ startLine: 42, endLine: 45, reason: "relevant section" }],
  summary: "The requested section.",
  confidence: 4,
};
const content = Array.from({ length: 400 }, (_, i) => `Web line ${i + 1} has enough prose to exercise interception.`).join("\n");
const request = (over: Partial<Parameters<ReadInterceptor["interceptContent"]>[0]> = {}) =>
  ({ label: LABEL, content, documentKind: "web-page" as const, question: "How?", agentContext: {}, ...over });

describe("ReadInterceptor.interceptContent", () => {
  it("condenses large content using lines from the provided content", async () => {
    const runner = new FakeSubagentRunner({ structured: excerpt });
    const result = await new ReadInterceptor({ runner }).interceptContent(request());
    strictEqual(result.wasIntercepted, true);
    strictEqual(result.filePath, LABEL);
    strictEqual(result.excerpts[0].startLine, 42);
    strictEqual(result.excerpts[0].content, content.split("\n").slice(41, 45).join("\n"));
  });

  it("returns small content in full without calling the runner", async () => {
    const runner = new FakeSubagentRunner({ structured: excerpt });
    const result = await new ReadInterceptor({ runner }).interceptContent(request({ content: "tiny page" }));
    strictEqual(result.wasIntercepted, false);
    strictEqual(result.excerpts[0].content, "tiny page");
    strictEqual(runner.calls.length, 0);
  });

  it("falls back with the full content when there is no runner", async () => {
    const result = await new ReadInterceptor().interceptContent(request());
    strictEqual(result.wasIntercepted, false);
    strictEqual(result.fallback?.reason, "no-runner");
    strictEqual(result.excerpts[0].content, content);
  });

  it("falls back with timeout when the runner is too slow", async () => {
    const runner = new FakeSubagentRunner({ structured: excerpt }, 200);
    const result = await new ReadInterceptor({ runner, timeoutMs: 20 }).interceptContent(request());
    strictEqual(result.fallback?.reason, "timeout");
    strictEqual(result.excerpts[0].content, content);
  });

  it("keys the cache with the web-page suffix and serves repeats from cache", async () => {
    const runner = new FakeSubagentRunner({ structured: excerpt });
    const interceptor = new ReadInterceptor({ runner, cache: new LruResultCache() });
    const first = await interceptor.interceptContent(request());
    strictEqual(first.cacheHit, undefined);
    const other = await interceptor.interceptContent(request({ documentKind: "text-document" }));
    strictEqual(other.cacheHit, undefined);
    strictEqual(runner.calls.length, 2);
    const repeat = await interceptor.interceptContent(request());
    strictEqual(repeat.cacheHit, true);
    strictEqual(runner.calls.length, 2);
  });

  it("dedupes concurrent identical calls", async () => {
    const runner = new FakeSubagentRunner({ structured: excerpt }, 30);
    const interceptor = new ReadInterceptor({ runner, cache: new LruResultCache() });
    const [a, b] = await Promise.all([interceptor.interceptContent(request()), interceptor.interceptContent(request())]);
    strictEqual(runner.calls.length, 1);
    strictEqual(a.wasIntercepted && b.wasIntercepted, true);
    strictEqual(b.cacheHit, true);
  });

  it("logs exactly one event per call labelled with the label and prompts carry the untrusted notice", async () => {
    const events: InterceptionEvent[] = [];
    const runner = new FakeSubagentRunner({ structured: excerpt });
    const interceptor = new ReadInterceptor({ runner, logger: (e) => events.push(e) });
    await interceptor.interceptContent(request());
    await interceptor.interceptContent(request({ content: "tiny" }));
    strictEqual(events.length, 2);
    ok(events.every((e) => e.filePath === LABEL));
    ok(runner.calls[0].prompt.includes("untrusted external data"));
    ok(runner.calls[0].prompt.includes(`FILE: ${LABEL}`));
    strictEqual(interceptor.stats().intercepted + interceptor.stats().passthrough, 2);
  });
});
