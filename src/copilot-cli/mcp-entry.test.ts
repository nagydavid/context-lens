import { ok, strictEqual } from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { buildE2eFixture } from "../opencode/e2e-fixture.js";

const entry = fileURLToPath(new URL("./mcp-entry.js", import.meta.url));
const answer = JSON.stringify({
  excerpts: [{ startLine: 232, endLine: 238, reason: "checksum implementation" }],
  summary: "The checksum implementation normalizes its input.", confidence: 4,
});

type RpcMessage = { id: string | number | null; result?: any; error?: { code: number } };
class StdioClient {
  readonly messages: RpcMessage[] = [];
  readonly invalidLines: string[] = [];
  private sequence = 0;
  private buffer = "";
  private readonly waiters = new Map<string, (message: RpcMessage) => void>();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        try {
          const message = JSON.parse(line) as RpcMessage;
          this.messages.push(message);
          const key = String(message.id);
          const waiter = this.waiters.get(key);
          if (waiter) { this.waiters.delete(key); waiter(message); }
        } catch { this.invalidLines.push(line); }
      }
    });
  }

  request(method: string, params?: unknown): Promise<RpcMessage> {
    const id = ++this.sequence;
    return this.waitFor(String(id), () => this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
  }

  rawLine(line: string, expectedId: string): Promise<RpcMessage> {
    return this.waitFor(expectedId, () => this.line(line));
  }

  send(message: unknown): void { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  line(line: string): void { this.child.stdin.write(`${line}\n`); }

  private waitFor(key: string, write: () => void): Promise<RpcMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(key); reject(new Error(`timed out waiting for response ${key}`)); }, 14_000);
      this.waiters.set(key, (message) => { clearTimeout(timer); resolve(message); });
      write();
    });
  }
}

let root: string;
let child: ChildProcessWithoutNullStreams;
let client: StdioClient;
let stderr = "";
let callsPath: string;
let logPath: string;
let exited: Promise<number | null>;

before(() => {
  root = mkdtempSync(join(tmpdir(), "context-lens-mcp-entry-"));
  const fake = join(root, "fake-copilot.mjs");
  callsPath = join(root, "calls.jsonl");
  logPath = join(root, "mcp.jsonl");
  writeFileSync(fake, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.env.FAKE_COPILOT_CALLS, JSON.stringify({ argv: process.argv.slice(2), child: process.env.CONTEXT_LENS_CHILD }) + "\\n");\nprocess.stdout.write(${JSON.stringify(answer)});\n`);
  chmodSync(fake, 0o755);
  writeFileSync(join(root, "big.ts"), buildE2eFixture());
  writeFileSync(join(root, "small.ts"), "export const small = 'tiny';\n");
  const env: NodeJS.ProcessEnv = { ...process.env, CONTEXT_LENS_COPILOT_BIN: fake, FAKE_COPILOT_CALLS: callsPath, CONTEXT_LENS_LOG_FILE: logPath };
  delete env.CONTEXT_LENS_CHILD;
  delete env.CONTEXT_LENS_MODEL;
  child = spawn(process.execPath, [entry], { cwd: root, env, stdio: "pipe" });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  exited = new Promise((resolve) => child.on("close", resolve));
  client = new StdioClient(child);
});
after(async () => {
  if (child.exitCode === null) child.kill("SIGKILL");
  await exited;
  rmSync(root, { recursive: true, force: true });
});

describe("compiled MCP stdio entry", () => {
  it("(1) initializes with the requested protocol and does not answer notifications", { timeout: 15_000 }, async () => {
    const init = await client.request("initialize", { protocolVersion: "2025-06-18" });
    strictEqual(init.result.protocolVersion, "2025-06-18");
    strictEqual(init.result.serverInfo.name, "context-lens");
    const count = client.messages.length;
    client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    strictEqual(client.messages.length, count);
  });

  it("(2) lists context_lens_read", { timeout: 15_000 }, async () => {
    const listed = await client.request("tools/list");
    ok(listed.result.tools.some((tool: { name: string }) => tool.name === "context_lens_read"));
  });

  it("(3) condenses a big explicit question through the child runner", { timeout: 15_000 }, async () => {
    const response = await client.request("tools/call", { name: "context_lens_read", arguments: { path: "big.ts", question: "Where is the checksum?" } });
    const result = response.result as { content: [{ text: string }]; isError: boolean };
    strictEqual(result.isError, false);
    ok(result.content[0].text.includes("[context-lens]"));
    ok(result.content[0].text.includes("Confidence: 4/5"));
    ok(result.content[0].text.includes("--- lines 232-238"));
    ok(!result.content[0].text.includes("fixtureValue400"));
    const calls = readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    strictEqual(calls.length, 1);
    strictEqual(calls[0].child, "1");
    ok(calls[0].argv.includes("-p"));
  });

  it("(4) returns a raw range without another child call", { timeout: 15_000 }, async () => {
    const response = await client.request("tools/call", { name: "context_lens_read", arguments: { path: "big.ts", question: "raw", start_line: 1, end_line: 3 } });
    const text = response.result.content[0].text as string;
    ok(text.includes("00001|")); ok(text.includes("00003|"));
    strictEqual(readFileSync(callsPath, "utf8").trim().split("\n").length, 1);
  });

  it("(5) returns small files uncondensed", { timeout: 15_000 }, async () => {
    const response = await client.request("tools/call", { name: "context_lens_read", arguments: { path: "small.ts", question: "What is this?" } });
    ok(response.result.content[0].text.includes("not condensed"));
    ok(response.result.content[0].text.includes("export const small"));
  });

  it("(6) reports missing files as tool errors", { timeout: 15_000 }, async () => {
    const response = await client.request("tools/call", { name: "context_lens_read", arguments: { path: "missing.ts", question: "Where?" } });
    strictEqual(response.result.isError, true);
  });

  it("(7) returns JSON-RPC parse and unknown-method errors", { timeout: 15_000 }, async () => {
    const parseError = await client.rawLine("not json", "null");
    strictEqual(parseError.error?.code, -32700);
    const unknown = await client.request("not/a/method");
    strictEqual(unknown.error?.code, -32601);
  });

  it("(8) exits cleanly after stdin closes without stdout logs", { timeout: 15_000 }, async () => {
    child.stdin.end();
    strictEqual(await exited, 0);
    strictEqual(client.invalidLines.length, 0);
    ok(stderr.includes("[context-lens]"));
  });

  it("(9) records intercepted JSONL diagnostics", () => {
    const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const intercepted = records.find((record) => record.intercepted === true);
    ok(intercepted);
    strictEqual(typeof intercepted.elapsedMs, "number");
  });
});
