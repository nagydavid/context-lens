import { deepStrictEqual, ok, strictEqual } from "node:assert";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import zlib from "node:zlib";
import { fetchWebDocument, type WebFetchResult, type WebTransport, type WebTransportRequest, type WebTransportResponse } from "./web-fetch.js";

const PUBLIC = async () => ["93.184.216.34"];

async function* chunks(...parts: Array<Buffer | string>): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === "string" ? Buffer.from(part) : part;
}

function reply(status: number, headers: Record<string, string>, ...body: Array<Buffer | string>): WebTransportResponse {
  return { status, headers, body: chunks(...body) };
}

function fake(responses: Array<WebTransportResponse | ((req: WebTransportRequest) => WebTransportResponse)>) {
  const seen: WebTransportRequest[] = [];
  let index = 0;
  const transport: WebTransport = async (req) => {
    seen.push(req);
    const next = responses[Math.min(index++, responses.length - 1)];
    return typeof next === "function" ? next(req) : next;
  };
  return { transport, seen };
}

const target = new URL("https://docs.example.com/guide");

function failed(result: WebFetchResult): Extract<WebFetchResult, { ok: false }> {
  ok(!result.ok, "expected failure");
  return result as Extract<WebFetchResult, { ok: false }>;
}

describe("fetchWebDocument with a fake transport", () => {
  it("fetches html, markdown and plain text", async () => {
    for (const type of ["text/html; charset=utf-8", "text/markdown", "text/plain", "application/xhtml+xml", "text/x-markdown"]) {
      const { transport } = fake([reply(200, { "content-type": type }, "hello ", "world")]);
      const result = await fetchWebDocument(target, { transport, resolveHost: PUBLIC });
      ok(result.ok, type);
      strictEqual(result.text, "hello world");
      strictEqual(result.bytes, 11);
      strictEqual(result.redirects, 0);
      strictEqual(result.mediaType, type.split(";")[0]);
    }
  });

  it("sends safe headers and never cookies or authorization", async () => {
    const { transport, seen } = fake([reply(200, { "content-type": "text/plain" }, "x")]);
    await fetchWebDocument(target, { transport, resolveHost: PUBLIC });
    const names = Object.keys(seen[0].headers).map((n) => n.toLowerCase());
    ok(!names.includes("authorization"));
    ok(!names.includes("cookie"));
    strictEqual(seen[0].headers["Accept-Encoding"], "identity");
    strictEqual(seen[0].headers["User-Agent"], "paradoc-web-read/0.1");
  });

  it("decodes by header charset, meta charset and defaults to utf-8", async () => {
    const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    let r = await fetchWebDocument(target, { transport: fake([reply(200, { "content-type": "text/plain; charset=iso-8859-1" }, latin)]).transport, resolveHost: PUBLIC });
    ok(r.ok);
    strictEqual(r.text, "café");
    const html = Buffer.concat([Buffer.from('<html><head><meta charset="iso-8859-1"></head>'), latin]);
    r = await fetchWebDocument(target, { transport: fake([reply(200, { "content-type": "text/html" }, html)]).transport, resolveHost: PUBLIC });
    ok(r.ok);
    ok(r.text.endsWith("café"));
    r = await fetchWebDocument(target, { transport: fake([reply(200, { "content-type": "text/plain" }, "café")]).transport, resolveHost: PUBLIC });
    ok(r.ok);
    strictEqual(r.text, "café");
    r = await fetchWebDocument(target, { transport: fake([reply(200, { "content-type": "text/plain; charset=bogus-label" }, "plain")]).transport, resolveHost: PUBLIC });
    ok(r.ok);
    strictEqual(r.text, "plain");
  });

  it("follows redirects within the limit and reports the final URL", async () => {
    const { transport, seen } = fake([
      reply(301, { location: "/b" }),
      reply(302, { location: "https://other.example.org/c#frag" }),
      reply(200, { "content-type": "text/plain" }, "done"),
    ]);
    const result = await fetchWebDocument(target, { transport, resolveHost: PUBLIC });
    ok(result.ok);
    strictEqual(result.redirects, 2);
    strictEqual(result.finalUrl.href, "https://other.example.org/c");
    deepStrictEqual(seen.map((s) => s.url.href), ["https://docs.example.com/guide", "https://docs.example.com/b", "https://other.example.org/c"]);
  });

  it("fails with too-many-redirects on overflow", async () => {
    const { transport } = fake([reply(302, { location: "/loop" })]);
    const result = failed(await fetchWebDocument(target, { transport, resolveHost: PUBLIC, maxRedirects: 3 }));
    strictEqual(result.reason, "too-many-redirects");
  });

  it("rejects a redirect to a host that resolves privately", async () => {
    const { transport, seen } = fake([reply(302, { location: "https://internal.example.org/" }), reply(200, { "content-type": "text/plain" }, "secret")]);
    const resolveHost = async (host: string) => (host === "internal.example.org" ? ["10.0.0.5"] : ["93.184.216.34"]);
    const result = failed(await fetchWebDocument(target, { transport, resolveHost }));
    strictEqual(result.reason, "unsafe-url");
    strictEqual(seen.length, 1);
    ok(!result.detail.includes("10.0.0.5"));
  });

  it("rejects a redirect to a file: URL and to an IP literal", async () => {
    let r = failed(await fetchWebDocument(target, { transport: fake([reply(302, { location: "file:///etc/passwd" })]).transport, resolveHost: PUBLIC }));
    strictEqual(r.reason, "unsafe-url");
    r = failed(await fetchWebDocument(target, { transport: fake([reply(302, { location: "http://169.254.169.254/latest" })]).transport, resolveHost: PUBLIC }));
    strictEqual(r.reason, "unsafe-url");
  });

  it("rejects an initially private resolution before calling the transport", async () => {
    const { transport, seen } = fake([reply(200, { "content-type": "text/plain" }, "x")]);
    const result = failed(await fetchWebDocument(target, { transport, resolveHost: async () => ["93.184.216.34", "127.0.0.1"] }));
    strictEqual(result.reason, "unsafe-url");
    strictEqual(seen.length, 0);
  });

  it("the guarded lookup handed to the transport rejects blocked addresses at connect time", async () => {
    let lookupError: unknown;
    let calls = 0;
    const resolveHost = async () => (++calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"]);
    const transport: WebTransport = async (req) => {
      try {
        await req.lookup!("docs.example.com");
      } catch (err) {
        lookupError = err;
        throw err;
      }
      return reply(200, { "content-type": "text/plain" }, "x");
    };
    const result = failed(await fetchWebDocument(target, { transport, resolveHost }));
    strictEqual(result.reason, "unsafe-url");
    ok(lookupError instanceof Error);
  });

  it("maps non-2xx statuses to fetch-failed with the status", async () => {
    const result = failed(await fetchWebDocument(target, { transport: fake([reply(404, { "content-type": "text/html" }, "nope")]).transport, resolveHost: PUBLIC }));
    strictEqual(result.reason, "fetch-failed");
    strictEqual(result.detail, "HTTP 404");
  });

  it("rejects disallowed and missing content types", async () => {
    for (const headers of [{ "content-type": "application/pdf" } as Record<string, string>,{ "content-type": "application/json" }, { "content-type": "image/png" }, {}]) {
      const result = failed(await fetchWebDocument(target, { transport: fake([reply(200, headers, "x")]).transport, resolveHost: PUBLIC }));
      strictEqual(result.reason, "unsupported-content-type");
    }
    const pdf = failed(await fetchWebDocument(target, { transport: fake([reply(200, { "content-type": "application/pdf" }, "x")]).transport, resolveHost: PUBLIC }));
    ok(pdf.detail.includes("application/pdf"));
  });

  it("stops reading an oversize streamed body", async () => {
    let pulled = 0;
    async function* endless(): AsyncGenerator<Uint8Array> {
      for (;;) {
        pulled += 1;
        yield Buffer.alloc(1024, 0x61);
      }
    }
    const transport: WebTransport = async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: endless() });
    const result = failed(await fetchWebDocument(target, { transport, resolveHost: PUBLIC, maxBytes: 4096 }));
    strictEqual(result.reason, "content-too-large");
    ok(pulled <= 6, `pulled ${pulled}`);
  });

  it("fails early on an oversize advertised content-length", async () => {
    const result = failed(await fetchWebDocument(target, { transport: fake([reply(200, { "content-type": "text/plain", "content-length": "99999" }, "x")]).transport, resolveHost: PUBLIC, maxBytes: 1000 }));
    strictEqual(result.reason, "content-too-large");
  });

  it("decodes gzip and rejects a gzip bomb by decompressed size", async () => {
    const good = zlib.gzipSync("compressed docs");
    const okResult = await fetchWebDocument(target, { transport: fake([reply(200, { "content-type": "text/plain", "content-encoding": "gzip" }, good)]).transport, resolveHost: PUBLIC });
    ok(okResult.ok);
    strictEqual(okResult.text, "compressed docs");
    const br = await fetchWebDocument(target, { transport: fake([reply(200, { "content-type": "text/plain", "content-encoding": "br" }, zlib.brotliCompressSync("brotli docs"))]).transport, resolveHost: PUBLIC });
    ok(br.ok);
    strictEqual(br.text, "brotli docs");
    const bomb = zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024, 0x61));
    ok(bomb.length < 10000);
    const result = failed(await fetchWebDocument(target, { transport: fake([reply(200, { "content-type": "text/plain", "content-encoding": "gzip" }, bomb)]).transport, resolveHost: PUBLIC, maxBytes: 1024 * 1024 }));
    strictEqual(result.reason, "content-too-large");
  });

  it("rejects unknown content encodings and corrupt compressed data", async () => {
    let r = failed(await fetchWebDocument(target, { transport: fake([reply(200, { "content-type": "text/plain", "content-encoding": "compress" }, "x")]).transport, resolveHost: PUBLIC }));
    strictEqual(r.reason, "fetch-failed");
    r = failed(await fetchWebDocument(target, { transport: fake([reply(200, { "content-type": "text/plain", "content-encoding": "gzip" }, "not gzip data")]).transport, resolveHost: PUBLIC }));
    strictEqual(r.reason, "fetch-failed");
  });

  it("rejects bodies with a NUL byte as binary", async () => {
    const result = failed(await fetchWebDocument(target, { transport: fake([reply(200, { "content-type": "text/plain" }, Buffer.from([0x61, 0x00, 0x62]))]).transport, resolveHost: PUBLIC }));
    strictEqual(result.reason, "unsupported-content-type");
  });

  it("times out a slow body across the whole fetch", async () => {
    async function* slow(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("start");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      yield Buffer.from("end");
    }
    const transport: WebTransport = async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: slow() });
    const started = Date.now();
    const result = failed(await fetchWebDocument(target, { transport, resolveHost: PUBLIC, timeoutMs: 100 }));
    strictEqual(result.reason, "timeout");
    strictEqual(result.detail, "fetch exceeded 100ms");
    ok(Date.now() - started < 1500);
  });

  it("times out a transport that never responds", async () => {
    const transport: WebTransport = () => new Promise(() => undefined);
    const result = failed(await fetchWebDocument(target, { transport, resolveHost: PUBLIC, timeoutMs: 50 }));
    strictEqual(result.reason, "timeout");
  });

  it("returns fetch-failed when resolution or the transport throws", async () => {
    let r = failed(await fetchWebDocument(target, { transport: fake([reply(200, { "content-type": "text/plain" }, "x")]).transport, resolveHost: async () => { throw new Error("ENOTFOUND"); } }));
    strictEqual(r.reason, "fetch-failed");
    ok(r.detail.includes("ENOTFOUND"));
    const transport: WebTransport = async () => { throw new Error("ECONNRESET"); };
    r = failed(await fetchWebDocument(target, { transport, resolveHost: PUBLIC }));
    strictEqual(r.reason, "fetch-failed");
    ok(r.detail.includes("ECONNRESET"));
  });

  it("rejects non-http URLs passed directly", async () => {
    const result = failed(await fetchWebDocument(new URL("file:///etc/passwd"), { resolveHost: PUBLIC }));
    strictEqual(result.reason, "unsafe-url");
  });
});

describe("fetchWebDocument with the default transport", () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/doc" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<h1>Hello</h1>");
  });
  const ready = new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
  after(() => server.close());

  it("fetches from a real server when private networks are allowed", async () => {
    const port = await ready;
    hits = 0;
    const result = await fetchWebDocument(new URL(`http://127.0.0.1:${port}/redirect`), { allowPrivateNetwork: true });
    ok(result.ok, JSON.stringify(result));
    strictEqual(result.text, "<h1>Hello</h1>");
    strictEqual(result.redirects, 1);
    strictEqual(hits, 2);
  });

  it("rejects the same server by default without connecting", async () => {
    const port = await ready;
    hits = 0;
    const result = failed(await fetchWebDocument(new URL(`http://127.0.0.1:${port}/doc`)));
    strictEqual(result.reason, "unsafe-url");
    const named = failed(await fetchWebDocument(new URL(`http://docs.example.test:${port}/doc`), { resolveHost: async () => ["127.0.0.1"] }));
    strictEqual(named.reason, "unsafe-url");
    strictEqual(hits, 0);
  });

  it("pins the connection to the resolveHost result for a named host", async () => {
    const port = await ready;
    hits = 0;
    const result = await fetchWebDocument(new URL(`http://docs.example.test:${port}/doc`), { allowPrivateNetwork: true, resolveHost: async () => ["127.0.0.1"] });
    ok(result.ok, JSON.stringify(result));
    strictEqual(result.text, "<h1>Hello</h1>");
    strictEqual(hits, 1);
  });

  it("reports a connection failure as fetch-failed", async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const result = failed(await fetchWebDocument(new URL(`http://127.0.0.1:${port}/`), { allowPrivateNetwork: true }));
    strictEqual(result.reason, "fetch-failed");
  });
});
