import { ok, strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import { createCopilotHooks } from "./hooks.js";
import { buildE2eFixture, buildViewInput } from "./probe-fixture.js";
import { createCopilotRunner, type ChildLike, type SpawnLike } from "./subagent.js";

const answer = JSON.stringify({
  excerpts: [{ startLine: 232, endLine: 238, reason: "checksum implementation" }],
  summary: "The checksum implementation normalizes its input.",
  confidence: 4,
});

type Log = Record<string, unknown>;
type Call = { command: string; args: readonly string[]; options: unknown; child: FakeChild };
type Behaviour =
  | { type: "json"; text?: string }
  | { type: "exit"; stderr: string; code: number }
  | { type: "enoent" }
  | { type: "hang" }
  | { type: "throw" };

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

function scriptedSpawn(behaviours: Behaviour[]): { spawn: SpawnLike; calls: Call[] } {
  const calls: Call[] = [];
  const spawn: SpawnLike = (command, args, options) => {
    const behaviour = behaviours.shift() ?? { type: "json" };
    if (behaviour.type === "throw") throw new Error("synchronous spawn failure");
    const child = fakeChild();
    calls.push({ command, args, options, child });
    setImmediate(() => {
      if (behaviour.type === "json") {
        child.stdout.end(behaviour.text ?? answer);
        child.emit("close", 0);
      } else if (behaviour.type === "exit") {
        child.stderr.end(behaviour.stderr);
        child.emit("close", behaviour.code);
      } else if (behaviour.type === "enoent") {
        child.emit("error", Object.assign(new Error("spawn copilot ENOENT"), { code: "ENOENT" }));
      }
    });
    return child;
  };
  return { spawn, calls };
}

let tmp: string;
before(() => { tmp = mkdtempSync(join(process.cwd(), ".tmp-copilot-matrix-")); });
after(() => rmSync(tmp, { recursive: true, force: true }));

function project(name: string): { dir: string; path: string } {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "fixture.ts");
  writeFileSync(path, buildE2eFixture());
  return { dir, path };
}

function view(path: string, workingDirectory: string) {
  return buildViewInput({ path, workingDirectory, text: "original native view", resultType: "success" });
}

function fallbackLog(logs: Log[]): Log {
  const record = logs.find((log) => log.level === "warn" && typeof log.fallbackReason === "string");
  ok(record, "expected a warn fallback record");
  return record;
}

function expectFallback(result: unknown, logs: Log[], reason: string): Log {
  strictEqual(result, undefined);
  const record = fallbackLog(logs);
  strictEqual(record.fallbackReason, reason);
  return record;
}

function hooksFor(
  behaviours: Behaviour[],
  workingDirectory: string,
  options: { env?: Record<string, string | undefined>; homeDir?: string; maxFileBytes?: number; timeoutMs?: number } = {},
) {
  const { spawn, calls } = scriptedSpawn(behaviours);
  const logs: Log[] = [];
  const hooks = createCopilotHooks({
    runner: createCopilotRunner({ command: "copilot", spawn, env: {} }),
    env: {},
    configOptions: { homeDir: options.homeDir ?? tmp, env: options.env ?? {}, projectRoot: tmp },
    logSink: (_line, record) => logs.push(record as Log),
    retryDelayMs: 1,
    timeoutMs: options.timeoutMs,
    maxFileBytes: options.maxFileBytes,
  });
  return { hooks, calls, logs };
}

function writeConfig(dir: string, body: string, global = false): void {
  const configDir = global ? join(dir, ".config", "paradoc") : join(dir, ".paradoc");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), body);
}

describe("copilot error matrix", () => {
  it("#1 falls back when the viewed file does not exist", async () => {
    const { dir } = project("missing");
    const test = hooksFor([], dir);
    expectFallback(await test.hooks.onPostToolUse(view(join(dir, "gone.ts"), dir)), test.logs, "file-not-found");
    strictEqual(test.calls.length, 0);
  });

  it("#2 falls back when the viewed file is too large", async () => {
    const { dir, path } = project("large");
    const test = hooksFor([], dir, { maxFileBytes: 1024 });
    expectFallback(await test.hooks.onPostToolUse(view(path, dir)), test.logs, "file-too-large");
    strictEqual(test.calls.length, 0);
  });

  it("#3 falls back when the viewed file is binary", async () => {
    const { dir } = project("binary");
    const path = join(dir, "binary.ts");
    writeFileSync(path, Buffer.concat([Buffer.from("const x = 1;\n"), Buffer.from([0]), Buffer.from("tail\n")]));
    const test = hooksFor([], dir);
    expectFallback(await test.hooks.onPostToolUse(view(path, dir)), test.logs, "binary-file");
    strictEqual(test.calls.length, 0);
  });

  it("#4 falls back for ENOENT and synchronous spawn failures", async () => {
    const { dir, path } = project("spawn-errors");
    const missing = hooksFor([{ type: "enoent" }], dir);
    const record = expectFallback(await missing.hooks.onPostToolUse(view(path, dir)), missing.logs, "subagent-error");
    ok(String(record.detail).includes("copilot binary not found (ENOENT)"));
    strictEqual(missing.calls.length, 1);
    const thrown = hooksFor([{ type: "throw" }], dir);
    expectFallback(await thrown.hooks.onPostToolUse(view(path, dir)), thrown.logs, "subagent-error");
  });

  it("#5 falls back for a non-zero child exit", async () => {
    const { dir, path } = project("non-zero");
    const test = hooksFor([{ type: "exit", stderr: "boom details", code: 7 }], dir);
    const record = expectFallback(await test.hooks.onPostToolUse(view(path, dir)), test.logs, "subagent-error");
    ok(String(record.detail).includes("exited with code 7"));
    ok(String(record.detail).includes("boom details"));
  });

  it("#6 does not retry an authentication failure", async () => {
    const { dir, path } = project("auth");
    const test = hooksFor([{ type: "exit", stderr: "Error: not authenticated. Run `copilot login` to sign in.", code: 1 }], dir);
    expectFallback(await test.hooks.onPostToolUse(view(path, dir)), test.logs, "subagent-error");
    strictEqual(test.calls.length, 1);
  });

  it("#7 kills a timed-out child and preserves the native view", async () => {
    const { dir, path } = project("timeout");
    const test = hooksFor([{ type: "hang" }], dir, { timeoutMs: 40 });
    // In this runner race, the interceptor timeout fires first, so the observed parity reason is timeout.
    const record = expectFallback(await test.hooks.onPostToolUse(view(path, dir)), test.logs, "timeout");
    // The outer fallback returns first; the child runner then settles its independently scheduled kill timer.
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    strictEqual(test.calls[0].child.killedWith, "SIGKILL");
    ok(/timed out/i.test(String(record.detail)));
  });

  it("#8 falls back for prose and empty child stdout", async () => {
    const { dir, path } = project("invalid-json");
    for (const text of ["Sure! Here is a summary...", ""]) {
      const test = hooksFor([{ type: "json", text }], dir);
      strictEqual(await test.hooks.onPostToolUse(view(path, dir)), undefined);
      ok(["invalid-response", "no-valid-excerpts"].includes(String(fallbackLog(test.logs).fallbackReason)));
    }
  });

  it("#9 retries transient failures before falling back", async () => {
    const { dir, path } = project("retry-exhausted");
    const test = hooksFor(Array.from({ length: 3 }, () => ({ type: "exit" as const, stderr: "fetch failed: ECONNRESET", code: 1 })), dir);
    const record = expectFallback(await test.hooks.onPostToolUse(view(path, dir)), test.logs, "network-error");
    ok(String(record.detail).includes("after 2 retries"));
    strictEqual(test.calls.length, 3);
  });

  it("#9b retries transient failure then intercepts a valid response", async () => {
    const { dir, path } = project("retry-recover");
    const test = hooksFor([{ type: "exit", stderr: "fetch failed: ECONNRESET", code: 1 }, { type: "json" }], dir);
    const result = await test.hooks.onPostToolUse(view(path, dir));
    ok(result?.modifiedResult);
    strictEqual(test.calls.length, 2);
    ok(test.logs.some((log) => log.level === "info" && log.intercepted === true));
  });

  it("#10 ignores malformed model configuration without passing --model", async () => {
    const cases = [
      { name: "invalid-json", config: "not json", env: {} },
      { name: "bad-version", config: JSON.stringify({ version: 2, model: { providerID: "github", modelID: "ignored" } }), env: {} },
      { name: "bad-env", config: undefined, env: { PARADOC_MODEL: "garbage" } },
    ];
    for (const item of cases) {
      const { dir, path } = project("bad-config-" + item.name);
      if (item.config) writeConfig(dir, item.config);
      const test = hooksFor([{ type: "json" }], dir, { env: item.env });
      ok((await test.hooks.onPostToolUse(view(path, dir)))?.modifiedResult);
      ok(test.logs.some((log) => log.level === "warn" && !log.fallbackReason && String(log.message).includes("ignoring")));
      ok(!test.calls[0].args.includes("--model"));
    }
  });

  it("#11 resolves model configuration env before project before global", async () => {
    const cases = [
      { name: "env", env: { PARADOC_MODEL: "github/env-model" }, projectModel: "project-model", globalModel: "global-model", expected: "env-model", source: "env" },
      { name: "project", env: {}, projectModel: "project-model", globalModel: "global-model", expected: "project-model", source: "project" },
      { name: "global", env: {}, projectModel: undefined, globalModel: "global-model", expected: "global-model", source: "global" },
      { name: "none", env: {}, projectModel: undefined, globalModel: undefined, expected: undefined, source: "none" },
    ];
    for (const item of cases) {
      const home = join(tmp, "model-home-" + item.name);
      const { dir, path } = project("model-project-" + item.name);
      if (item.projectModel) writeConfig(dir, JSON.stringify({ version: 1, model: { providerID: "github", modelID: item.projectModel } }));
      if (item.globalModel) writeConfig(home, JSON.stringify({ version: 1, model: { providerID: "github", modelID: item.globalModel } }), true);
      const test = hooksFor([{ type: "json" }], dir, { homeDir: home, env: item.env });
      ok((await test.hooks.onPostToolUse(view(path, dir)))?.modifiedResult);
      const index = test.calls[0].args.indexOf("--model");
      if (item.expected) strictEqual(test.calls[0].args[index + 1], item.expected);
      else strictEqual(index, -1);
      ok(!test.calls[0].args.some((arg) => arg.includes("github/")));
      const intercepted = test.logs.find((log) => log.level === "info" && log.intercepted === true);
      strictEqual(intercepted?.modelSource, item.source);
    }
  });
});
