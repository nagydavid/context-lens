import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { LruResultCache } from "./cache.js";
import { FakeSubagentRunner } from "./fake-runner.js";
import { ReadInterceptor, eventLogLevel, type InterceptionEvent } from "./interceptor.js";
import { readWebDocument } from "./web-document.js";
import type { WebFetchOptions, WebTransport, WebTransportResponse } from "./web-fetch.js";

const PUBLIC = async () => ["93.184.216.34"];
const URL_OK = "https://docs.example.com/guide";

async function* chunks(text: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(text);
}

function page(type: string, body: string, status = 200, extra: Record<string, string> = {}): WebTransport {
  return async () => ({ status, headers: { "content-type": type, ...extra }, body: chunks(body) }) as WebTransportResponse;
}

const paragraphs = Array.from({ length: 300 }, (_, i) => `<p>Paragraph ${i + 1} explains configuration option number ${i + 1} in useful detail.</p>`).join("\n");
const bigHtml = `<html><head><title>Guide Title</title></head><body><nav>NAVIGATION-CHROME</nav><main><h1>Guide</h1>${paragraphs}</main><footer>FOOTER-CHROME</footer></body></html>`;

const answer = { excerpts: [{ startLine: 10, endLine: 12, reason: "relevant" }], summary: "Found it.", confidence: 4 };

function setup(transport: WebTransport, over: Partial<ConstructorParameters<typeof ReadInterceptor>[0]> = {}, fetchOver: Partial<WebFetchOptions> = {}) {
  const events: InterceptionEvent[] = [];
  const runner = new FakeSubagentRunner({ structured: answer });
  const interceptor = new ReadInterceptor({ runner, logger: (e) => events.push(e), ...over });
  const deps = { interceptor, fetchOptions: { transport, resolveHost: PUBLIC, ...fetchOver } };
  return { events, runner, interceptor, deps };
}

describe("readWebDocument", () => {
  it("condenses a large html page without chrome and caches repeats", async () => {
    const { runner, deps } = setup(page("text/html", bigHtml), { cache: new LruResultCache() });
    const first = await readWebDocument({ url: URL_OK, question: "options?", agentContext: {} }, deps);
    strictEqual(first.wasIntercepted, true);
    strictEqual(first.url, URL_OK);
    strictEqual(first.title, "Guide Title");
    ok(first.contentSha256);
    strictEqual(first.excerpts[0].startLine, 10);
    const sent = JSON.stringify(runner.calls[0]);
    ok(!sent.includes("NAVIGATION-CHROME") && !sent.includes("FOOTER-CHROME"));
    ok(sent.includes("# Guide Title") && sent.includes(`Source: ${URL_OK}`));
    const second = await readWebDocument({ url: URL_OK, question: "options?", agentContext: {} }, deps);
    strictEqual(second.cacheHit, true);
    strictEqual(runner.calls.length, 1);
  });

  it("passes markdown through unconverted with LF newlines", async () => {
    const { deps } = setup(page("text/markdown", "# Doc\r\n\r\n<b>raw</b>\r\n"));
    const r = await readWebDocument({ url: URL_OK, agentContext: {} }, deps);
    strictEqual(r.wasIntercepted, false);
    strictEqual(r.excerpts[0].content, `Source: ${URL_OK}\n\n# Doc\n\n<b>raw</b>`);
  });

  it("returns a small page whole and unintercepted", async () => {
    const { runner, deps } = setup(page("text/html", "<html><body><main><p>Hi there</p></main></body></html>"));
    const r = await readWebDocument({ url: URL_OK, question: "q", agentContext: {} }, deps);
    strictEqual(r.wasIntercepted, false);
    ok(r.excerpts[0].content.includes("Hi there"));
    strictEqual(runner.calls.length, 0);
  });

  it("serves deterministic ranged slices, bypassing the runner", async () => {
    const { runner, interceptor, deps } = setup(page("text/html", bigHtml));
    const a = await readWebDocument({ url: URL_OK, startLine: 5, endLine: 8, agentContext: {} }, deps);
    const b = await readWebDocument({ url: URL_OK, startLine: 5, endLine: 8, agentContext: {} }, deps);
    strictEqual(a.ranged, true);
    deepStrictEqual(a.excerpts, b.excerpts);
    strictEqual(a.excerpts[0].content.split("\n").length, 4);
    strictEqual(a.totalLinesReturned, 4);
    strictEqual(runner.calls.length, 0);
    strictEqual(interceptor.stats().bypassed, 2);
    const open = await readWebDocument({ url: URL_OK, startLine: a.fullLineCount, endLine: 99999, agentContext: {} }, deps);
    strictEqual(open.totalLinesReturned, 1);
  });

  it("rejects invalid ranges", async () => {
    const { deps } = setup(page("text/html", bigHtml));
    for (const range of [{ startLine: 99999 }, { startLine: 9, endLine: 3 }, { startLine: 0 }]) {
      const r = await readWebDocument({ url: URL_OK, ...range, agentContext: {} }, deps);
      strictEqual(r.error, "invalid range");
      strictEqual(r.fallback, undefined);
    }
  });

  it("bounds the fallback when the runner times out", async () => {
    const { deps } = setup(page("text/html", bigHtml), { runner: new FakeSubagentRunner({ structured: answer }, 200), timeoutMs: 20 });
    const r = await readWebDocument({ url: URL_OK, question: "q", agentContext: {} }, { ...deps, maxFallbackLines: 50 });
    strictEqual(r.fallback?.reason, "timeout");
    strictEqual(r.truncated, true);
    strictEqual(r.totalLinesReturned, 50);
    strictEqual(r.excerpts[0].content.split("\n").length, 50);
    ok(r.fullLineCount > 50);
  });

  it("caps converted lines and chars", async () => {
    const { deps } = setup(page("text/plain", Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")));
    const byLines = await readWebDocument({ url: URL_OK, agentContext: {} }, { ...deps, maxConvertedLines: 10 });
    strictEqual(byLines.truncated, true);
    strictEqual(byLines.fullLineCount, 11);
    ok(byLines.excerpts[0].content.endsWith("[paradoc: converted page truncated at 10 lines]"));
    const byChars = await readWebDocument({ url: URL_OK, agentContext: {} }, { ...deps, maxConvertedChars: 200 });
    strictEqual(byChars.truncated, true);
    ok(byChars.excerpts[0].content.includes("[paradoc: converted page truncated at"));
  });

  const failures: Array<[string, string, string, (o: Partial<WebFetchOptions>) => { url: string; transport?: WebTransport; fetch?: Partial<WebFetchOptions> }]> = [
    ["invalid-url", "invalid-url", "nope", () => ({ url: "nope" })],
    ["unsafe-url", "unsafe-url", "private resolve", () => ({ url: URL_OK, fetch: { resolveHost: async () => ["10.0.0.5"] } })],
    ["fetch-failed", "fetch-failed", "transport rejects", () => ({ url: URL_OK, transport: async () => { throw new Error("boom"); } })],
    ["timeout", "timeout", "deadline", () => ({ url: URL_OK, fetch: { timeoutMs: 20 }, transport: (async (req) => new Promise((_, rej) => req.signal.addEventListener("abort", () => rej(new Error("aborted"))))) as WebTransport })],
    ["unsupported-content-type", "unsupported-content-type", "image", () => ({ url: URL_OK, transport: page("image/png", "x") })],
    ["content-too-large", "content-too-large", "big body", () => ({ url: URL_OK, fetch: { maxBytes: 10 }, transport: page("text/plain", "x".repeat(100)) })],
    ["too-many-redirects", "too-many-redirects", "loop", () => ({ url: URL_OK, transport: page("text/html", "", 302, { location: "/guide" }) })],
  ];
  for (const [name, reason, , build] of failures) {
    it(`returns a visible ${name} error and logs at warn`, async () => {
      const spec = build({});
      const { events, deps } = setup(spec.transport ?? page("text/plain", "x"), {}, spec.fetch ?? {});
      const r = await readWebDocument({ url: spec.url, agentContext: {} }, deps);
      ok(r.error, "error text");
      strictEqual(r.fallback?.reason, reason);
      strictEqual(r.wasIntercepted, false);
      strictEqual(r.fullLineCount, 0);
      strictEqual(events.length, 1);
      strictEqual(events[0].fallbackReason, reason);
      strictEqual(eventLogLevel(events[0]), "warn");
      strictEqual(deps.interceptor.stats().fallbacks, 1);
    });
  }

  it("never leaks query strings", async () => {
    const bad = setup(page("image/png", "x"));
    const r = await readWebDocument({ url: `${URL_OK}?token=secret`, agentContext: {} }, bad.deps);
    const ok1 = setup(page("text/plain", "hello"));
    const r2 = await readWebDocument({ url: `${URL_OK}?token=secret`, agentContext: {} }, ok1.deps);
    for (const text of [JSON.stringify(r), JSON.stringify(bad.events), JSON.stringify(r2), JSON.stringify(ok1.events)]) {
      ok(!text.includes("secret"), text);
    }
    ok(r.url.includes("<redacted>"));
  });
});
