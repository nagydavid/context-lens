import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FakeSubagentRunner } from "../core/fake-runner.js";
import type { PdfExtractor } from "../core/pdf.js";
import type { WebTransport, WebTransportResponse } from "../core/web-fetch.js";
import { runControlCommand } from "../cli/controls-cli.js";
import { createParaDocHooks } from "../opencode/hooks.js";
import type { ParaDocClient } from "../opencode/hooks.js";
import { createCopilotHooks } from "./hooks.js";
import { registerParaDoc } from "./extension-entry.js";
import { createMcpServer } from "./mcp-server.js";
import type { JoinSession } from "./types.js";
import { buildViewInput } from "./probe-fixture.js";

const answer = {
  excerpts: [{ startLine: 10, endLine: 12, reason: "target" }],
  summary: "Found it.",
  confidence: 4,
};
const tick = () => new Promise((r) => setImmediate(r));

let tmp: string;
let readme: string;
let notes: string;
let smallReadme: string;
let pdf: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "paradoc-parity-"));
  readme = join(tmp, "README.md");
  notes = join(tmp, "notes.txt");
  smallReadme = join(tmp, "small-README.md");
  pdf = join(tmp, "report.pdf");
  writeFileSync(readme, Array.from({ length: 400 }, (_, i) => `# Section ${i + 1}\nParagraph ${i + 1}`).join("\n"));
  writeFileSync(notes, Array.from({ length: 400 }, (_, i) => `note ${i + 1}: this documentation paragraph contains enough prose to exceed the token floor.`).join("\n"));
  writeFileSync(smallReadme, "# Small\nOnly a few lines\n");
  writeFileSync(pdf, "%PDF-1.4\nplaceholder");
});
after(() => rmSync(tmp, { recursive: true, force: true }));

interface HostResult {
  /** Final text the host would show the model (native text when unchanged). */
  text: string;
  changed: boolean;
  calls: number;
  logs: Array<{ level: string; message: string; fallbackReason?: unknown; detail?: unknown }>;
}
type Host = { name: string; read(path: string, opts?: { pdfExtractor?: PdfExtractor; ranged?: boolean }): Promise<HostResult> };

const NATIVE = "original native read output\n".repeat(400);

const opencodeHost: Host = {
  name: "opencode",
  async read(path, opts = {}) {
    const entries: Array<{ body: { level: string; message: string; extra?: Record<string, unknown> } }> = [];
    const client = {
      session: { create: async () => ({}), prompt: async () => ({}), delete: async () => ({}) },
      app: { log: async (entry: (typeof entries)[number]) => { entries.push(entry); } },
    } as unknown as ParaDocClient;
    const runner = new FakeSubagentRunner({ structured: answer });
    const hooks = createParaDocHooks({
      client, directory: tmp, runner, configOptions: { homeDir: tmp, env: {} },
      ...(opts.pdfExtractor ? { pdfExtractor: opts.pdfExtractor } : {}),
    });
    const out = { title: path, output: NATIVE, metadata: {} };
    const args = opts.ranged ? { filePath: path, offset: 1, limit: 20 } : { filePath: path };
    await hooks["tool.execute.after"]({ tool: "read", sessionID: "s1", callID: "c1", args }, out);
    await tick();
    return {
      text: out.output, changed: out.output !== NATIVE, calls: runner.calls.length,
      logs: entries.map(({ body }) => ({ level: body.level, message: body.message, fallbackReason: body.extra?.fallbackReason, detail: body.extra?.detail })),
    };
  },
};

const copilotHost: Host = {
  name: "copilot",
  async read(path, opts = {}) {
    const logs: HostResult["logs"] = [];
    const runner = new FakeSubagentRunner({ structured: answer });
    const hooks = createCopilotHooks({
      runner, env: {}, configOptions: { homeDir: tmp, env: {}, projectRoot: tmp },
      logSink: (_line, record) => {
        const r = record as Record<string, unknown>;
        logs.push({ level: String(r.level), message: String(r.message), fallbackReason: r.fallbackReason, detail: r.detail });
      },
      ...(opts.pdfExtractor ? { pdfExtractor: opts.pdfExtractor } : {}),
    });
    const toolArgs = opts.ranged ? { path, view_range: [1, 20] } : { path };
    const result = await hooks.onPostToolUse(buildViewInput({ path, workingDirectory: tmp, text: NATIVE, toolArgs }));
    const text = result?.modifiedResult?.textResultForLlm;
    return { text: text ?? NATIVE, changed: text !== undefined, calls: runner.calls.length, logs };
  },
};
const hosts = [opencodeHost, copilotHost];

const pdfText = ["--- page 1 ---", ...Array.from({ length: 400 }, (_, i) => `PDF line ${i + 1}`)].join("\n");
const okPdf: PdfExtractor = async () => ({ ok: true, pages: 1, text: pdfText });
const range = (text: string) => /--- lines (\d+-\d+)/.exec(text)?.[1];

describe("cross-host parity: documents and PDFs", () => {
  for (const [label, file] of [["(P1) large markdown", () => readme], ["(P2) large text", () => notes]] as const) {
    it(`${label} is condensed identically on both hosts`, async () => {
      const results = await Promise.all(hosts.map((h) => h.read(file())));
      for (const r of results) {
        ok(r.changed);
        strictEqual(range(r.text), "10-12", r.text);
        strictEqual(r.calls, 1);
      }
    });
  }

  it("(P1/P2) the subagent prompt uses the document wording on both hosts", async () => {
    // Prompt wording is asserted through the per-host runners captured via a shared recording runner.
    for (const path of [readme, notes]) {
      for (const host of hosts) {
        const original = FakeSubagentRunner.prototype.run;
        const seen: string[] = [];
        FakeSubagentRunner.prototype.run = function (this: FakeSubagentRunner, ...a: Parameters<typeof original>) {
          seen.push((a[0] as { prompt: string }).prompt);
          return original.apply(this, a);
        } as typeof original;
        try { await host.read(path); } finally { FakeSubagentRunner.prototype.run = original; }
        strictEqual(seen.length, 1, host.name);
        ok(seen[0].includes("inline documentation file"), host.name);
      }
    }
  });

  it("(P3) PDF with extracted text is condensed with equal excerpt ranges", async () => {
    const results = await Promise.all(hosts.map((h) => h.read(pdf, { pdfExtractor: okPdf })));
    for (const r of results) {
      ok(r.changed);
      strictEqual(r.calls, 1);
      ok(r.text.includes("PDF line 10"), r.text);
    }
    strictEqual(range(results[0].text), range(results[1].text));
    strictEqual(range(results[0].text), "10-12");
  });

  for (const reason of ["pdf-encrypted", "pdf-malformed", "pdf-no-text", "extractor-unavailable"] as const) {
    it(`(P4) ${reason} falls back with identical warn diagnostics`, async () => {
      const detail = `distinctive-${reason}-detail`;
      const extractor: PdfExtractor = async () => ({ ok: false, reason, error: "pdf text unavailable", detail });
      const results = await Promise.all(hosts.map((h) => h.read(pdf, { pdfExtractor: extractor })));
      const warns = results.map((r) => {
        strictEqual(r.changed, false);
        strictEqual(r.text, NATIVE);
        strictEqual(r.calls, 0);
        const w = r.logs.filter((l) => l.level === "warn" && l.fallbackReason === reason);
        strictEqual(w.length, 1, JSON.stringify(r.logs));
        return w[0];
      });
      strictEqual(warns[0].detail, detail);
      strictEqual(warns[1].detail, detail);
      strictEqual(warns[0].message, warns[1].message);
    });
  }

  it("(P5) small README and ranged reads pass through with zero runner calls", async () => {
    for (const host of hosts) {
      const small = await host.read(smallReadme);
      strictEqual(small.changed, false, host.name);
      strictEqual(small.calls, 0, host.name);
      const ranged = await host.read(readme, { ranged: true });
      strictEqual(ranged.changed, false, host.name);
      strictEqual(ranged.calls, 0, host.name);
      const rangedPdf = await host.read(pdf, { pdfExtractor: okPdf, ranged: true });
      strictEqual(rangedPdf.changed, false, host.name);
      strictEqual(rangedPdf.calls, 0, host.name);
    }
  });
});

describe("cross-host parity: controls", () => {
  it("(P10) CLI, MCP, and Copilot commands persist and render identically across a restart", async () => {
    const root = join(tmp, "control-parity");
    const options = { cwd: root, homeDir: tmp, env: {} };
    const config = join(root, ".paradoc", "config.json");
    const clearProject = () => rmSync(join(root, ".paradoc"), { recursive: true, force: true });

    const cli = runControlCommand(["set", "thresholdLines", "500"], options);
    strictEqual(cli.code, 0, cli.stderr);
    const cliConfig = readFileSync(config, "utf8");
    clearProject();

    const mcp = createMcpServer({ cwd: root, env: {}, configOptions: { homeDir: tmp, env: {} }, stderr: () => {} });
    const mcpSet = await mcp.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "paradoc_set", arguments: { key: "thresholdLines", value: 500 },
    } });
    const mcpResult = mcpSet!.result as { content: [{ text: string }]; isError: boolean };
    strictEqual(mcpResult.isError, false);
    const mcpConfig = readFileSync(config, "utf8");
    clearProject();

    const logs: string[] = [];
    let registration: Parameters<JoinSession>[0] | undefined;
    const joinSession: JoinSession = async (value) => {
      registration = value;
      return { log: (message) => logs.push(message) };
    };
    await registerParaDoc(joinSession, { env: {}, configOptions: { homeDir: tmp, env: {}, projectRoot: root }, logSink: () => undefined });
    await registration!.hooks.onUserPromptSubmitted?.({ sessionId: "p10", prompt: "controls", workingDirectory: root });
    const command = registration!.commands!.find((entry) => entry.name === "paradoc")!;
    await command.handler({ sessionId: "p10", command: "/paradoc", commandName: "paradoc", args: "set thresholdLines 500" });
    const copilotConfig = readFileSync(config, "utf8");

    strictEqual(cliConfig, mcpConfig);
    strictEqual(mcpConfig, copilotConfig);
    strictEqual(cli.stdout, mcpResult.content[0].text + "\n");

    const cliStatus = runControlCommand(["status"], options).stdout.trim();
    const mcpStatus = await mcp.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "paradoc_status", arguments: {} } });
    const mcpStatusText = (mcpStatus!.result as { content: [{ text: string }] }).content[0].text;
    await command.handler({ sessionId: "p10", command: "/paradoc", commandName: "paradoc", args: "status" });
    strictEqual(cliStatus, mcpStatusText);
    strictEqual(mcpStatusText, logs.at(-1));

    const restarted = createMcpServer({ cwd: root, env: {}, configOptions: { homeDir: tmp, env: {} }, stderr: () => {} });
    const afterRestart = await restarted.runtime.getStatus(root);
    strictEqual(afterRestart.settings.thresholdLines, 500);
    strictEqual(afterRestart.sources.thresholdLines, "project");
  });
});

describe("cross-host parity: web MCP surface", () => {
  const PUBLIC_HOST = async () => ["93.184.216.34"];
  const URL_ = "https://docs.example.com/guide";
  const page = (type: string, body: string): WebTransport => async () => ({
    status: 200, headers: { "content-type": type },
    body: (async function* () { yield Buffer.from(body); })(),
  }) as WebTransportResponse;
  const big = `<html><head><title>Guide</title></head><body><main>${Array.from({ length: 400 }, (_, i) => `<p>Line ${i + 1} explains documentation option number ${i + 1}.</p>`).join("\n")}</main></body></html>`;

  function web(webFetchOptions: Record<string, unknown>) {
    const runner = new FakeSubagentRunner({ structured: answer });
    const mcp = createMcpServer({ cwd: tmp, runner, configOptions: { env: {} }, stderr: () => {}, webFetchOptions: webFetchOptions as never });
    return { runner, mcp };
  }
  async function webCall(mcp: ReturnType<typeof createMcpServer>, args: Record<string, unknown>) {
    const response = await mcp.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "paradoc_web_read", arguments: args } });
    return response!.result as { content: [{ text: string }]; isError: boolean };
  }

  it("(P6) a large HTML page is condensed with provenance and an excerpt range", async () => {
    const { mcp, runner } = web({ transport: page("text/html", big), resolveHost: PUBLIC_HOST });
    const result = await webCall(mcp, { url: URL_, question: "Which option?" });
    strictEqual(result.isError, false);
    const text = result.content[0].text;
    ok(text.includes("Untrusted external web content from"), text);
    ok(/--- lines \d+-\d+/.test(text), text);
    strictEqual(runner.calls.length, 1);
  });

  const failures: Array<[string, string, string, Record<string, unknown>]> = [
    ["(P7)", "http://127.0.0.1/", "unsafe-url", { transport: page("text/html", "x"), resolveHost: PUBLIC_HOST }],
    ["(P8)", URL_, "timeout", {
      resolveHost: PUBLIC_HOST, timeoutMs: 30,
      transport: async () => ({ status: 200, headers: { "content-type": "text/html" }, body: (async function* () { await new Promise((r) => setTimeout(r, 300)); yield Buffer.from("late"); })() }),
    }],
    ["(P9)", URL_, "unsupported-content-type", { transport: page("image/png", "PNG"), resolveHost: PUBLIC_HOST }],
  ];
  for (const [id, url, reason, opts] of failures) {
    it(`${id} ${reason} is a visible error with zero runner calls`, async () => {
      const { mcp, runner } = web(opts);
      const result = await webCall(mcp, { url, question: "q" });
      strictEqual(result.isError, true);
      ok(result.content[0].text.includes(`(${reason})`), result.content[0].text);
      strictEqual(runner.calls.length, 0);
    });
  }
});
