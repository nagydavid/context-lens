import { ok, strictEqual } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LruResultCache } from "./cache.js";
import { FakeSubagentRunner } from "./fake-runner.js";
import { eventLogLevel, ReadInterceptor, type InterceptionEvent } from "./interceptor.js";
import type { FallbackReason } from "./models.js";
import type { PdfExtractor } from "./pdf.js";

const model = { providerID: "test", modelID: "test" };
const extracted = Array.from({ length: 3 }, (_, page) => [
  `--- page ${page + 1} ---`,
  ...Array.from({ length: 130 }, (_, line) => `Page ${page + 1}, extracted line ${line + 1}.`),
]).flat().join("\n");
const answer = { structured: { excerpts: [{ startLine: 1, endLine: 3, reason: "page one" }], summary: "answer", confidence: 4 } };

async function withPdf(run: (filePath: string, directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "paradoc-interceptor-pdf-"));
  const filePath = join(directory, "guide.pdf");
  writeFileSync(filePath, "%PDF-1.4\nminimal fixture");
  try { await run(filePath, directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function extractor(result: Awaited<ReturnType<PdfExtractor>>): PdfExtractor {
  return async () => result;
}

function make(runner: FakeSubagentRunner, pdfExtractor: PdfExtractor, extra = {}) {
  return new ReadInterceptor({ runner, pdfExtractor, thresholdLines: 1, minTokens: 1, model, ...extra });
}

describe("ReadInterceptor PDFs", () => {
  it("intercepts extracted PDF text, slices marked lines, and uses the PDF prompt", async () => {
    await withPdf(async (filePath) => {
      const runner = new FakeSubagentRunner(answer);
      const result = await make(runner, extractor({ ok: true, text: extracted, pages: 3 })).intercept({ filePath, agentContext: {} });
      strictEqual(result.wasIntercepted, true);
      strictEqual(result.excerpts[0].content, extracted.split("\n").slice(0, 3).join("\n"));
      ok(runner.calls[0].prompt.includes("extracted from a PDF"));
    });
  });

  it("reports every PDF guard or extractor failure as a logged fallback", async () => {
    await withPdf(async (filePath, directory) => {
      const failures: Array<[FallbackReason, PdfExtractor, Record<string, unknown>?]> = [
        ...(["pdf-encrypted", "pdf-malformed", "pdf-no-text", "pdf-too-large", "extractor-unavailable", "timeout"] as FallbackReason[])
          .map((reason) => [reason, extractor({ ok: false, reason, error: "extract failed", detail: `${reason} detail` })] as [FallbackReason, PdfExtractor]),
        ["file-too-large", extractor({ ok: true, text: extracted, pages: 3 }), { maxFileBytes: 2 }],
      ];
      for (const [reason, pdfExtractor, options] of failures) {
        const events: InterceptionEvent[] = [];
        const result = await make(new FakeSubagentRunner(answer), pdfExtractor, { ...options, logger: (event: InterceptionEvent) => events.push(event) }).intercept({ filePath, agentContext: {} });
        strictEqual(result.wasIntercepted, false, reason);
        strictEqual(result.excerpts.length, 0, reason);
        strictEqual(result.fallback?.reason, reason, reason);
        strictEqual(events[0].fallbackReason, reason, reason);
        ok(events[0].detail, reason);
        strictEqual(eventLogLevel(events[0]), "warn", reason);
      }
      const events: InterceptionEvent[] = [];
      const missing = await make(new FakeSubagentRunner(answer), extractor({ ok: true, text: extracted, pages: 3 }), { logger: (event: InterceptionEvent) => events.push(event) })
        .intercept({ filePath: join(directory, "missing.pdf"), agentContext: {} });
      strictEqual(missing.fallback?.reason, "file-not-found");
      strictEqual(events[0].fallbackReason, "file-not-found");
      ok(events[0].detail);
      strictEqual(eventLogLevel(events[0]), "warn");
    });
  });

  it("passes small extracted PDFs through unchanged", async () => {
    await withPdf(async (filePath) => {
      const text = "--- page 1 ---\nA sufficiently readable PDF paragraph.";
      const runner = new FakeSubagentRunner(answer);
      const result = await make(runner, extractor({ ok: true, text, pages: 1 }), { thresholdLines: 350 }).intercept({ filePath, agentContext: {} });
      strictEqual(result.wasIntercepted, false);
      strictEqual(result.fallback, undefined);
      strictEqual(result.excerpts[0].content, text);
      strictEqual(runner.calls.length, 0);
    });
  });

  it("keys cached PDF results by extracted text and does not cache extraction failures", async () => {
    await withPdf(async (filePath) => {
      let text = extracted;
      const dynamic: PdfExtractor = async () => ({ ok: true, text, pages: 3 });
      const runner = new FakeSubagentRunner(answer);
      const interceptor = make(runner, dynamic, { cache: new LruResultCache() });
      await interceptor.intercept({ filePath, agentContext: {} });
      const calls = runner.calls.length;
      const hit = await interceptor.intercept({ filePath, agentContext: {} });
      strictEqual(hit.cacheHit, true);
      strictEqual(runner.calls.length, calls);
      text = `${extracted}\nchanged`;
      const miss = await interceptor.intercept({ filePath, agentContext: {} });
      strictEqual(miss.cacheHit, undefined);
      ok(runner.calls.length > calls);

      let fail = true;
      const retry: PdfExtractor = async () => fail
        ? { ok: false, reason: "pdf-no-text", error: "none", detail: "none" }
        : { ok: true, text: extracted, pages: 3 };
      const retryRunner = new FakeSubagentRunner(answer);
      const retryInterceptor = make(retryRunner, retry, { cache: new LruResultCache() });
      await retryInterceptor.intercept({ filePath, agentContext: {} });
      fail = false;
      const recovered = await retryInterceptor.intercept({ filePath, agentContext: {} });
      strictEqual(recovered.wasIntercepted, true);
      strictEqual(retryRunner.calls.length, 1);
    });
  });

  it("rejects a non-PDF header before invoking the extractor", async () => {
    await withPdf(async (filePath) => {
      writeFileSync(filePath, "not a PDF");
      let calls = 0;
      const pdfExtractor: PdfExtractor = async () => { calls++; return { ok: true, text: extracted, pages: 3 }; };
      const result = await make(new FakeSubagentRunner(answer), pdfExtractor).intercept({ filePath, agentContext: {} });
      strictEqual(result.fallback?.reason, "pdf-malformed");
      strictEqual(calls, 0);
    });
  });
});
