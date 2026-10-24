import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { install } from "./install.js";
import type { JoinSession } from "../copilot-cli/types.js";

// Acceptance through the artifacts install() actually writes (R008/R009): the installed
// OpenCode command template, the installed stdio MCP entry (spawned), and the installed
// Copilot extension entry that the generated shim imports.

const CONFIG_500 = '{"version":1,"tuning":{"thresholdLines":500}}\n';
const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Reply { isError: boolean; text: string }

class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, (message: any) => void>();
  private readonly child;
  stderr = "";

  constructor(entry: string, cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [entry], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (chunk) => { this.stderr += String(chunk); });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      this.pending.get(message.id)?.(message);
    });
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => reject(new Error(`mcp ${method} timed out; stderr=${this.stderr}`)), 15000);
      this.pending.set(id, (message) => { clearTimeout(timer); resolveReply(message); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async start(): Promise<void> {
    const init = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "acceptance", version: "0" } });
    ok(init.result, `initialize failed: ${JSON.stringify(init)}`);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<Reply> {
    const reply = await this.request("tools/call", { name, arguments: args });
    ok(reply.result, `${name} returned rpc error: ${JSON.stringify(reply.error)}`);
    return { isError: reply.result.isError === true, text: reply.result.content[0].text };
  }

  async stop(): Promise<void> {
    const exited = new Promise<void>((done) => this.child.once("exit", () => done()));
    this.child.stdin.end();
    await exited;
  }
}

let root: string;
let home: string;
let env: NodeJS.ProcessEnv;
let runtime: string;
let mcpEntry: string;
let configDir: string;
let projectSeq = 0;

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(base)) if (key.startsWith("PARADOC_")) delete base[key];
  return { ...base, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), ...extra };
}

function newProject(): string {
  const dir = join(root, `project-${++projectSeq}`);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

async function withServer<T>(project: string, extra: NodeJS.ProcessEnv, run: (client: McpClient) => Promise<T>): Promise<T> {
  const client = new McpClient(mcpEntry, project, cleanEnv(extra));
  try {
    await client.start();
    return await run(client);
  } finally {
    await client.stop();
  }
}

const thresholdRow = (text: string): string => text.split("\n").find((line) => /^\s*thresholdLines\s/.test(line)) ?? "";
const tuningOf = (project: string): unknown => JSON.parse(readFileSync(configFile(project), "utf8")).tuning;
const configFile = (project: string): string => join(project, ".paradoc", "config.json");

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "paradoc-acceptance-")));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  env = cleanEnv();
  install({ targets: ["opencode", "copilot"], home, env, cwd: root, distDir: DIST });
  runtime = join(home, ".local", "share", "paradoc", "dist");
  mcpEntry = join(runtime, "copilot-cli", "mcp-entry.js");
  configDir = join(home, ".config", "opencode");
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("OpenCode installed artifacts", () => {
  it("installs a marked /paradoc command mapping $ARGUMENTS onto the control tools", () => {
    const template = readFileSync(join(configDir, "commands", "paradoc.md"), "utf8");
    match(template, /^---\ndescription: ParaDoc controls: status \| set <key> <value> \| reset/);
    ok(template.includes("<!-- ParaDoc-generated command; safe to replace -->"), "marker missing");
    ok(template.includes("$ARGUMENTS"));
    for (const tool of ["paradoc_status", "paradoc_set", "paradoc_reset"]) ok(template.includes(tool), `${tool} not named`);
    match(template, /`paradoc_set` with `key`, `value`, and optional `scope`/);
    match(template, /`paradoc_reset` with optional `key` and `scope`/);
  });

  it("registers the installed MCP entry in opencode.jsonc", () => {
    const config = readFileSync(join(configDir, "opencode.jsonc"), "utf8");
    ok(config.includes(JSON.stringify(mcpEntry)), `opencode.jsonc does not reference ${mcpEntry}`);
    ok(existsSync(mcpEntry), `${mcpEntry} missing`);
  });
});

describe("installed MCP entry over stdio (OpenCode and Copilot MCP path)", () => {
  it("lists the control tools", async () => {
    const project = newProject();
    await withServer(project, {}, async (client) => {
      const listed = await client.request("tools/list");
      const names = listed.result.tools.map((tool: { name: string }) => tool.name);
      for (const tool of ["paradoc_status", "paradoc_set", "paradoc_reset"]) ok(names.includes(tool), `${tool} missing from ${names}`);
    });
  });

  it("status defaults, set writes the launch project's config, fresh process persists, reset removes", async () => {
    const project = newProject();
    await withServer(project, {}, async (client) => {
      const status = await client.call("paradoc_status");
      strictEqual(status.isError, false);
      match(thresholdRow(status.text), /thresholdLines\s+350\s+default/);

      const set = await client.call("paradoc_set", { key: "thresholdLines", value: "500" });
      strictEqual(set.isError, false, set.text);
      ok(set.text.includes(configFile(project)), `set did not report ${configFile(project)}: ${set.text}`);
      deepStrictEqual(tuningOf(project), { thresholdLines: 500 });
      ok(!existsSync(join(process.cwd(), ".paradoc", "config.json")) || process.cwd() === project, "wrote into the test launch dir");
      match(thresholdRow((await client.call("paradoc_status")).text), /thresholdLines\s+500\s+project/);
    });

    // A brand-new process (fresh session) reads the persisted value.
    await withServer(project, {}, async (client) => {
      match(thresholdRow((await client.call("paradoc_status")).text), /thresholdLines\s+500\s+project/);
      const reset = await client.call("paradoc_reset", { key: "thresholdLines" });
      strictEqual(reset.isError, false, reset.text);
      match(thresholdRow((await client.call("paradoc_status")).text), /thresholdLines\s+350\s+default/);
    });
  });

  it("accepts the value as a number as well as a string", async () => {
    const project = newProject();
    await withServer(project, {}, async (client) => {
      strictEqual((await client.call("paradoc_set", { key: "thresholdLines", value: 640 })).isError, false);
      deepStrictEqual(tuningOf(project), { thresholdLines: 640 });
      strictEqual((await client.call("paradoc_set", { key: "thresholdLines", value: "700", scope: "project" })).isError, false);
      deepStrictEqual(tuningOf(project), { thresholdLines: 700 });
    });
  });

  it("lets PARADOC_THRESHOLD win over the project file and shows provenance", async () => {
    const project = newProject();
    await withServer(project, {}, (client) => client.call("paradoc_set", { key: "thresholdLines", value: 500 }));
    await withServer(project, { PARADOC_THRESHOLD: "900" }, async (client) => {
      const row = thresholdRow((await client.call("paradoc_status")).text);
      match(row, /thresholdLines\s+900\s+env/);
    });
    // The project value is untouched and visible again once the env var is gone.
    deepStrictEqual(tuningOf(project), { thresholdLines: 500 });
  });

  it("rejects invalid key, value and scope with actionable text and leaves the file unchanged", async () => {
    const project = newProject();
    await withServer(project, {}, async (client) => {
      await client.call("paradoc_set", { key: "thresholdLines", value: 500 });
      const before = readFileSync(configFile(project), "utf8");
      const cases: Array<[string, Record<string, unknown>, RegExp]> = [
        ["unknown key", { key: "bogus", value: 1 }, /unknown key "bogus"/],
        ["non-numeric value", { key: "thresholdLines", value: "abc" }, /invalid value "abc" for thresholdLines/],
        ["out of range", { key: "thresholdLines", value: 0 }, /invalid value "0" for thresholdLines/],
        ["fractional value", { key: "thresholdLines", value: "1.5" }, /invalid value "1.5" for thresholdLines/],
        ["bad scope", { key: "thresholdLines", value: 5, scope: "universe" }, /./],
        ["missing value", { key: "thresholdLines" }, /./],
      ];
      for (const [label, args, pattern] of cases) {
        const reply = await client.call("paradoc_set", args);
        strictEqual(reply.isError, true, `${label}: expected isError, got ${reply.text}`);
        match(reply.text, pattern, label);
        strictEqual(readFileSync(configFile(project), "utf8"), before, `${label}: config changed`);
      }
      const badReset = await client.call("paradoc_reset", { key: "bogus" });
      strictEqual(badReset.isError, true);
      match(badReset.text, /unknown key "bogus"/);
      strictEqual(readFileSync(configFile(project), "utf8"), before);
    });
  });

  it("reset with no key clears every project value", async () => {
    const project = newProject();
    await withServer(project, {}, async (client) => {
      await client.call("paradoc_set", { key: "thresholdLines", value: 500 });
      await client.call("paradoc_set", { key: "concurrency", value: 2 });
      strictEqual((await client.call("paradoc_reset")).isError, false);
      const status = (await client.call("paradoc_status")).text;
      match(thresholdRow(status), /thresholdLines\s+350\s+default/);
      ok(!/concurrency\s+2\s+project/.test(status), status);
    });
  });

  it("names the config path when .paradoc/config.json is corrupt", async () => {
    const project = newProject();
    mkdirSync(join(project, ".paradoc"), { recursive: true });
    writeFileSync(configFile(project), "{not json");
    await withServer(project, {}, async (client) => {
      const reply = await client.call("paradoc_set", { key: "thresholdLines", value: 500 });
      strictEqual(reply.isError, true, reply.text);
      ok(reply.text.includes(configFile(project)), `error does not name the path: ${reply.text}`);
      strictEqual(readFileSync(configFile(project), "utf8"), "{not json");
    });
  });
});

describe("installed Copilot extension entry", () => {
  const entryPath = (): string => join(runtime, "copilot-cli", "extension-entry.js");
  const shimPath = (): string => join(home, ".copilot", "extensions", "paradoc", "extension.mjs");

  async function register(project: string, logs: string[]) {
    const mod = await import(pathToFileURL(entryPath()).href) as typeof import("../copilot-cli/extension-entry.js");
    let command: { handler: (ctx: { sessionId: string; command: string; commandName: string; args: string }) => Promise<void> } | undefined;
    const join_: JoinSession = async (config) => {
      command = config.commands?.find((entry) => entry.name === "paradoc") as typeof command;
      return { log: (message) => { logs.push(message); } };
    };
    const registered = await mod.registerParaDoc(join_, { env: cleanEnv(), configOptions: { homeDir: home, env: cleanEnv() } });
    ok(command, "no /paradoc command registered");
    const run = (args: string) => command!.handler({ sessionId: "s", command: `/paradoc ${args}`, commandName: "paradoc", args });
    return { registered, run };
  }

  it("shim imports the installed runtime entry", () => {
    const shim = readFileSync(shimPath(), "utf8");
    ok(shim.includes("@github/copilot-sdk/extension"));
    ok(shim.includes(pathToFileURL(entryPath()).href), "shim does not reference the installed extension-entry.js");
    ok(shim.includes("registerParaDoc(joinSession)"));
  });

  it("runs status/set/reset through command.handler and persists across registrations", async () => {
    const project = newProject();
    const logs: string[] = [];
    const previous = process.cwd();
    process.chdir(project);
    try {
      const first = await register(project, logs);
      await first.run("status");
      match(logs.at(-1) ?? "", /thresholdLines\s+350\s+default/);
      await first.run("set thresholdLines 500");
      ok((logs.at(-1) ?? "").includes(configFile(project)), logs.at(-1));
      deepStrictEqual(tuningOf(project), { thresholdLines: 500 });

      const second = await register(project, logs);
      await second.run("status");
      match(logs.at(-1) ?? "", /thresholdLines\s+500\s+project/);
      await second.run("reset thresholdLines");
      await second.run("status");
      match(logs.at(-1) ?? "", /thresholdLines\s+350\s+default/);
    } finally {
      process.chdir(previous);
    }
  });

  it("throws actionable errors for invalid input and leaves the config unchanged", async () => {
    const project = newProject();
    mkdirSync(join(project, ".paradoc"), { recursive: true });
    writeFileSync(configFile(project), CONFIG_500);
    const previous = process.cwd();
    process.chdir(project);
    try {
      const { run } = await register(project, []);
      await rejects(run("set thresholdLines abc"), /invalid value "abc" for thresholdLines/);
      await rejects(run("set bogus 1"), /unknown key "bogus"/);
      await rejects(run("frobnicate"), /unknown command "frobnicate"/);
      strictEqual(readFileSync(configFile(project), "utf8"), CONFIG_500);
    } finally {
      process.chdir(previous);
    }
  });
});
