import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { createPdftotextExtractor, readPdfDocument } from "../core/pdf.js";
import { htmlToText } from "../core/web-html.js";
import { fetchWebDocument } from "../core/web-fetch.js";
import {
  materializeCorpus,
  goldRangesFor,
  sourceFixtureLines,
  wideLineFixtureLines,
  textDocumentFixtureLines,
  webFixtureHtml,
  pdfFixturePages,
  PDF_PAGES,
  type FileCorpusItem,
  type MaterializedCorpus,
  type WebCorpusItem,
} from "./corpus.js";

let dirA: string;
let dirB: string;
let corpus: MaterializedCorpus;

before(() => {
  dirA = mkdtempSync(join(tmpdir(), "paradoc-corpus-a-"));
  dirB = mkdtempSync(join(tmpdir(), "paradoc-corpus-b-"));
  corpus = materializeCorpus(dirA, { hasPdftotext: true });
});
after(() => {
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

function walk(dir: string, base = dir): Array<{ rel: string; bytes: Buffer }> {
  const out: Array<{ rel: string; bytes: Buffer }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push({ rel: relative(base, full), bytes: readFileSync(full) });
  }
  return out;
}

const fileItem = (id: string): FileCorpusItem => {
  const item = corpus.items.find((candidate) => candidate.id === id);
  ok(item && item.kind === "file", `missing file item ${id}`);
  return item as FileCorpusItem;
};
const webItem = (id: string): WebCorpusItem => {
  const item = corpus.items.find((candidate) => candidate.id === id);
  ok(item && item.kind === "web", `missing web item ${id}`);
  return item as WebCorpusItem;
};

describe("corpus manifest", () => {
  it("covers all four source types with positive and negative items", () => {
    const types = new Set(corpus.items.map((item) => item.sourceType));
    deepStrictEqual([...types].sort(), ["pdf-text", "source", "text-document", "web-page"]);
    for (const type of types) {
      const items = corpus.items.filter((item) => item.sourceType === type);
      ok(items.some((item) => item.expected === "intercept"), `${type} has no positive item`);
      ok(items.some((item) => item.expected.startsWith("fallback:")), `${type} has no negative item`);
    }
  });

  it("gives every item a unique id, a question and an expected outcome", () => {
    const ids = new Set<string>();
    for (const item of corpus.items) {
      ok(!ids.has(item.id), `duplicate id ${item.id}`);
      ids.add(item.id);
      ok(item.question.trim().length > 0, `${item.id} has no question`);
      ok(
        item.expected === "intercept" || item.expected === "passthrough" || /^fallback:[a-z-]+$/.test(item.expected),
        `${item.id} has an invalid expected outcome: ${item.expected}`,
      );
      ok(Array.isArray(item.goldNeedles), `${item.id} has no goldNeedles array`);
    }
    ok(corpus.items.length >= 18, `corpus is too small: ${corpus.items.length}`);
  });

  it("web items are served from canned fixtures, never the network", () => {
    for (const item of corpus.items.filter((candidate): candidate is WebCorpusItem => candidate.kind === "web")) {
      ok(typeof item.transport === "function", `${item.id} has no injected transport`);
      ok(typeof item.resolveHost === "function", `${item.id} has no injected lookup`);
      ok(item.url.startsWith("http"), `${item.id} has a non-http url`);
    }
  });

  it("computes gold ranges from the lines the generator actually wrote", () => {
    const source = sourceFixtureLines();
    const ranges = goldRangesFor(source, ["seven attempts per window before the ledger quarantines the entry"]);
    strictEqual(ranges.length, 1);
    const window = source.slice(ranges[0]!.startLine - 1, ranges[0]!.endLine);
    strictEqual(window.length, 3);
    ok(window.some((line) => line.includes("seven attempts per window")), "needle outside its gold range");

    for (const item of corpus.items) {
      if (!item.goldRanges) continue;
      const lines = readFileSync((item as FileCorpusItem).path, "utf8").split("\n");
      const covered = item.goldRanges.some((range) =>
        lines.slice(range.startLine - 1, range.endLine).some((line) => item.goldNeedles.some((needle) => line.includes(needle))),
      );
      ok(covered, `${item.id} gold ranges do not contain a gold needle`);
    }
  });

  it("rejects a needle that is not in the fixture instead of inventing a range", () => {
    let message = "";
    try {
      goldRangesFor(["a", "b"], ["absent"]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    ok(message.includes("not present"), message);
  });

  it("keeps the wide-line fixture under thresholdLines but past thresholdTokens", () => {
    const lines = wideLineFixtureLines();
    ok(lines.length < 350, `wide fixture has ${lines.length} lines`);
    ok(lines.join("\n").length / 4 >= 8000, "wide fixture is not large enough in estimated tokens");
  });
});

describe("materializeCorpus determinism", () => {
  it("writes byte-identical fixtures into two different temp dirs", () => {
    const second = materializeCorpus(dirB, { hasPdftotext: true });
    const a = walk(dirA);
    const b = walk(dirB);
    strictEqual(a.length, b.length);
    deepStrictEqual(
      a.map((entry) => ({ rel: entry.rel, sha: readFileSync(join(dirA, entry.rel)).byteLength })),
      b.map((entry) => ({ rel: entry.rel, sha: readFileSync(join(dirB, entry.rel)).byteLength })),
    );
    for (let index = 0; index < a.length; index++) {
      deepStrictEqual(a[index]!.bytes, b[index]!.bytes, `fixture ${a[index]!.rel} differs`);
    }
    deepStrictEqual(second.manifest, corpus.manifest);
  });

  it("serializes a JSON-safe manifest with dir-relative paths", () => {
    const json = JSON.parse(JSON.stringify(corpus.manifest)) as typeof corpus.manifest;
    strictEqual(json.items.length, corpus.items.length);
    for (const item of json.items) {
      if (item.kind === "file") {
        ok(item.path && !item.path.startsWith("/"), `${item.id} path is not relative: ${item.path}`);
        ok(!("pdfExtractor" in item), `${item.id} leaked an injected extractor into the manifest`);
      } else {
        ok(!("transport" in item) && !("resolveHost" in item), `${item.id} leaked injected functions into the manifest`);
      }
    }
  });

  it("reports pdftotext-dependent items as skipped when pdftotext is unavailable", () => {
    const dir = mkdtempSync(join(tmpdir(), "paradoc-corpus-nopdf-"));
    try {
      const without = materializeCorpus(dir, { hasPdftotext: false });
      const skippedIds = without.skipped.map((entry) => entry.id);
      deepStrictEqual(skippedIds, ["pdf-atlas-runbook", "pdf-no-text", "pdf-truncated"]);
      for (const entry of without.skipped) strictEqual(entry.reason, "skipped:pdftotext-missing");
      ok(without.items.some((item) => item.id === "pdf-encrypted"), "encrypted PDF must not need pdftotext");
      ok(without.items.some((item) => item.id === "pdf-oversized"), "injected-extractor PDF must not need pdftotext");
      for (const entry of without.skipped) ok(!existsSync(join(dir, "docs", `${entry.id}.pdf`.replace("pdf-atlas-runbook", "atlas-runbook"))));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("file fixtures", () => {
  it("writes every file fixture except the deliberately missing one", () => {
    const deliberatelyAbsent = new Set(["src-missing", "doc-missing"]);
    for (const item of corpus.items.filter((candidate): candidate is FileCorpusItem => candidate.kind === "file")) {
      if (deliberatelyAbsent.has(item.id)) {
        strictEqual(existsSync(item.path), false, `${item.id} must not be written`);
        continue;
      }
      ok(existsSync(item.path), `${item.id} fixture was not written`);
      ok(statSync(item.path).size > 0 || item.id === "src-missing", `${item.id} fixture is empty`);
    }
  });

  it("copies the repo documentation fixture verbatim", () => {
    const copied = readFileSync(fileItem("doc-atlas").path, "utf8");
    const original = readFileSync(new URL("../../docs/fixtures/large-paradoc-test.md", import.meta.url), "utf8");
    strictEqual(copied, original);
    ok(fileItem("doc-atlas").goldRanges?.length === 1, "copied fixture has no gold range");
  });

  it("classifies the negative file fixtures through the real file guard", async () => {
    const tooLarge = await readPdfDocument(fileItem("src-too-large").path, { maxFileBytes: 4096 });
    ok(!tooLarge.ok);
    strictEqual(tooLarge.reason, "file-too-large");
  });
});

describe("PDF fixtures", () => {
  it("hand-built PDFs round-trip the needle through real pdftotext", async (t) => {
    if (!existsSync("/usr/bin/pdftotext") && !process.env.PARADOC_TEST_PDFTEXTEXISTS) {
      let present = true;
      try {
        const { execFileSync } = await import("node:child_process");
        execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
      } catch {
        present = false;
      }
      if (!present) return t.skip("pdftotext not installed");
    }
    const result = await readPdfDocument(fileItem("pdf-atlas-runbook").path, {});
    ok(result.ok, `pdf extraction failed: ${!result.ok ? `${result.reason}: ${result.detail}` : ""}`);
    const needle = fileItem("pdf-atlas-runbook").goldNeedles[0]!;
    ok(result.content.includes(needle), `needle missing from extracted text:\n${result.content.slice(0, 400)}`);
    ok(result.content.includes("--- page 1 ---") && result.content.includes("--- page 2 ---"), "page markers missing");
    const extractedLines = result.content.split("\n").length;
    ok(extractedLines > 350, `extracted text is too small to intercept: ${extractedLines} lines`);
  });

  it("negative PDF fixtures produce their expected fallback reasons", async () => {
    const cases: Array<[string, string]> = [
      ["pdf-encrypted", "pdf-encrypted"],
      ["pdf-no-text", "pdf-no-text"],
      ["pdf-truncated", "pdf-malformed"],
      ["pdf-oversized", "pdf-too-large"],
      ["pdf-extractor-unavailable", "extractor-unavailable"],
    ];
    for (const [id, reason] of cases) {
      const item = fileItem(id);
      const read = await readPdfDocument(item.path, {
        extractor: item.pdfExtractor ?? createPdftotextExtractor(),
        maxChars: item.tuning?.pdfMaxChars,
      });
      ok(!read.ok, `${id} unexpectedly extracted text`);
      strictEqual(read.reason, reason, id);
    }
  });

  it("generates PDF pages whose text is long enough to intercept", () => {
    const pages = pdfFixturePages();
    strictEqual(pages.length, PDF_PAGES);
    for (const page of pages) ok(page.length <= 54, `page has ${page.length} lines, more than the MediaBox fits`);
    const text = pages.flat().join("\n");
    ok(text.length / 4 >= 1000, "pdf fixture is below minTokens");
    ok(pages.flat().length > 350, `pdf fixture is below thresholdLines: ${pages.flat().length}`);
  });
});

describe("web fixtures", () => {
  it("canned transport + canned DNS yields a converted docs page with the needle and no chrome", async () => {
    const item = webItem("web-docs-guide");
    const fetched = await fetchWebDocument(new URL(item.url), { transport: item.transport, resolveHost: item.resolveHost });
    ok(fetched.ok, `fetch failed: ${!fetched.ok ? `${fetched.reason}: ${fetched.detail}` : ""}`);
    strictEqual(fetched.mediaType, "text/html");
    const converted = htmlToText(fetched.text);
    const needle = item.goldNeedles[0]!;
    ok(converted.text.includes(needle), "needle missing from converted text");
    ok(!converted.text.includes("Footer chrome"), "footer chrome survived conversion");
    ok(!converted.text.includes("Docs API Blog"), "nav chrome survived conversion");
    strictEqual(converted.title, "ParaDoc Web Reads");
    ok(converted.text.split("\n").length > 200, "converted page is too small to intercept");
  });

  it("negative web fixtures produce their expected fallback reasons", async () => {
    const cases: Array<[string, string]> = [
      ["web-loopback", "unsafe-url"],
      ["web-non-html", "unsupported-content-type"],
      ["web-redirect-loop", "too-many-redirects"],
      ["web-oversized", "content-too-large"],
    ];
    for (const [id, reason] of cases) {
      const item = webItem(id);
      const fetched = await fetchWebDocument(new URL(item.url), {
        transport: item.transport,
        resolveHost: item.resolveHost,
        ...(item.tuning?.webMaxBytes !== undefined ? { maxBytes: item.tuning.webMaxBytes } : {}),
        ...(item.tuning?.webMaxRedirects !== undefined ? { maxRedirects: item.tuning.webMaxRedirects } : {}),
      });
      ok(!fetched.ok, `${id} unexpectedly succeeded`);
      strictEqual(fetched.reason, reason, id);
    }
  });

  it("canned HTML is deterministic across generators", () => {
    strictEqual(webFixtureHtml(), webItem("web-docs-guide").html);
    strictEqual(textDocumentFixtureLines().length, readFileSync(fileItem("doc-warehouse").path, "utf8").split("\n").length);
  });
});
