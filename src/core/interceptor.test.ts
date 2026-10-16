import { describe, it } from "node:test";
import { strictEqual, deepStrictEqual } from "node:assert";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { interceptRead } from "./interceptor.js";

describe("ReadInterceptor", () => {
  it("should not intercept files below threshold", async () => {
    const testFile = join(tmpdir(), "test-small.txt");
    const smallContent = "line 1\nline 2\nline 3";
    writeFileSync(testFile, smallContent);

    try {
      const result = await interceptRead({
        filePath: testFile,
        agentContext: { goal: "test" },
      });

      strictEqual(result.wasIntercepted, false);
      strictEqual(result.fullLineCount, 3);
      strictEqual(result.contextSaved, 0);
    } finally {
      unlinkSync(testFile);
    }
  });

  it("should return full content for small files", async () => {
    const testFile = join(tmpdir(), "test-small-content.txt");
    const smallContent = "line 1\nline 2\nline 3";
    writeFileSync(testFile, smallContent);

    try {
      const result = await interceptRead({
        filePath: testFile,
        agentContext: { goal: "test" },
      });

      strictEqual(result.excerpts.length, 1);
      strictEqual(result.excerpts[0].startLine, 1);
      strictEqual(result.excerpts[0].endLine, 3);
    } finally {
      unlinkSync(testFile);
    }
  });
});
