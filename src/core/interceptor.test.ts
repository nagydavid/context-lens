import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it } from "node:test";
import { FakeSubagentRunner } from "./fake-runner.js";
import { interceptRead, ReadInterceptor } from "./interceptor.js";
import type { InterceptionEvent } from "./interceptor.js";
import { configPath } from "./config.js";
import { ModelSelector } from "./model-selector.js";

const fixturePath = (name: string) => join(tmpdir(), `context-lens-${name}-${Date.now()}.txt`);
const largeContent = Array.from({ length: 400 }, (_, index) =>
  index + 1 >= 120 && index + 1 <= 130
    ? `function recognisable_${index + 1}() {}`
    : `line ${index + 1}`
).join("\n");
const answer = {
  excerpts: [{ startLine: 118, endLine: 132, reason: "relevant function" }],
  summary: "The recognisable function is here.",
  confidence: 4,
};

async function withFixture(
  name: string,
  content: string,
  run: (filePath: string) => Promise<void>
): Promise<void> {
  const filePath = fixturePath(name);
  writeFileSync(filePath, content);
  try {
    await run(filePath);
  } finally {
    unlinkSync(filePath);
  }
}

describe("ReadInterceptor", () => {
  it("does not call a runner for files below the threshold", async () => {
    await withFixture("small", "line 1\nline 2\nline 3", async (filePath) => {
      const runner = new FakeSubagentRunner({ structured: answer });
      const result = await interceptRead(
        { filePath, agentContext: { goal: "test" } },
        { runner }
      );
      strictEqual(result.wasIntercepted, false);
      strictEqual(result.fullLineCount, 3);
      strictEqual(result.contextSaved, 0);
      strictEqual(runner.calls.length, 0);
    });
  });

  it("returns full content for small files", async () => {
    const content = "line 1\nline 2\nline 3";
    await withFixture("small-content", content, async (filePath) => {
      const result = await interceptRead({ filePath, agentContext: { goal: "test" } });
      strictEqual(result.excerpts.length, 1);
      strictEqual(result.excerpts[0].startLine, 1);
      strictEqual(result.excerpts[0].endLine, 3);
      strictEqual(result.excerpts[0].content, content);
    });
  });

  it("uses an explicit question and slices verified source lines", async () => {
    await withFixture("explicit", largeContent, async (filePath) => {
      const runner = new FakeSubagentRunner({ structured: answer });
      const result = await interceptRead(
        { filePath, question: "Where is the recognisable function?", agentContext: {} },
        { runner }
      );
      strictEqual(result.wasIntercepted, true);
      strictEqual(result.questionSource, "explicit");
      ok(runner.calls[0].prompt.includes("Where is the recognisable function?"));
      strictEqual(result.excerpts[0].content, readFileSync(filePath, "utf-8").split("\n").slice(117, 132).join("\n"));
      strictEqual(result.confidence, 4);
      ok((result.elapsedMs ?? -1) >= 0);
      ok(result.contextSaved > 90);
    });
  });

  it("infers a question from the current task", async () => {
    await withFixture("inferred", largeContent, async (filePath) => {
      const runner = new FakeSubagentRunner({ structured: answer });
      const result = await interceptRead(
        { filePath, agentContext: { currentTask: "find the parser entry point" } },
        { runner }
      );
      strictEqual(result.questionSource, "inferred");
      ok(runner.calls[0].prompt.includes("find the parser entry point"));
    });
  });

  it("accepts both structured and text JSON runner results", async () => {
    await withFixture("result-formats", largeContent, async (filePath) => {
      for (const response of [{ structured: answer }, { text: JSON.stringify(answer) }]) {
        const result = await interceptRead(
          { filePath, agentContext: {} },
          { runner: new FakeSubagentRunner(response) }
        );
        strictEqual(result.wasIntercepted, true);
      }
    });
  });

  it("falls back to the complete file when the runner throws", async () => {
    await withFixture("throws", largeContent, async (filePath) => {
      const runner = new FakeSubagentRunner(() => {
        throw new Error("runner unavailable");
      });
      const result = await interceptRead({ filePath, agentContext: {} }, { runner });
      strictEqual(result.fallback?.reason, "subagent-error");
      strictEqual(result.excerpts[0].startLine, 1);
      strictEqual(result.excerpts[0].endLine, 400);
      strictEqual(result.excerpts[0].content, largeContent);
    });
  });

  it("times out promptly and returns the complete file", async () => {
    await withFixture("timeout", largeContent, async (filePath) => {
      const runner = new FakeSubagentRunner({ structured: answer }, 200);
      const startedAt = performance.now();
      const result = await interceptRead(
        { filePath, agentContext: {} },
        { runner, timeoutMs: 20 }
      );
      strictEqual(result.fallback?.reason, "timeout");
      ok(performance.now() - startedAt < 150);
    });
  });

  it("falls back for invalid responses, invalid confidence, and invalid ranges", async () => {
    await withFixture("invalid", largeContent, async (filePath) => {
      const cases = [
        [{ text: "not JSON" }, "invalid-response"],
        [{ structured: { ...answer, confidence: 9 } }, "invalid-confidence"],
        [{ structured: { ...answer, excerpts: [{ startLine: 500, endLine: 600 }] } }, "no-valid-excerpts"],
      ] as const;
      for (const [response, reason] of cases) {
        const result = await interceptRead(
          { filePath, agentContext: {} },
          { runner: new FakeSubagentRunner(response) }
        );
        strictEqual(result.fallback?.reason, reason);
      }
    });
  });

  it("falls back when no runner is configured", async () => {
    await withFixture("no-runner", largeContent, async (filePath) => {
      const result = await interceptRead({ filePath, agentContext: {} });
      strictEqual(result.fallback?.reason, "no-runner");
      strictEqual(result.excerpts[0].content, largeContent);
    });
  });

  it("honours a custom interception threshold", async () => {
    const content = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    await withFixture("threshold", content, async (filePath) => {
      const runner = new FakeSubagentRunner({ structured: { ...answer, excerpts: [{ startLine: 1, endLine: 2 }] } });
      const result = await interceptRead({ filePath, agentContext: {} }, { runner, thresholdLines: 10 });
      strictEqual(result.wasIntercepted, true);
      strictEqual(runner.calls.length, 1);
    });
  });

  it("emits one safe event on failure even when logging throws", async () => {
    await withFixture("logger", largeContent, async (filePath) => {
      const events: unknown[] = [];
      const interceptor = new ReadInterceptor({
        runner: new FakeSubagentRunner(() => {
          throw new Error("unavailable");
        }),
        logger: (event) => {
          events.push(event);
          throw new Error("logger unavailable");
        },
      });
      const result = await interceptor.intercept({ filePath, agentContext: {} });
      strictEqual(result.fallback?.reason, "subagent-error");
      strictEqual(events.length, 1);
      strictEqual((events[0] as { fallbackReason?: string }).fallbackReason, "subagent-error");
    });
  });
});

async function withModelDirs(
  run: (projectRoot: string, homeDir: string) => Promise<void>,
): Promise<void> {
  const projectRoot = mkdtempSync(join(tmpdir(), "context-lens-project-"));
  const homeDir = mkdtempSync(join(tmpdir(), "context-lens-home-"));
  try {
    await run(projectRoot, homeDir);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
}

describe("ReadInterceptor file guard", () => {
  it("falls back with file-not-found and never calls the runner", async () => {
    const runner = new FakeSubagentRunner({ structured: answer });
    const events: InterceptionEvent[] = [];
    const result = await new ReadInterceptor({
      runner,
      logger: (event) => events.push(event),
    }).intercept({ filePath: fixturePath("missing"), agentContext: {} });
    strictEqual(result.wasIntercepted, false);
    strictEqual(result.error, "file not found");
    strictEqual(result.fallback?.reason, "file-not-found");
    strictEqual(runner.calls.length, 0);
    strictEqual(events[0].fallbackReason, "file-not-found");
  });

  it("falls back with file-too-large via maxFileBytes", async () => {
    await withFixture("oversize", largeContent, async (filePath) => {
      const runner = new FakeSubagentRunner({ structured: answer });
      const events: InterceptionEvent[] = [];
      const result = await new ReadInterceptor({
        runner,
        maxFileBytes: 100,
        logger: (event) => events.push(event),
      }).intercept({ filePath, agentContext: {} });
      strictEqual(result.fallback?.reason, "file-too-large");
      strictEqual(result.error, "file too large");
      strictEqual(runner.calls.length, 0);
      strictEqual(events[0].fallbackReason, "file-too-large");
      strictEqual(events[0].fileBytes, Buffer.byteLength(largeContent));
    });
  });

  it("falls back with binary-file for large binary content", async () => {
    const binary = Buffer.concat([Buffer.from(largeContent), Buffer.from([0])]);
    const filePath = fixturePath("binary");
    writeFileSync(filePath, Buffer.concat([Buffer.from([0]), binary]));
    try {
      const runner = new FakeSubagentRunner({ structured: answer });
      const result = await interceptRead({ filePath, agentContext: {} }, { runner });
      strictEqual(result.fallback?.reason, "binary-file");
      strictEqual(result.error, "binary file");
      strictEqual(runner.calls.length, 0);
    } finally {
      unlinkSync(filePath);
    }
  });

  it("returns small text files unchanged", async () => {
    await withFixture("small-guard", "a\nb", async (filePath) => {
      const result = await interceptRead({ filePath, agentContext: {} });
      strictEqual(result.error, undefined);
      strictEqual(result.fallback, undefined);
      strictEqual(result.excerpts[0].content, "a\nb");
    });
  });
});

describe("ReadInterceptor model selection", () => {
  it("does not resolve a model for a small file", async () => {
    await withFixture("model-small", "one\ntwo", async (filePath) => {
      const picker = {
        calls: 0,
        async pick() {
          picker.calls += 1;
          return { choice: { providerID: "openai", modelID: "gpt-x" }, scope: "project" as const };
        },
      };
      const selector = new ModelSelector({ env: {}, picker });
      const runner = new FakeSubagentRunner({ structured: answer });
      await interceptRead({ filePath, agentContext: {} }, { runner, modelResolver: selector.resolve });
      strictEqual(picker.calls, 0);
      strictEqual(runner.calls.length, 0);
    });
  });

  it("does not resolve a model when no runner is configured", async () => {
    await withFixture("model-no-runner", largeContent, async (filePath) => {
      let resolverCalls = 0;
      const result = await interceptRead(
        { filePath, agentContext: {} },
        { modelResolver: async () => { resolverCalls += 1; return undefined; } },
      );
      strictEqual(result.fallback?.reason, "no-runner");
      strictEqual(resolverCalls, 0);
    });
  });

  it("persists the first picked model and reuses it across interceptor reads", async () => {
    await withModelDirs(async (projectRoot, homeDir) => {
      await withFixture("model-demo", largeContent, async (filePath) => {
        const choice = { providerID: "openrouter", modelID: "anthropic/claude-x", endpoint: "https://private.example" };
        const picker = {
          calls: 0,
          async pick() {
            picker.calls += 1;
            return { choice, scope: "project" as const };
          },
        };
        const options = { projectRoot, homeDir, env: {} };
        const selector = new ModelSelector({ ...options, picker });
        const runner = new FakeSubagentRunner({ structured: answer });
        const interceptor = new ReadInterceptor({ runner, modelResolver: selector.resolve });

        await interceptor.intercept({ filePath, agentContext: {} });
        strictEqual(picker.calls, 1);
        ok(existsSync(configPath("project", options)));
        deepStrictEqual(runner.calls[0].model, { providerID: choice.providerID, modelID: choice.modelID });

        await interceptor.intercept({ filePath, agentContext: {} });
        strictEqual(picker.calls, 1);
        deepStrictEqual(runner.calls[1].model, { providerID: choice.providerID, modelID: choice.modelID });

        const nextSelector = new ModelSelector({
          ...options,
          picker: { async pick() { throw new Error("stored model should prevent picking"); } },
        });
        const nextRunner = new FakeSubagentRunner({ structured: answer });
        await new ReadInterceptor({ runner: nextRunner, modelResolver: nextSelector.resolve }).intercept({ filePath, agentContext: {} });
        deepStrictEqual(nextRunner.calls[0].model, { providerID: choice.providerID, modelID: choice.modelID });
      });
    });
  });

  it("prefers an explicit model without resolving", async () => {
    await withFixture("model-explicit", largeContent, async (filePath) => {
      let resolverCalls = 0;
      const runner = new FakeSubagentRunner({ structured: answer });
      await interceptRead(
        { filePath, agentContext: {} },
        {
          runner,
          model: { providerID: "explicit", modelID: "model" },
          modelResolver: async () => { resolverCalls += 1; return undefined; },
        },
      );
      strictEqual(resolverCalls, 0);
      deepStrictEqual(runner.calls[0].model, { providerID: "explicit", modelID: "model" });
    });
  });

  it("continues an intercepted read when the picker is cancelled", async () => {
    await withFixture("model-cancel", largeContent, async (filePath) => {
      const events: Array<{ modelSource?: string }> = [];
      const runner = new FakeSubagentRunner({ structured: answer });
      const selector = new ModelSelector({ env: {}, picker: { async pick() { return undefined; } } });
      const result = await new ReadInterceptor({
        runner,
        modelResolver: selector.resolve,
        logger: (event) => events.push(event),
      }).intercept({ filePath, agentContext: {} });
      strictEqual(result.wasIntercepted, true);
      strictEqual(runner.calls[0].model, undefined);
      strictEqual(events[0].modelSource, "none");
    });
  });

  it("continues and logs a model resolver failure", async () => {
    await withFixture("model-throws", largeContent, async (filePath) => {
      const events: Array<{ detail?: string }> = [];
      const runner = new FakeSubagentRunner({ structured: answer });
      const result = await new ReadInterceptor({
        runner,
        modelResolver: async () => { throw new Error("picker unavailable"); },
        logger: (event) => events.push(event),
      }).intercept({ filePath, agentContext: {} });
      strictEqual(result.wasIntercepted, true);
      strictEqual(result.error, undefined);
      ok(events[0].detail?.includes("model resolution failed"));
    });
  });

  it("reports project as the source for a stored configuration", async () => {
    await withModelDirs(async (projectRoot, homeDir) => {
      await withFixture("model-project", largeContent, async (filePath) => {
        const options = { projectRoot, homeDir, env: {} };
        const setup = new ModelSelector({
          ...options,
          picker: { async pick() { return { choice: { providerID: "openai", modelID: "gpt-x" }, scope: "project" as const }; } },
        });
        await setup.resolve();
        const events: Array<{ modelSource?: string }> = [];
        const runner = new FakeSubagentRunner({ structured: answer });
        const selector = new ModelSelector({ ...options });
        await new ReadInterceptor({
          runner,
          modelResolver: selector.resolve,
          logger: (event) => events.push(event),
        }).intercept({ filePath, agentContext: {} });
        strictEqual(events[0].modelSource, "project");
      });
    });
  });
  describe("transient retry", () => {
    const transient = () =>
      Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });

    it("retries once then succeeds", async () => {
      await withFixture("retry-ok", largeContent, async (filePath) => {
        let n = 0;
        const runner = new FakeSubagentRunner(() => {
          if (++n === 1) throw transient();
          return { structured: answer };
        });
        const events: InterceptionEvent[] = [];
        const result = await new ReadInterceptor({
          runner,
          retryDelayMs: 1,
          logger: (e) => events.push(e),
        }).intercept({ filePath, agentContext: {} });
        strictEqual(result.wasIntercepted, true);
        strictEqual(runner.calls.length, 2);
        strictEqual(events[0].attempts, 2);
      });
    });

    it("falls back with network-error after exhausting retries", async () => {
      await withFixture("retry-fail", largeContent, async (filePath) => {
        const runner = new FakeSubagentRunner(() => { throw transient(); });
        const events: InterceptionEvent[] = [];
        const result = await new ReadInterceptor({
          runner,
          retryDelayMs: 1,
          logger: (e) => events.push(e),
        }).intercept({ filePath, agentContext: {} });
        strictEqual(result.fallback?.reason, "network-error");
        strictEqual(runner.calls.length, 3);
        ok(result.fallback?.detail?.includes("after 2 retries"));
        strictEqual(events[0].attempts, 3);
        strictEqual(events[0].fallbackReason, "network-error");
      });
    });

    it("does not retry non-transient errors", async () => {
      await withFixture("retry-nontransient", largeContent, async (filePath) => {
        const runner = new FakeSubagentRunner(() => { throw new Error("model refused"); });
        const result = await new ReadInterceptor({ runner, retryDelayMs: 1 })
          .intercept({ filePath, agentContext: {} });
        strictEqual(result.fallback?.reason, "subagent-error");
        strictEqual(runner.calls.length, 1);
      });
    });

    it("maxRetries 0 makes a single call", async () => {
      await withFixture("retry-zero", largeContent, async (filePath) => {
        const runner = new FakeSubagentRunner(() => { throw transient(); });
        const result = await new ReadInterceptor({ runner, maxRetries: 0, retryDelayMs: 1 })
          .intercept({ filePath, agentContext: {} });
        strictEqual(runner.calls.length, 1);
        strictEqual(result.fallback?.reason, "subagent-error");
      });
    });

    it("bounds total time with a single deadline across retries", async () => {
      await withFixture("retry-timeout", largeContent, async (filePath) => {
        const runner = new FakeSubagentRunner(() => { throw transient(); }, 40);
        const started = performance.now();
        const result = await new ReadInterceptor({ runner, timeoutMs: 60, retryDelayMs: 1 })
          .intercept({ filePath, agentContext: {} });
        const elapsed = performance.now() - started;
        strictEqual(result.fallback?.reason, "timeout");
        ok(elapsed < 110, `elapsed ${elapsed}`);
      });
    });
  });
});
