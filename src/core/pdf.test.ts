import { ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  createPdftotextExtractor,
  hasEncryptDictionary,
  looksScanned,
  normalizePdfText,
  readPdfDocument,
  type ExecFileLike,
  type PdfExtractor,
} from "./pdf.js";

const dir = mkdtempSync(join(tmpdir(), "paradoc-pdf-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function fakeExec(error?: unknown, stdout = "Extracted document text") {
  return (async () => {
    if (error) throw error;
    return { stdout, stderr: "" };
  }) as ExecFileLike;
}

function buildPdf(pages: string[]): Buffer {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, text] of pages.entries()) {
    const escaped = text.replace(/([\\()])/g, "\\$1");
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET` : "";
    objects.push(`<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 612 792] /Contents ${5 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

function writePdf(name: string, pages: string[]): string {
  const path = join(dir, name);
  writeFileSync(path, buildPdf(pages));
  return path;
}

describe("pdftotext extractor", () => {
  it("classifies missing executable, timeout, maxBuffer, encryption, and malformed failures", async () => {
    const cases: Array<[string, unknown, string]> = [
      ["ENOENT", { code: "ENOENT" }, "extractor-unavailable"],
      ["timeout", { killed: true, signal: "SIGTERM" }, "timeout"],
      ["maxBuffer", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "pdf-too-large"],
      ["encrypted", { code: 1, stderr: "Command Line Error: Incorrect password" }, "pdf-encrypted"],
      ["malformed", { code: 1, stderr: "Syntax Error: Couldn't find trailer dictionary" }, "pdf-malformed"],
    ];
    for (const [, error, reason] of cases) {
      const result = await createPdftotextExtractor({ execFile: fakeExec(error) })("relative.pdf", { timeoutMs: 12, maxChars: 10 });
      ok(!result.ok);
      strictEqual(result.reason, reason);
    }
  });

  it("uses absolute paths and normalizes successful output", async () => {
    let args: string[] = [];
    const execFile = (async (_file, receivedArgs) => {
      args = receivedArgs;
      return { stdout: "First\fSecond\f", stderr: "" };
    }) as ExecFileLike;
    const result = await createPdftotextExtractor({ execFile })("relative.pdf", { timeoutMs: 1, maxChars: 99 });
    ok(result.ok);
    strictEqual(args[2].startsWith("/"), true);
    strictEqual(result.pages, 2);
    strictEqual(result.text, "--- page 1 ---\nFirst\n--- page 2 ---\nSecond");
  });
});

describe("PDF text helpers", () => {
  it("normalizes multi-page, trailing form feed, CRLF, and empty output", () => {
    strictEqual(normalizePdfText("one\r\ntwo\fthree\f").text, "--- page 1 ---\none\ntwo\n--- page 2 ---\nthree");
    strictEqual(normalizePdfText("one\f").pages, 1);
    strictEqual(normalizePdfText("").text, "--- page 1 ---");
  });

  it("detects sparse scanned text without counting markers", () => {
    strictEqual(looksScanned("--- page 1 ---\n123456789012345", 1), true);
    strictEqual(looksScanned("--- page 1 ---\n1234567890123456", 1), false);
    strictEqual(looksScanned("--- page 1 ---\n123456789012345678901234567890", 2), true);
  });

  it("detects an encryption dictionary only in the trailer region", () => {
    strictEqual(hasEncryptDictionary(Buffer.from("%PDF-1.4\ntrailer /Encrypt 1 0 R")), true);
    strictEqual(hasEncryptDictionary(Buffer.from("%PDF-1.4\ntrailer /Root 1 0 R")), false);
  });
});

describe("readPdfDocument", () => {
  it("rejects oversized, non-PDF, and encrypted files before extraction", async () => {
    const oversized = join(dir, "oversized.pdf");
    const garbage = join(dir, "garbage.pdf");
    const encrypted = join(dir, "encrypted.pdf");
    writeFileSync(oversized, "%PDF-123456789");
    writeFileSync(garbage, "not a PDF");
    writeFileSync(encrypted, "%PDF-1.4\ntrailer\n<< /Encrypt 1 0 R >>");
    const never: PdfExtractor = async () => { throw new Error("extractor should not run"); };
    const tooLarge = await readPdfDocument(oversized, { extractor: never, maxFileBytes: 4 });
    const malformed = await readPdfDocument(garbage, { extractor: never });
    const locked = await readPdfDocument(encrypted, { extractor: never });
    ok(!tooLarge.ok); strictEqual(tooLarge.reason, "file-too-large");
    ok(!malformed.ok); strictEqual(malformed.reason, "pdf-malformed");
    ok(!locked.ok); strictEqual(locked.reason, "pdf-encrypted");
  });
});

const hasPdftotext = (() => {
  try { execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); return true; } catch { return false; }
})();

describe("real pdftotext", () => {
  it("extracts marked multi-page text", async (t) => {
    if (!hasPdftotext) return t.skip("pdftotext not installed");
    const result = await readPdfDocument(writePdf("two-pages.pdf", ["Alpha text on first page", "Beta text on second page"]), {});
    ok(result.ok);
    ok(result.content.includes("--- page 1 ---"));
    ok(result.content.includes("--- page 2 ---"));
    ok(result.content.includes("Alpha text on first page"));
    ok(result.content.includes("Beta text on second page"));
  });

  it("classifies an empty page and truncated PDF", async (t) => {
    if (!hasPdftotext) return t.skip("pdftotext not installed");
    const empty = await readPdfDocument(writePdf("empty.pdf", [""]), {});
    const truncatedPath = join(dir, "truncated.pdf");
    writeFileSync(truncatedPath, "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>");
    const truncated = await readPdfDocument(truncatedPath, {});
    ok(!empty.ok); strictEqual(empty.reason, "pdf-no-text");
    ok(!truncated.ok); strictEqual(truncated.reason, "pdf-malformed");
  });
});
