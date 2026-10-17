import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { after, describe, it } from "node:test";
import { BINARY_SNIFF_BYTES, readTextFile, statFile } from "./file-guard.js";

const dir = mkdtempSync(join(tmpdir(), "paradoc-guard-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("file guard", () => {
  it("reports a missing file as file-not-found", () => {
    const result = statFile(join(dir, "missing.txt"));
    ok(!result.ok);
    strictEqual(result.reason, "file-not-found");
    strictEqual(result.error, "file not found");
    const read = readTextFile(join(dir, "missing.txt"));
    ok(!read.ok);
    strictEqual(read.reason, "file-not-found");
  });

  it("reports a path under a regular file (ENOTDIR) as file-not-found", () => {
    const file = join(dir, "regular.txt");
    writeFileSync(file, "x");
    const result = statFile(join(file, "child"));
    ok(!result.ok);
    strictEqual(result.reason, "file-not-found");
  });

  it("reports a directory as unreadable", () => {
    const result = statFile(dir);
    ok(!result.ok);
    strictEqual(result.reason, "unreadable");
    strictEqual(result.error, "file unreadable");
    ok(result.detail.includes("is a directory"));
  });

  it("reports oversized files with their size", () => {
    const file = join(dir, "big.txt");
    writeFileSync(file, "x".repeat(100));
    const result = statFile(file, 50);
    ok(!result.ok);
    strictEqual(result.reason, "file-too-large");
    strictEqual(result.error, "file too large");
    strictEqual(result.size, 100);
    strictEqual(result.detail, "100 bytes exceeds limit of 50 bytes");
    deepStrictEqual(statFile(file, 100), { ok: true, size: 100 });
  });

  it("detects NUL in the first 8KB as binary", () => {
    const file = join(dir, "bin.dat");
    writeFileSync(file, Buffer.concat([Buffer.from("abc"), Buffer.from([0]), Buffer.from("def")]));
    const result = readTextFile(file);
    ok(!result.ok);
    strictEqual(result.reason, "binary-file");
    strictEqual(result.error, "binary file");
  });

  it("treats NUL only after the sniff window as text", () => {
    const file = join(dir, "late-nul.txt");
    writeFileSync(file, Buffer.concat([Buffer.alloc(BINARY_SNIFF_BYTES, "a"), Buffer.from([0])]));
    const result = readTextFile(file);
    ok(result.ok);
  });

  it("round-trips BOM and CRLF identically to readFileSync utf-8", () => {
    const file = join(dir, "bom.txt");
    writeFileSync(file, "﻿line 1\r\nline 2\r\nünï\r\n");
    const result = readTextFile(file);
    ok(result.ok);
    strictEqual(result.content, readFileSync(file, "utf-8"));
    ok(result.content.startsWith("﻿"));
    ok(result.content.includes("\r\n"));
  });
});
