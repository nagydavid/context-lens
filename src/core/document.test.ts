import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { classifyDocument } from "./document.js";

describe("classifyDocument", () => {
  it("classifies supported documentation extensions", () => {
    for (const extension of [".md", ".markdown", ".mdx", ".txt", ".text", ".rst", ".adoc"]) {
      strictEqual(classifyDocument(`guide${extension}`), "text-document", extension);
    }
  });

  it("classifies documentation extensions case-insensitively", () => {
    strictEqual(classifyDocument("README.MD"), "text-document");
    strictEqual(classifyDocument("Notes.TXT"), "text-document");
  });

  it("classifies PDFs case-insensitively without confusing document names", () => {
    strictEqual(classifyDocument("a.pdf"), "pdf-text");
    strictEqual(classifyDocument("A.PDF"), "pdf-text");
    strictEqual(classifyDocument("pdf.md"), "text-document");
    strictEqual(classifyDocument("notes.txt"), "text-document");
    strictEqual(classifyDocument("x.ts"), "source");
  });

  it("treats source, extensionless, and dotfiles as source", () => {
    for (const filePath of ["example.ts", "package.json", "Makefile", ".mdrc"]) {
      strictEqual(classifyDocument(filePath), "source", filePath);
    }
  });
});
