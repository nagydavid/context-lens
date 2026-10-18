import { extname } from "node:path";

export type DocumentKind = "source" | "text-document" | "pdf-text" | "web-page";

const TEXT_DOCUMENT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".txt",
  ".text",
  ".rst",
  ".adoc",
]);

export function classifyDocument(filePath: string): DocumentKind {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".pdf") return "pdf-text";
  return TEXT_DOCUMENT_EXTENSIONS.has(extension) ? "text-document" : "source";
}
