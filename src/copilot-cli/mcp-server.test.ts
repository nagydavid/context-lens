import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import { FakeSubagentRunner } from "../core/fake-runner.js";
import { JUDGE_SCHEMA } from "../core/judge.js";
import { buildE2eFixture } from "../opencode/e2e-fixture.js";
import { createMcpServer, serveStdio } from "./mcp-server.js";

const answer = JSON.stringify({
  excerpts: [{ startLine: 232, endLine: 238, reason: "checksum implementation" }],
  summary: "The checksum implementation normalizes its input.", confidence: 4,
});
let root: string;
before(() => { root = mkdtempSync(join(tmpdir(), "context-lens-mcp-")); });
after(() => rmSync(root, { recursive: true, force: true }));

function project(name: string, body = buildE2eFixture()) {
  const dir = join(root, name); const path = join(dir, "fixture.ts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, body);
  return { dir, path, relative: "fixture.ts" };
}
function server(dir: string, runner = new FakeSubagentRunner({ text: answer }), extra: Parameters<typeof createMcpServer>[0] = {}) {
  return { runner, mcp: createMcpServer({ cwd: dir, runner, configOptions: { env: {} }, ...extra }) };
}
async function call(mcp: ReturnType<typeof createMcpServer>, arguments_: Record<string, unknown>) {
  const response = await mcp.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_lens_read", arguments: arguments_ } });
  return response!.result as { content: [{ text: string }]; isError: boolean };
}

describe("MCP context_lens_read", () => {
  it("negotiates initialize, handles notifications, ping, and lists the tool", async () => {
    const { dir } = project("protocol"); const { mcp } = server(dir);
    const init = await mcp.handleMessage({ jsonrpc: "2.0", id: "a", method: "initialize", params: { protocolVersion: "2025-03-26" } });
    deepStrictEqual(init?.result, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "context-lens", version: "0.1.0" } });
    const unknown = await mcp.handleMessage({ jsonrpc: "2.0", id: 4, method: "initialize", params: { protocolVersion: "unknown" } });
    strictEqual((unknown!.result as any).protocolVersion, "2025-06-18");
    strictEqual(await mcp.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
    strictEqual(await mcp.handleMessage({ jsonrpc: "2.0", method: "unknown" }), undefined);
    deepStrictEqual((await mcp.handleMessage({ jsonrpc: "2.0", id: 5, method: "ping" }))?.result, {});
    const tools = (await mcp.handleMessage({ jsonrpc: "2.0", id: 6, method: "tools/list", params: { cursor: "ignored" } }))?.result as any;
    deepStrictEqual(tools.tools[0].inputSchema.required, ["path", "question"]);
  });

  it("condenses a large explicit question and leaves a small file raw", async () => {
    const large = project("large"); const largeServer = server(large.dir);
    const result = await call(largeServer.mcp, { path: large.relative, question: "Where is the checksum?" });
    strictEqual(result.isError, false); ok(result.content[0].text.includes("[context-lens]")); ok(result.content[0].text.includes("Question (explicit):")); ok(result.content[0].text.includes("Confidence: 4/5")); ok(result.content[0].text.includes("--- lines")); strictEqual(largeServer.runner.calls.length, 1);
    const small = project("small", "export const tiny = 1;\n"); const smallServer = server(small.dir);
    const raw = await call(smallServer.mcp, { path: small.relative, question: "What is this?" });
    strictEqual(raw.isError, false); ok(raw.content[0].text.includes("not condensed")); ok(raw.content[0].text.includes("00001| export const tiny = 1;")); strictEqual(smallServer.runner.calls.length, 0);
  });

  it("returns exact ranges without calling the runner", async () => {
    const item = project("ranges", "one\ntwo\nthree\nfour\n"); const test = server(item.dir);
    for (const [args, expected] of [[{ start_line: 2, end_line: 3 }, "00002| two\n00003| three"], [{ end_line: 2 }, "00001| one\n00002| two"], [{ start_line: 3 }, "00003| three\n00004| four"]] as const) {
      const result = await call(test.mcp, { path: item.relative, question: "exact", ...args }); strictEqual(result.isError, false); ok(result.content[0].text.includes(expected));
    }
    strictEqual(test.runner.calls.length, 0);
  });

  it("rejects invalid fields and guarded files", async () => {
    const item = project("invalid", "one\ntwo\n"); const test = server(item.dir);
    for (const args of [{ start_line: 2, end_line: 1 }, { start_line: 0 }, { start_line: 1.5 }, { path: "" }, { question: "" }]) {
      const result = await call(test.mcp, { path: item.relative, question: "q", ...args }); strictEqual(result.isError, true);
    }
    const absent = await call(test.mcp, {}); strictEqual(absent.isError, true); ok(absent.content[0].text.includes("path"));
    const missing = await call(test.mcp, { path: "gone.ts", question: "x" }); strictEqual(missing.isError, true); ok(missing.content[0].text.includes("file-not-found"));
    writeFileSync(join(item.dir, "binary.bin"), Buffer.from([65, 0, 66]));
    const binary = await call(test.mcp, { path: "binary.bin", question: "x" }); strictEqual(binary.isError, true); ok(binary.content[0].text.includes("binary-file"));
  });

  it("renders chunked reads and includes their count in diagnostics", async () => {
    const item = project("chunked", Array.from({ length: 3000 }, (_, index) => `const chunk${index + 1} = ${index + 1};`).join("\n"));
    const logs: string[] = [];
    const test = server(item.dir, new FakeSubagentRunner({ text: answer }), { chunkLines: 1000, chunkOverlapLines: 50, stderr: (line) => logs.push(line) });
    const result = await call(test.mcp, { path: item.relative, question: "Where is the target?" });
    strictEqual(result.isError, false);
    ok(result.content[0].text.includes("--- lines 232-238"));
    strictEqual(test.runner.calls.length, 4);
    ok(logs.some((line) => /chunks=4, \d+ms\)/.test(line)));
  });

  it("falls back on runner errors, logs the reason, and blocks child recursion", async () => {
    const item = project("fallback"); const logs: string[] = [];
    const failing = new FakeSubagentRunner(async () => { throw new Error("runner unavailable"); });
    const test = server(item.dir, failing, { stderr: (line) => logs.push(line) });
    const fallback = await call(test.mcp, { path: item.relative, question: "checksum" });
    strictEqual(fallback.isError, false); ok(fallback.content[0].text.includes("fallback: subagent-error")); ok(fallback.content[0].text.includes("00001|")); ok(logs.some((line) => line.includes("warn") && line.includes("subagent-error")));
    const childRunner = new FakeSubagentRunner({ text: answer }); const child = server(item.dir, childRunner, { env: { CONTEXT_LENS_CHILD: "1" } });
    const childResult = await call(child.mcp, { path: item.relative, question: "checksum" }); ok(childResult.content[0].text.includes("child process; not condensed")); strictEqual(childRunner.calls.length, 0);
  });

  it("renders judge outcomes and logs judge errors as warnings", async () => {
    for (const [judgeResult, expected, level, intercepted] of [
      [{ structured: { verdict: "sufficient" } }, "judge=sufficient", "info", true],
      [{ structured: { verdict: "insufficient", reason: "missing context" } }, "judge-rejected", "warn", false],
      [{ text: "not JSON" }, "judge=error", "warn", true],
    ] as const) {
      const item = project(`judge-${expected}`);
      const logs: string[] = [];
      const runner = new FakeSubagentRunner((request) => request.schema === JUDGE_SCHEMA ? judgeResult : { text: answer });
      const test = server(item.dir, runner, { judge: { mode: "always" }, stderr: (line) => logs.push(line) });
      const result = await call(test.mcp, { path: item.relative, question: "Where is the checksum?" });
      strictEqual(result.content[0].text.includes("[context-lens]"), true);
      strictEqual(result.content[0].text.includes("--- lines"), intercepted);
      if (!intercepted) ok(result.content[0].text.includes("fallback: judge-rejected"));
      ok(logs.some((line) => line.includes(level) && line.includes(expected)));
      strictEqual(runner.calls.filter((request) => request.schema === JUDGE_SCHEMA).length, 1);
    }
  });

  it("returns JSON-RPC errors and preserves string ids", async () => {
    const { dir } = project("errors"); const { mcp } = server(dir);
    const tool = await mcp.handleMessage({ jsonrpc: "2.0", id: "string-id", method: "tools/call", params: { name: "wrong" } }); strictEqual(tool?.id, "string-id"); strictEqual(tool?.error?.code, -32602);
    strictEqual((await mcp.handleMessage({ jsonrpc: "2.0", id: 2, method: "nope" }))?.error?.code, -32601);
    strictEqual((await mcp.handleMessage({ jsonrpc: "1.0", id: 3, method: "ping" }))?.error?.code, -32600);
  });

  it("serves newline-delimited requests concurrently and waits for output", async () => {
    const { dir } = project("stdio"); const input = new PassThrough(); const output = new PassThrough(); let text = "";
    output.on("data", (chunk) => { text += String(chunk); });
    const run = serveStdio(server(dir).mcp, { input, output });
    input.write("not json\n"); input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n'); input.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'); input.end();
    await run;
    const messages = text.trim().split("\n").map((line) => JSON.parse(line));
    strictEqual(messages.length, 3); strictEqual(messages[0].error.code, -32700); strictEqual(messages[0].id, null); ok(messages.some((message) => message.id === 1)); ok(messages.some((message) => message.id === 2));
  });

  it("serves a repeated read from cache with a cacheHit log line", async () => {
    const item = project("cache"); const logs: string[] = [];
    const test = server(item.dir, new FakeSubagentRunner({ text: answer }), { stderr: (line) => logs.push(line) });
    const first = await call(test.mcp, { path: item.relative, question: "Where is the checksum?" });
    const second = await call(test.mcp, { path: item.relative, question: "Where is the checksum?" });
    strictEqual(second.content[0].text, first.content[0].text);
    strictEqual(test.runner.calls.length, 1);
    ok(logs.some((line) => line.includes("cacheHit=true")));
  });
});
