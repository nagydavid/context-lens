import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { buildViewInput } from "./probe-fixture.js";
import {
  buildCopilotChildArgs,
  buildCopilotChildEnv,
  CopilotCliSubagentRunner,
  createCopilotRunner,
  NO_TOOLS_ARGS,
} from "./subagent.js";
import type { ChildLike, SpawnLike } from "./subagent.js";

const request = {
  prompt: "Find the relevant excerpt.",
  schema: { type: "object" },
  timeoutMs: 100,
  model: { providerID: "github", modelID: "gpt-x" },
};

interface FakeChild extends ChildLike {
  emit(event: "error", error: Error): boolean;
  emit(event: "close", code: number | null): boolean;
  killedWith?: NodeJS.Signals;
  stdout: PassThrough;
  stderr: PassThrough;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => { child.killedWith = signal; };
  return child;
}

function fakeSpawn(child: FakeChild, calls: Array<{ command: string; args: readonly string[]; options: unknown }>): SpawnLike {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
}

describe("CopilotCliSubagentRunner", () => {
  it("builds an isolated argv and forwards only modelID", () => {
    const args = buildCopilotChildArgs(request);
    deepStrictEqual(args.slice(0, 3), ["-p", request.prompt, "-s"]);
    ok(args.includes(NO_TOOLS_ARGS[0]));
    deepStrictEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "gpt-x"]);
    ok(!buildCopilotChildArgs({ ...request, model: undefined }).includes("--model"));
  });

  it("removes extension discovery from the child environment", () => {
    const env = buildCopilotChildEnv({ GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: "x", HOME: "/tmp/home" });
    strictEqual(env.CONTEXT_LENS_CHILD, "1");
    strictEqual(env.GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS, undefined);
    strictEqual(env.HOME, "/tmp/home");
  });

  it("returns stdout JSON as text", async () => {
    const child = fakeChild();
    const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
    const run = new CopilotCliSubagentRunner({ spawn: fakeSpawn(child, calls) }).run(request);
    child.stdout.end('{"confidence":4}');
    child.emit("close", 0);
    deepStrictEqual(await run, { text: '{"confidence":4}' });
    strictEqual(calls[0].command, "copilot");
  });

  it("rejects non-zero exits with stderr tail", async () => {
    const child = fakeChild();
    const run = new CopilotCliSubagentRunner({ spawn: fakeSpawn(child, []) }).run(request);
    child.stderr.end("fatal child failure");
    child.emit("close", 7);
    await rejects(run, /copilot exited with code 7: fatal child failure/);
  });

  it("labels ENOENT spawn errors with the configured binary", async () => {
    const child = fakeChild();
    const run = new CopilotCliSubagentRunner({ command: "missing-copilot", spawn: fakeSpawn(child, []) }).run(request);
    const error = Object.assign(new Error("spawn missing-copilot ENOENT"), { code: "ENOENT" });
    child.emit("error", error);
    await rejects(run, /copilot binary not found \(ENOENT\): missing-copilot/);
  });

  it("kills and rejects once when the child times out", async () => {
    const child = fakeChild();
    const run = new CopilotCliSubagentRunner({ spawn: fakeSpawn(child, []) }).run({ ...request, timeoutMs: 20 });
    await rejects(run, (error: Error) => error.name === "TimeoutError");
    strictEqual(child.killedWith, "SIGKILL");
    child.emit("close", 0);
  });

  it("uses the requested factory concurrency while retaining a serial default", async () => {
    const measure = async (concurrency?: number) => {
      let active = 0;
      let max = 0;
      const spawn: SpawnLike = () => {
        const child = fakeChild();
        active += 1;
        max = Math.max(max, active);
        setTimeout(() => {
          active -= 1;
          child.stdout.end('{"ok":true}');
          child.emit("close", 0);
        }, 10);
        return child;
      };
      const runner = createCopilotRunner({ spawn, concurrency });
      await Promise.all([runner.run(request), runner.run(request)]);
      return max;
    };
    strictEqual(await measure(), 1);
    strictEqual(await measure(2), 2);
  });

  it("builds a probe-shaped view input", () => {
    const input = buildViewInput({ path: "/tmp/file.ts", workingDirectory: "/tmp", text: "contents" });
    strictEqual(input.toolName, "view");
    deepStrictEqual(input.toolArgs, { path: "/tmp/file.ts" });
    strictEqual(input.toolResult.textResultForLlm, "contents");
    deepStrictEqual(input.toolResult.toolTelemetry, { properties: { viewType: "file" }, metrics: {} });
  });
});
