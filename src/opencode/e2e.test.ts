import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { after, before, describe, it } from "node:test";
import {
  E2E_FIXTURE_LINES,
  E2E_FIXTURE_SYMBOL_RANGE,
  buildE2eFixture,
} from "./e2e-fixture.js";
import { ContextLensPlugin } from "./plugin.js";

type LogEntry = { service: string; level: string; message: string; extra?: Record<string, unknown> };
type Hooks = Awaited<ReturnType<typeof ContextLensPlugin>>;

const CONFIG = { version: 1, model: { providerID: "openai", modelID: "e2e-fast" } };
const SESSION = "ses_parent";
const CHILD = "ses_child_1";

let root: string;
let project: string;
let fixturePath: string;
let configPath: string;
let fixture: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["CONTEXT_LENS_MODEL", "XDG_CONFIG_HOME", "HOME"] as const;

before(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  root = mkdtempSync(join(tmpdir(), "context-lens-e2e-"));
  delete process.env.CONTEXT_LENS_MODEL;
  process.env.XDG_CONFIG_HOME = join(root, "xdg");
  process.env.HOME = join(root, "home");
  project = join(root, "project");
  mkdirSync(join(project, ".context-lens"), { recursive: true });
  fixture = buildE2eFixture();
  fixturePath = join(project, "big.ts");
  configPath = join(project, ".context-lens", "config.json");
  writeFileSync(fixturePath, fixture);
  writeFileSync(configPath, JSON.stringify(CONFIG));
});

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(root, { recursive: true, force: true });
});

type PromptHandler = (opts: { path: { id: string }; body: Record<string, any> }) => Promise<unknown>;

/** Fake client shaped like the OpenCode v2.0.30 SDK: `{ data: ... }` envelopes. */
function fakeClient(prompt: PromptHandler) {
  const calls: string[] = [];
  const prompts: Array<Record<string, any>> = [];
  const logs: LogEntry[] = [];
  const client = {
    session: {
      create: async () => {
        calls.push("create");
        return { data: { id: CHILD } };
      },
      prompt: async (opts: { path: { id: string }; body: Record<string, any> }) => {
        calls.push("prompt");
        prompts.push(opts.body);
        return prompt(opts);
      },
      delete: async () => {
        calls.push("delete");
        return { data: true };
      },
      abort: async () => {
        calls.push("abort");
        return { data: true };
      },
    },
    app: {
      log: async (o: { body: LogEntry }) => {
        logs.push(o.body);
        return { data: true };
      },
    },
  };
  return { client, calls, prompts, logs };
}

const goodAnswer: PromptHandler = async () => ({
  data: {
    info: {
      structured: {
        excerpts: [
          {
            startLine: E2E_FIXTURE_SYMBOL_RANGE.startLine,
            endLine: E2E_FIXTURE_SYMBOL_RANGE.endLine,
            reason: "defines computeLensChecksum",
          },
        ],
        summary: "computeLensChecksum builds the checksum.",
        confidence: 4,
      },
    },
    parts: [],
  },
});

async function build(client: unknown): Promise<Hooks> {
  return ContextLensPlugin({ client, directory: project, worktree: project });
}

async function ask(hooks: Hooks) {
  await hooks["chat.message"]!(
    { sessionID: SESSION },
    { message: {}, parts: [{ type: "text", text: "What does computeLensChecksum return?" }] } as any,
  );
  const output = { title: "big.ts", output: fixture, metadata: {} };
  const started = performance.now();
  await hooks["tool.execute.after"]!(
    { tool: "read", sessionID: SESSION, callID: "call_1", args: { filePath: fixturePath } },
    output,
  );
  return { output, wallMs: performance.now() - started };
}

const infoLog = (logs: LogEntry[]) =>
  logs.find((l) => l.service === "context-lens" && l.level === "info" && l.extra?.intercepted === true);

describe("OpenCode host-contract e2e (compiled plugin entry)", () => {
  it("(a) condenses a 400-line read with ranges and confidence under 5s", async () => {
    strictEqual(fixture.split("\n").length, E2E_FIXTURE_LINES);
    const { client, calls, prompts, logs } = fakeClient(goodAnswer);
    const { output, wallMs } = await ask(await build(client));

    ok(output.output.startsWith("[context-lens]"), "rendered header");
    ok(output.output.includes("Confidence: 4/5"));
    ok(output.output.includes(`lines ${E2E_FIXTURE_SYMBOL_RANGE.startLine}-${E2E_FIXTURE_SYMBOL_RANGE.endLine}`));
    ok(output.output.includes(`${String(E2E_FIXTURE_SYMBOL_RANGE.startLine).padStart(5, "0")}| export function computeLensChecksum`));
    ok(output.output.includes("C0NTEXT-LENS"));
    ok(output.output.length < fixture.length);

    deepStrictEqual(calls, ["create", "prompt", "delete"]);
    deepStrictEqual(prompts[0].model, CONFIG.model);
    strictEqual(prompts[0].format?.type, "json_schema");
    deepStrictEqual(prompts[0].tools, { "*": false });

    const log = infoLog(logs);
    ok(log, "info log with intercepted=true");
    strictEqual(log.extra?.modelSource, "project");
    ok((log.extra?.elapsedMs as number) < 5000);
    ok(wallMs < 5000);
  });

  it("(b) model config persists across separate plugin instances", async () => {
    const before = readFileSync(configPath);
    const second = fakeClient(goodAnswer);
    const { output } = await ask(await build(second.client));
    ok(output.output.startsWith("[context-lens]"));
    deepStrictEqual(second.prompts[0].model, CONFIG.model);
    strictEqual(infoLog(second.logs)?.extra?.modelSource, "project");
    ok(readFileSync(configPath).equals(before), "config unchanged byte-for-byte");
  });

  it("(c) falls back to the full file with a warn log when the prompt fails", async () => {
    const failing = fakeClient(async () => {
      throw new Error("provider exploded: invalid request");
    });
    const { output } = await ask(await build(failing.client));
    strictEqual(output.output, fixture);
    const warn = failing.logs.find((l) => l.level === "warn" && l.extra?.fallbackReason !== undefined);
    ok(warn, "warn log with fallbackReason");
    ok(failing.calls.includes("delete"), "child session deleted");

    const envelope = fakeClient(async () => ({ data: { info: { error: { name: "UnknownError", data: { message: "boom" } } } } }));
    const second = await ask(await build(envelope.client));
    strictEqual(second.output.output, fixture);
    ok(envelope.logs.some((l) => l.level === "warn" && l.extra?.fallbackReason !== undefined));
    ok(envelope.calls.includes("delete"));
  });

  it("(d) ignores reads from the plugin's own child session", async () => {
    let hooks: Hooks | undefined;
    let nested: { title: string; output: string; metadata: unknown } | undefined;
    const harness = fakeClient(async (opts) => {
      nested = { title: "big.ts", output: fixture, metadata: {} };
      await hooks!["tool.execute.after"]!(
        { tool: "read", sessionID: opts.path.id, callID: "call_child", args: { filePath: fixturePath } },
        nested,
      );
      return goodAnswer(opts);
    });
    hooks = await build(harness.client);
    const { output } = await ask(hooks);
    ok(output.output.startsWith("[context-lens]"));
    strictEqual(nested!.output, fixture);
    strictEqual(harness.calls.filter((c) => c === "create").length, 1);
  });
});
