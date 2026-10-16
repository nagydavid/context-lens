import { readFileSync, statSync } from "fs";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const BINARY_SNIFF_BYTES = 8192;

export type FileGuardFailure = {
  ok: false;
  reason: "file-not-found" | "file-too-large" | "binary-file" | "unreadable";
  error: string;
  detail: string;
  size?: number;
};

export function classifyFsError(error: unknown): FileGuardFailure {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return { ok: false, reason: "file-not-found", error: "file not found", detail: code };
  }
  return {
    ok: false,
    reason: "unreadable",
    error: "file unreadable",
    detail: code ? `${code}: ${message}` : message,
  };
}

export function statFile(
  path: string,
  maxBytes: number = MAX_FILE_BYTES
): { ok: true; size: number } | FileGuardFailure {
  try {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      return { ok: false, reason: "unreadable", error: "file unreadable", detail: "EISDIR: is a directory" };
    }
    if (stats.size > maxBytes) {
      return {
        ok: false,
        reason: "file-too-large",
        error: "file too large",
        size: stats.size,
        detail: `${stats.size} bytes exceeds limit of ${maxBytes} bytes`,
      };
    }
    return { ok: true, size: stats.size };
  } catch (error: unknown) {
    return classifyFsError(error);
  }
}

export function readTextFile(path: string): { ok: true; content: string } | FileGuardFailure {
  try {
    const buffer = readFileSync(path);
    const sniff = buffer.subarray(0, BINARY_SNIFF_BYTES);
    if (sniff.includes(0)) {
      return {
        ok: false,
        reason: "binary-file",
        error: "binary file",
        detail: `NUL byte found in first ${BINARY_SNIFF_BYTES} bytes`,
        size: buffer.length,
      };
    }
    return { ok: true, content: buffer.toString("utf-8") };
  } catch (error: unknown) {
    return classifyFsError(error);
  }
}
