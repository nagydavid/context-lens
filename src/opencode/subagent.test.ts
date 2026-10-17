import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it } from "node:test";
import { handleOpenCodeRead } from "./index.js";
import {
  createOpenCodeRunner,
  SessionSubagentRunner,
} from "./subagent.js";
import type { OpenCodeSessionClient } from "./subagent.js";

const request = {
  prompt: "Find the relevant excerpt.",
  schema: { type: "object" },
  timeoutMs: 100,
  model: { providerID: "anthropic", modelID: "cheap" },
};

type ClientOverrides = Partial<OpenCodeSessionClient["session"]>;

function mockClient(
  response: unknown = { data: { structured_output: { answer: true } } },
  overrides: ClientOverrides = {}
): { client: OpenCodeSessionClient; calls: string[]; promptBodies: Record<string, unknown>[] } {
  const calls: string[] = [];
  const promptBodies: Record<string, unknown>[] = [];
  const session = {
    create: async () => {
      calls.push("create");
      return { data: { id: "child-1" } };
    },
    prompt: async (opts: { path: { id: string }; body: Record<string, unknown> }) => {
      calls.push("prompt");
      promptBodies.push(opts.body);
      return response;
    },
    delete: async () => {
      calls.push("delete");
      return {};
    },
    abort: async () => {
      calls.push("abort");
      return {};
    },
    ...overrides,
  };
  return { client: { session }, calls, promptBodies };
}

describe("SessionSubagentRunner", () => {
  it("creates, prompts, and deletes a child session with structured output", async () => {
    const structured = { excerpts: [], summary: "done", confidence: 4 };
    const { client, calls, promptBodies } = mockClient({ data: { structured_output: structured } });
    const result = await new SessionSubagentRunner(client).run(request);

    deepStrictEqual(calls, ["create", "prompt", "delete"]);
    strictEqual((promptBodies[0].parts as Array<{ text: string }>)[0].text, request.prompt);
    deepStrictEqual(promptBodies[0].model, request.model);
    strictEqual((promptBodies[0].format as { type: string }).type, "json_schema");
    deepStrictEqual(promptBodies[0].tools, { "*": false });
    deepStrictEqual(result.structured, structured);
  });

  it("concatenates text parts and leaves structured undefined", async () => {
    const { client } = mockClient({
      data: { parts: [{ type: "text", text: "first " }, { type: "tool" }, { type: "text", text: "second" }] },
    });
    const result = await new SessionSubagentRunner(client).run(request);

    strictEqual(result.text, "first second");
    strictEqual(result.structured, undefined);
  });

  it("rejects response errors and still deletes the session", async () => {
    const { client, calls } = mockClient({ data: { info: { error: { message: "prompt failed" } } } });
    await rejects(new SessionSubagentRunner(client).run(request), /prompt failed/);
    deepStrictEqual(calls, ["create", "prompt", "delete"]);
  });

  it("preserves prompt failure when deletion also fails", async () => {
    const { client, calls } = mockClient(undefined, {
      prompt: async () => {
        calls.push("prompt");
        throw new Error("prompt failed");
      },
      delete: async () => {
        calls.push("delete");
        throw new Error("delete failed");
      },
    });
    await rejects(new SessionSubagentRunner(client).run(request), /prompt failed/);
    deepStrictEqual(calls, ["create", "prompt", "delete"]);
  });

  it("tags create errors as spawn failures without prompting or deleting", async () => {
    const { client, calls } = mockClient(undefined, {
      create: async () => {
        calls.push("create");
        throw new Error("unavailable");
      },
    });
    await rejects(new SessionSubagentRunner(client).run(request), /^Error: subagent spawn failed: unavailable$/);
    deepStrictEqual(calls, ["create"]);
  });

  it("aborts and deletes a slow prompt when its timeout expires", async () => {
    const { client, calls } = mockClient(undefined, {
      prompt: async () => {
        calls.push("prompt");
        return new Promise(() => undefined);
      },
    });
    await rejects(
      new SessionSubagentRunner(client).run({ ...request, timeoutMs: 20 }),
      (error: Error) => error.name === "TimeoutError"
    );
    deepStrictEqual(calls, ["create", "prompt", "abort", "delete"]);
  });

  it("bounds a non-settling v2 session deletion", { timeout: 2_000 }, async () => {
    const { client, calls } = mockClient({ data: { structured_output: { ok: true } } }, {
      delete: async () => {
        calls.push("delete");
        return new Promise(() => undefined);
      },
    });
    const startedAt = Date.now();
    const result = await new SessionSubagentRunner(client).run(request);
    ok(Date.now() - startedAt < 1_500);
    deepStrictEqual(calls, ["create", "prompt", "delete"]);
    deepStrictEqual(result.structured, { ok: true });
  });

  it("reads parts and structured output from the verified SDK 1.19.3 shape", async () => {
    const structured = { excerpts: [], summary: "s", confidence: 4 };
    const { client } = mockClient({
      data: { info: { structured }, parts: [{ type: "text", text: "hi" }] },
    });
    const result = await new SessionSubagentRunner(client).run(request);
    deepStrictEqual(result, { structured, text: "hi" });
  });

  it("rejects top-level error envelopes and still deletes the session", async () => {
    const { client, calls } = mockClient({ error: { name: "BadRequestError", data: { message: "bad" } } });
    await rejects(new SessionSubagentRunner(client).run(request), /bad/);
    deepStrictEqual(calls, ["create", "prompt", "delete"]);
  });

  it("includes create error detail in spawn failures", async () => {
    const { client } = mockClient(undefined, {
      create: async () => ({ error: { name: "Unauthorized" } }),
    });
    await rejects(new SessionSubagentRunner(client).run(request), /subagent spawn failed: Unauthorized/);
  });

  it("fires lifecycle callbacks once each, even when the prompt rejects", async () => {
    const events: string[] = [];
    const { client } = mockClient(undefined, {
      prompt: async () => {
        throw new Error("boom");
      },
    });
    await rejects(
      new SessionSubagentRunner(client, {
        onSessionCreated: (id) => events.push(`created:${id}`),
        onSessionClosed: (id) => events.push(`closed:${id}`),
      }).run(request),
      /boom/
    );
    deepStrictEqual(events, ["created:child-1", "closed:child-1"]);
  });

  it("ignores throwing lifecycle callbacks", async () => {
    const { client, calls } = mockClient({ data: { structured_output: { ok: true } } });
    const result = await new SessionSubagentRunner(client, {
      onSessionCreated: () => {
        throw new Error("cb");
      },
      onSessionClosed: () => {
        throw new Error("cb");
      },
    }).run(request);
    deepStrictEqual(calls, ["create", "prompt", "delete"]);
    deepStrictEqual(result.structured, { ok: true });
  });

  it("uses the requested factory concurrency while retaining a serial default", async () => {
    const measure = async (concurrency?: number) => {
      let active = 0;
      let max = 0;
      let nextId = 0;
      const client: OpenCodeSessionClient = { session: {
        create: async () => ({ data: { id: `child-${++nextId}` } }),
        prompt: async () => {
          active += 1;
          max = Math.max(max, active);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
          active -= 1;
          return { data: { structured_output: { ok: true } } };
        },
        delete: async () => ({}),
      } };
      const runner = createOpenCodeRunner(client, concurrency === undefined ? {} : { concurrency });
      await Promise.all([runner.run(request), runner.run(request)]);
      return max;
    };
    strictEqual(await measure(), 1);
    strictEqual(await measure(2), 2);
  });

  it("forwards explicit questions through handleOpenCodeRead to a serialized runner", async () => {
    const filePath = join(tmpdir(), `paradoc-opencode-${Date.now()}.txt`);
    const content = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n") + "\n" + "z".repeat(4000);
    writeFileSync(filePath, content);
    const { client, promptBodies } = mockClient({
      data: {
        structured_output: {
          excerpts: [{ startLine: 120, endLine: 122, reason: "foo is here" }],
          summary: "foo definition",
          confidence: 5,
        },
      },
    });
    try {
      const result = await handleOpenCodeRead(
        { filePath, question: "Where is foo defined?" },
        { runner: createOpenCodeRunner(client) }
      );
      strictEqual(result.wasIntercepted, true);
      strictEqual(result.confidence, 5);
      strictEqual(result.excerpts[0].content, "line 120\nline 121\nline 122");
      ok((promptBodies[0].parts as Array<{ text: string }>)[0].text.includes("Where is foo defined?"));
    } finally {
      unlinkSync(filePath);
    }
  });
});
