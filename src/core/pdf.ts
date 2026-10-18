import { execFile as execFileCallback } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { classifyFsError, statFile } from "./file-guard.js";
import type { FallbackReason } from "./models.js";

export const DEFAULT_PDF_TIMEOUT_MS = 15_000;
export const DEFAULT_PDF_MAX_CHARS = 1_000_000;

export type PdfExtraction =
  | { ok: true; text: string; pages: number }
  | { ok: false; reason: FallbackReason; error: string; detail: string };

export type PdfExtractor = (path: string, opts: { timeoutMs: number; maxChars: number }) => Promise<PdfExtraction>;

export type ExecFileLike = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number; encoding: "utf8"; windowsHide: true }
) => Promise<{ stdout: string; stderr: string }>;

type PdftotextError = Error & {
  code?: number | "ENOENT" | string;
  signal?: string;
  killed?: boolean;
  stderr?: string;
};

const defaultExecFile = promisify(execFileCallback) as unknown as ExecFileLike;

export function normalizePdfText(raw: string): { text: string; pages: number } {
  const pages = raw.replace(/\r\n?/g, "\n").split("\f");
  if (pages.length > 1 && pages.at(-1) === "") pages.pop();
  const text = pages.map((page, index) => `--- page ${index + 1} ---\n${page}`).join("\n").replace(/\n[ \t]*\n*$/u, "");
  return { text, pages: pages.length };
}

export function looksScanned(text: string, pages: number): boolean {
  const characters = text
    .split("\n")
    .filter((line) => !/^--- page \d+ ---$/u.test(line))
    .join("")
    .replace(/\s/gu, "").length;
  return characters / Math.max(pages, 1) < 16;
}

export function hasEncryptDictionary(buf: Buffer): boolean {
  return buf.subarray(Math.max(0, buf.length - 4096)).toString("latin1").includes("/Encrypt");
}

export function hasPdfHeader(buf: Buffer): boolean {
  return buf.subarray(0, 1024).toString("latin1").includes("%PDF-");
}

export function classifyPdftotextFailure(error: unknown, timeoutMs = DEFAULT_PDF_TIMEOUT_MS): PdfExtraction {
  const err = error as PdftotextError;
  const stderr = typeof err?.stderr === "string" ? err.stderr : "";
  const code = err?.code;
  if (code === "ENOENT") {
    return {
      ok: false,
      reason: "extractor-unavailable",
      error: "pdf text unavailable",
      detail: "pdftotext not found on PATH; install poppler-utils (apt) or poppler (brew)",
    };
  }
  if (err?.killed || err?.signal === "SIGTERM") {
    return { ok: false, reason: "timeout", error: "pdf text unavailable", detail: `pdftotext timed out after ${timeoutMs}ms` };
  }
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || (err instanceof RangeError && /maxBuffer/i.test(err.message))) {
    return { ok: false, reason: "pdf-too-large", error: "pdf text unavailable", detail: "pdftotext output exceeds configured maximum" };
  }
  if (/Incorrect password|encrypted/i.test(stderr)) {
    return { ok: false, reason: "pdf-encrypted", error: "pdf text unavailable", detail: stderr.trim().slice(0, 300) };
  }
  return {
    ok: false,
    reason: "pdf-malformed",
    error: "pdf text unavailable",
    detail: `exit ${code ?? "unknown"}: ${stderr.trim().slice(0, 300)}`,
  };
}

export function createPdftotextExtractor(
  { command = "pdftotext", execFile = defaultExecFile }: { command?: string; execFile?: ExecFileLike } = {}
): PdfExtractor {
  return async (path, opts) => {
    try {
      const result = await execFile(command, ["-enc", "UTF-8", resolve(path), "-"], {
        timeout: opts.timeoutMs,
        maxBuffer: opts.maxChars * 4,
        encoding: "utf8",
        windowsHide: true,
      });
      const normalized = normalizePdfText(result.stdout);
      return { ok: true, ...normalized };
    } catch (error: unknown) {
      return classifyPdftotextFailure(error, opts.timeoutMs);
    }
  };
}

export async function readPdfDocument(
  path: string,
  {
    extractor = createPdftotextExtractor(),
    maxFileBytes,
    timeoutMs = DEFAULT_PDF_TIMEOUT_MS,
    maxChars = DEFAULT_PDF_MAX_CHARS,
  }: { extractor?: PdfExtractor; maxFileBytes?: number; timeoutMs?: number; maxChars?: number } = {}
): Promise<{ ok: true; content: string } | { ok: false; reason: FallbackReason; error: string; detail: string; size?: number }> {
  const guarded = statFile(path, maxFileBytes);
  if (!guarded.ok) return guarded;

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error: unknown) {
    return classifyFsError(error);
  }
  if (!hasPdfHeader(bytes)) return { ok: false, reason: "pdf-malformed", error: "pdf text unavailable", detail: "missing %PDF- header", size: guarded.size };
  if (hasEncryptDictionary(bytes)) return { ok: false, reason: "pdf-encrypted", error: "pdf text unavailable", detail: "PDF contains /Encrypt dictionary", size: guarded.size };

  const extracted = await extractor(path, { timeoutMs, maxChars });
  if (!extracted.ok) return { ...extracted, size: guarded.size };
  if (extracted.text.length > maxChars) {
    return { ok: false, reason: "pdf-too-large", error: "pdf text unavailable", detail: `extracted text exceeds limit of ${maxChars} characters`, size: guarded.size };
  }
  if (looksScanned(extracted.text, extracted.pages)) {
    return { ok: false, reason: "pdf-no-text", error: "pdf text unavailable", detail: "no extractable text (scanned or image-only PDF; OCR not supported)", size: guarded.size };
  }
  return { ok: true, content: extracted.text };
}
