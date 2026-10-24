import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it } from "node:test";
import { LruResultCache } from "./cache.js";
import { FakeSubagentRunner } from "./fake-runner.js";
import { ReadInterceptor } from "./interceptor.js";
import type { InterceptOptions, InterceptionEvent } from "./interceptor.js";
import type { ReadRequest, InterceptionResult } from "./models.js";
import { configPath } from "./config.js";
import { ModelSelector } from "./model-selector.js";

const fixturePath = (name: string) => join(tmpdir(), `paradoc-${name}-${Date.now()}.txt`);
// Local seam: every test drives the interceptor through its public class API.
const readWith = (request: ReadRequest, options?: InterceptOptions): Promise<InterceptionResult> =>
  new ReadInterceptor(options).intercept(request);
const largeContent = Array.from({ length: 400 }, (_, index) =>
  index + 1 >= 120 && index + 1 <= 130
    ? `function recognisable_${index + 1}() {}`
    : `line ${index + 1}: ${"x".repeat(40)}` // realistic width: ~5k tokens, over the delegation floor
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
      const result = await readWith(
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
      const result = await readWith({ filePath, agentContext: { goal: "test" } });
      strictEqual(result.excerpts.length, 1);
      strictEqual(result.excerpts[0].startLine, 1);
      strictEqual(result.excerpts[0].endLine, 3);
      strictEqual(result.excerpts[0].content, content);
    });
  });

  it("uses an explicit question and slices verified source lines", async () => {
    await withFixture("explicit", largeContent, async (filePath) => {
      const runner = new FakeSubagentRunner({ structured: answer });
      const result = await readWith(
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
      const result = await readWith(
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
        const result = await readWith(
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
      const result = await readWith({ filePath, agentContext: {} }, { runner });
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
      const result = await readWith(
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
        const result = await readWith(
          { filePath, agentContext: {} },
          { runner: new FakeSubagentRunner(response) }
        );
        strictEqual(result.fallback?.reason, reason);
      }
    });
  });

  it("falls back when no runner is configured", async () => {
    await withFixture("no-runner", largeContent, async (filePath) => {
      const result = await readWith({ filePath, agentContext: {} });
      strictEqual(result.fallback?.reason, "no-runner");
      strictEqual(result.excerpts[0].content, largeContent);
    });
  });

  it("honours a custom interception threshold", async () => {
    const content = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    await withFixture("threshold", content, async (filePath) => {
      const runner = new FakeSubagentRunner({ structured: { ...answer, excerpts: [{ startLine: 1, endLine: 2 }] } });
      const result = await readWith({ filePath, agentContext: {} }, { runner, thresholdLines: 10, minTokens: 0 });
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
  const projectRoot = mkdtempSync(join(tmpdir(), "paradoc-project-"));
  const homeDir = mkdtempSync(join(tmpdir(), "paradoc-home-"));
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
      const result = await readWith({ filePath, agentContext: {} }, { runner });
      strictEqual(result.fallback?.reason, "binary-file");
      strictEqual(result.error, "binary file");
      strictEqual(runner.calls.length, 0);
    } finally {
      unlinkSync(filePath);
    }
  });

  it("returns small text files unchanged", async () => {
    await withFixture("small-guard", "a\nb", async (filePath) => {
      const result = await readWith({ filePath, agentContext: {} });
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
      await readWith({ filePath, agentContext: {} }, { runner, modelResolver: selector.resolve });
      strictEqual(picker.calls, 0);
      strictEqual(runner.calls.length, 0);
    });
  });

  it("does not resolve a model when no runner is configured", async () => {
    await withFixture("model-no-runner", largeContent, async (filePath) => {
      let resolverCalls = 0;
      const result = await readWith(
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
      await readWith(
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
    await withModelDirs(async (projectRoot, homeDir) => {
      await withFixture("model-cancel", largeContent, async (filePath) => {
        const events: Array<{ modelSource?: string }> = [];
        const runner = new FakeSubagentRunner({ structured: answer });
        const selector = new ModelSelector({
          projectRoot,
          homeDir,
          env: {},
          picker: { async pick() { return undefined; } },
        });
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

describe("token floor, cache and stats", () => {
  const ask = { agentContext: {}, question: "where?" };

  it("skips delegation for cheap files past the line threshold and counts a passthrough", async () => {
    const cheap = Array.from({ length: 400 }, (_, i) => `l${i}`).join("\n");
    await withFixture("cheap", cheap, async (filePath) => {
      const runner = new FakeSubagentRunner({ structured: answer });
      const interceptor = new ReadInterceptor({ runner });
      const result = await interceptor.intercept({ filePath, ...ask });
      strictEqual(result.wasIntercepted, false);
      strictEqual(runner.calls.length, 0);
      strictEqual(interceptor.stats().passthrough, 1);
    });
  });

  it("intercepts long-line files under the line threshold", async () => {
    const wide = Array.from({ length: 20 }, () => "y".repeat(2000)).join("\n");
    await withFixture("wide", wide, async (filePath) => {
      const runner = new FakeSubagentRunner({ structured: { ...answer, excerpts: [{ startLine: 1, endLine: 2 }] } });
      const result = await new ReadInterceptor({ runner }).intercept({ filePath, ...ask });
      strictEqual(result.wasIntercepted, true);
    });
  });

  it("serves an exact repeat from cache and invalidates on question, content and model change", async () => {
    await withFixture("cache", largeContent, async (filePath) => {
      const runner = new FakeSubagentRunner({ structured: answer });
      let model = { providerID: "p", modelID: "a" };
      const interceptor = new ReadInterceptor({ runner, cache: new LruResultCache(), modelResolver: async () => ({ choice: model, source: "env" as const }) });
      await interceptor.intercept({ filePath, ...ask });
      const hit = await interceptor.intercept({ filePath, ...ask });
      strictEqual(runner.calls.length, 1);
      strictEqual(hit.wasIntercepted, true);
      await interceptor.intercept({ filePath, ...ask, question: "other?" });
      strictEqual(runner.calls.length, 2);
      model = { providerID: "p", modelID: "b" };
      await interceptor.intercept({ filePath, ...ask });
      strictEqual(runner.calls.length, 3);
      writeFileSync(filePath, largeContent + "\nchanged");
      await interceptor.intercept({ filePath, ...ask });
      strictEqual(runner.calls.length, 4);
      const s = interceptor.stats();
      strictEqual(s.cacheHits, 1);
      strictEqual(s.delegations, 4);
      ok(s.estTokensSaved > 0 && s.estTokensDelegated > 0);
    });
  });

  it("does not cache failures", async () => {
    await withFixture("nocache-fail", largeContent, async (filePath) => {
      let n = 0;
      const runner = new FakeSubagentRunner(() => (++n === 1 ? { text: "garbage" } : { structured: answer }));
      const interceptor = new ReadInterceptor({ runner, cache: new LruResultCache() });
      strictEqual((await interceptor.intercept({ filePath, ...ask })).wasIntercepted, false);
      strictEqual((await interceptor.intercept({ filePath, ...ask })).wasIntercepted, true);
      strictEqual(interceptor.stats().fallbacks, 1);
    });
  });
  it("honours both threshold boundaries", async () => {
    const run = async (content: string, options = {}) => {
      let calls = 0;
      await withFixture("boundary", content, async (filePath) => {
        const runner = new FakeSubagentRunner({ structured: { ...answer, excerpts: [{ startLine: 1, endLine: 2 }] } });
        await new ReadInterceptor({ runner, ...options }).intercept({ filePath, ...ask });
        calls = runner.calls.length;
      });
      return calls;
    };
    // 350 lines (no trailing newline) is not "> 350"; 351 is.
    const rows = (n: number) => Array.from({ length: n }, () => "x".repeat(20)).join("\n");
    strictEqual(await run(rows(350)), 0);
    strictEqual(await run(rows(351)), 1);
    // minTokens: 351 lines of 11 chars = 4212 chars -> 1053 tokens; just under/over a 1053 floor.
    const small = Array.from({ length: 351 }, () => "y".repeat(11)).join("\n");
    strictEqual(await run(small, { minTokens: 1053 }), 1);
    strictEqual(await run(small, { minTokens: 1054 }), 0);
    // thresholdTokens applies under the line threshold: 8000 tokens = 32000 chars.
    strictEqual(await run("z".repeat(32_000)), 1);
    strictEqual(await run("z".repeat(31_996)), 0);
  });

  it("evicts least-recently-used entries and runs every read without a cache", async () => {
    await withFixture("lru", largeContent, async (filePath) => {
      const runner = new FakeSubagentRunner({ structured: answer });
      const interceptor = new ReadInterceptor({ runner, cache: new LruResultCache({ maxEntries: 2 }) });
      const read = (question: string) => interceptor.intercept({ filePath, agentContext: {}, question });
      await read("a"); await read("b"); await read("a"); // a is now most recent
      await read("c"); // evicts b
      strictEqual(runner.calls.length, 3);
      await read("a"); strictEqual(runner.calls.length, 3);
      await read("b"); strictEqual(runner.calls.length, 4);
    });
    await withFixture("nocache", largeContent, async (filePath) => {
      const runner = new FakeSubagentRunner({ structured: answer });
      const interceptor = new ReadInterceptor({ runner });
      await interceptor.intercept({ filePath, ...ask });
      await interceptor.intercept({ filePath, ...ask });
      strictEqual(runner.calls.length, 2);
      strictEqual(interceptor.stats().cacheHits, 0);
    });
  });

  it("keys on the resolved question, not agent context, and keeps source references on a hit", async () => {
    await withFixture("ctx", largeContent, async (filePath) => {
      const runner = new FakeSubagentRunner({ structured: answer });
      const interceptor = new ReadInterceptor({ runner, cache: new LruResultCache() });
      const first = await interceptor.intercept({ filePath, question: "q", agentContext: { currentTask: "one" } });
      const hit = await interceptor.intercept({ filePath, question: "q", agentContext: { currentTask: "two" } });
      strictEqual(runner.calls.length, 1);
      deepStrictEqual(hit.excerpts, first.excerpts);
      strictEqual(hit.excerpts[0].startLine, 118);
      ok(hit.excerpts[0].content.includes("recognisable_120"));
    });
  });

  it("counts retries in delegated tokens and cache hits as zero delegation", async () => {
    await withFixture("retry-stats", largeContent, async (filePath) => {
      let n = 0;
      const runner = new FakeSubagentRunner(() => {
        if (++n === 1) throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
        return { structured: answer };
      });
      const interceptor = new ReadInterceptor({ runner, retryDelayMs: 1, cache: new LruResultCache() });
      await interceptor.intercept({ filePath, ...ask });
      const once = interceptor.stats().estTokensDelegated;
      strictEqual(runner.calls.length, 2);
      await interceptor.intercept({ filePath, ...ask }); // cache hit
      const s = interceptor.stats();
      strictEqual(s.estTokensDelegated, once);
      strictEqual(s.delegations, 1);
      strictEqual(s.cacheHits, 1);
      ok(once > 0 && once % 2 === 0, `two attempts of one prompt: ${once}`);
    });
  });

  it("counts bypasses and read failures separately", async () => {
    const interceptor = new ReadInterceptor({ runner: new FakeSubagentRunner({ structured: answer }) });
    interceptor.noteBypass();
    await interceptor.intercept({ filePath: "/nonexistent/paradoc.txt", ...ask });
    const s = interceptor.stats();
    strictEqual(s.bypassed, 1);
    strictEqual(s.fallbacks, 1);
    strictEqual(s.delegations, 0);
  });
});
