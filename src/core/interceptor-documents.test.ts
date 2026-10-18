import { ok, strictEqual } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FakeSubagentRunner } from "./fake-runner.js";
import { estimateTokens, ReadInterceptor, type InterceptionEvent } from "./interceptor.js";

const excerpt = {
  excerpts: [{ startLine: 42, endLine: 45, reason: "relevant section" }],
  summary: "The requested section.",
  confidence: 4,
};

function largeDocument(extension: ".md" | ".txt", separator = "\n"): string {
  return Array.from({ length: 400 }, (_, index) => {
    const line = index + 1;
    if (extension === ".md") {
      if (line % 40 === 1) return `## Section ${line}`;
      if (line % 40 === 2) return `A complete paragraph for section ${line} with useful document context.`;
      if (line % 40 === 3) return `- List item ${line} with a concrete detail.`;
    }
    return `Document line ${line} contains enough prose to exercise read interception.`;
  }).join(separator);
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "paradoc-documents-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function interceptDocument(filePath: string, runner: FakeSubagentRunner) {
  return new ReadInterceptor({ runner }).intercept({ filePath, agentContext: {} });
}

describe("ReadInterceptor text documents", () => {
  it("intercepts a large README.md using the documentation prompt and verified file lines", async () => {
    await withTempDirectory(async (directory) => {
      const content = largeDocument(".md");
      const filePath = join(directory, "README.md");
      writeFileSync(filePath, content);
      const runner = new FakeSubagentRunner({ structured: excerpt });

      const result = await interceptDocument(filePath, runner);

      strictEqual(result.wasIntercepted, true);
      strictEqual(result.excerpts[0].startLine, 42);
      strictEqual(result.excerpts[0].endLine, 45);
      strictEqual(result.excerpts[0].content, content.split("\n").slice(41, 45).join("\n"));
      ok(runner.calls[0].prompt.includes("inline documentation file"));
    });
  });

  it("intercepts a large notes.txt using the documentation prompt and verified file lines", async () => {
    await withTempDirectory(async (directory) => {
      const content = largeDocument(".txt");
      const filePath = join(directory, "notes.txt");
      writeFileSync(filePath, content);
      const runner = new FakeSubagentRunner({ structured: excerpt });

      const result = await interceptDocument(filePath, runner);

      strictEqual(result.wasIntercepted, true);
      strictEqual(result.excerpts[0].startLine, 42);
      strictEqual(result.excerpts[0].endLine, 45);
      strictEqual(result.excerpts[0].content, content.split("\n").slice(41, 45).join("\n"));
      ok(runner.calls[0].prompt.includes("inline documentation file"));
    });
  });

  it("passes small Markdown and plain text files through without calling the runner", async () => {
    await withTempDirectory(async (directory) => {
      for (const name of ["README.md", "notes.txt"]) {
        const content = "one\ntwo\nthree";
        const filePath = join(directory, name);
        writeFileSync(filePath, content);
        const runner = new FakeSubagentRunner({ structured: excerpt });

        const result = await interceptDocument(filePath, runner);

        strictEqual(result.wasIntercepted, false);
        strictEqual(result.excerpts.length, 1);
        strictEqual(result.excerpts[0].content, content);
        strictEqual(runner.calls.length, 0);
      }
    });
  });

  it("intercepts long-line Markdown below the line threshold via the token threshold", async () => {
    await withTempDirectory(async (directory) => {
      const content = Array.from({ length: 20 }, (_, index) => `Paragraph ${index + 1}: ${"x".repeat(1_980)}`).join("\n");
      const filePath = join(directory, "long-lines.md");
      writeFileSync(filePath, content);
      const runner = new FakeSubagentRunner({
        structured: { ...excerpt, excerpts: [{ startLine: 2, endLine: 3 }] },
      });

      const result = await interceptDocument(filePath, runner);

      ok(estimateTokens(content) >= 8_000);
      strictEqual(result.fullLineCount, 20);
      strictEqual(result.wasIntercepted, true);
      strictEqual(runner.calls.length, 1);
    });
  });

  it("keeps CRLF carriage returns while reporting the requested line range", async () => {
    await withTempDirectory(async (directory) => {
      const content = largeDocument(".txt", "\r\n");
      const filePath = join(directory, "windows-notes.txt");
      writeFileSync(filePath, content);
      const runner = new FakeSubagentRunner({ structured: excerpt });

      const result = await interceptDocument(filePath, runner);

      strictEqual(result.wasIntercepted, true);
      strictEqual(result.excerpts[0].startLine, 42);
      strictEqual(result.excerpts[0].endLine, 45);
      strictEqual(result.excerpts[0].content, content.split("\n").slice(41, 45).join("\n"));
      ok(result.excerpts[0].content.includes("\r"));
    });
  });

  it("uses the document prompt for upper-case Markdown and the source prompt for TypeScript", async () => {
    await withTempDirectory(async (directory) => {
      const content = largeDocument(".txt");
      const markdownPath = join(directory, "GUIDE.MD");
      const sourcePath = join(directory, "guide.ts");
      writeFileSync(markdownPath, content);
      writeFileSync(sourcePath, content);
      const runner = new FakeSubagentRunner({ structured: excerpt });

      await interceptDocument(markdownPath, runner);
      await interceptDocument(sourcePath, runner);

      ok(runner.calls[0].prompt.includes("inline documentation file"));
      ok(runner.calls[1].prompt.includes("inline source file"));
    });
  });

  it("falls back without throwing when the runner throws or returns invalid output", async () => {
    await withTempDirectory(async (directory) => {
      const content = largeDocument(".md");
      const filePath = join(directory, "fallback.md");
      writeFileSync(filePath, content);
      const cases = [
        [new FakeSubagentRunner(() => { throw new Error("runner unavailable"); }), "subagent-error"],
        [new FakeSubagentRunner({ text: "not valid JSON" }), "invalid-response"],
      ] as const;

      for (const [runner, reason] of cases) {
        const events: InterceptionEvent[] = [];
        const result = await new ReadInterceptor({ runner, logger: (event) => events.push(event) })
          .intercept({ filePath, agentContext: {} });
        strictEqual(result.wasIntercepted, false);
        strictEqual(result.fallback?.reason, reason);
        strictEqual(events[0].fallbackReason, reason);
        strictEqual(result.excerpts[0].content, content);
      }
    });
  });
});
