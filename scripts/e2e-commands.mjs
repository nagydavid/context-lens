#!/usr/bin/env node
// Live dispatch of the INSTALLED /paradoc command on each host (R008/R009).
// Gated by PARADOC_E2E=1 (same contract as scripts/e2e-*.mjs); needs an authenticated model.
//
// Usage: PARADOC_E2E=1 node scripts/e2e-commands.mjs [--host opencode|copilot|all] [--scenario lifecycle|precedence|all]
//
// OpenCode 2.1.0 HTTP API (probed with `opencode api --standalone GET /openapi.json`):
//   auth        `opencode serve --port N --hostname 127.0.0.1` requires HTTP Basic auth, user `opencode`,
//               password from OPENCODE_SERVER_PASSWORD (unauthenticated calls return UnauthorizedError).
//   GET  /api/command                    command.list -> {location, data:[{name, description}]}. Right after
//                                        startup the list can still be empty while config loads, so poll.
//   POST /api/session                    session.create {model:{id, providerID}} -> {data:{id,...}}
//   POST /api/session/{id}/command       session.command {name, text} -> 204. Expands the installed
//                                        commands/paradoc.md template with `text` as $ARGUMENTS and queues
//                                        it as a user turn; the model then calls the MCP tools.
//   GET  /api/session/{id}/message?order=asc  -> {data:[{type: user|assistant|idle|...}]}; an `idle` message
//                                        marks the end of the turn. Assistant messages carry content parts.
//   Tool calls: v2 exposes MCP tools through a generic `execute` tool part. The part's input.code is
//               `tools.paradoc.paradoc_status({})` and state.metadata.toolCalls[].tool is
//               `paradoc.paradoc_status` (status completed|error). Assertions therefore key on those
//               names, the part state/output text and .paradoc/config.json, never on model prose.
// Env precedence: the server process environment (PARADOC_THRESHOLD) is inherited by the MCP child, so a
//   relaunch with the variable set must win over the stored project value.
// Isolation: temp XDG_CONFIG_HOME/project/runtime; XDG_DATA_HOME is left untouched for provider auth.
// Template expansion is LLM-mediated, so each step retries once when the model skips the tool call.
//
// Copilot CLI 1.0.103 probe (throwaway COPILOT_HOME with copied config.json/settings.json, temp git project with
// the installer's .github/extensions/paradoc/extension.mjs shim, GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true,
// --allow-all-tools --log-dir --log-level debug): `copilot -p "/paradoc status"`, `-p "/paradoc set thresholdLines 500"`
// and `-p "/paradoc set thresholdLines abc"` are NOT dispatched to the extension command. The text is sent to the
// model as an ordinary chat message (it greps docs, lists/reads extension.mjs, reloads extensions) and any
// "control text" in the output is model prose; .paradoc/config.json was never written after the `set`.
// Prompt mode therefore cannot prove slash dispatch, so the Copilot host SKIPs and relies on the hermetic
// installed-shim test in src/cli/acceptance.test.ts (command.handler through the installed extension-entry).
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const argValue = (flag, fallback) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : fallback);
const host = argValue("--host", "all");
const scenario = argValue("--scenario", "all");
const PASSWORD = "paradoc-e2e";
const TURN_TIMEOUT_MS = 120_000;

if (process.env.PARADOC_E2E !== "1") {
  console.log("SKIP command e2e (set PARADOC_E2E=1)");
  process.exit(0);
}

let failures = 0;
function report(ok, step, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` -- ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

async function findBinary() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const bundled = join(homedir(), ".opencode", "bin", "opencode");
  try { await access(bundled); return bundled; } catch { return "opencode"; }
}

function modelRef(spec) {
  const slash = spec.indexOf("/");
  if (slash < 1 || slash === spec.length - 1) throw new Error(`invalid model: ${spec}`);
  return { providerID: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

function makeApi(base) {
  const auth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`;
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { authorization: auth, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON body */ }
    return { ok: res.ok, status: res.status, json, text };
  };
}

/** Starts `opencode serve` in the temp project; PARADOC_* is cleared except what `extraEnv` sets. */
async function launch(ctx, extraEnv = {}) {
  const port = await freePort();
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PARADOC_")) delete env[key];
  Object.assign(env, extraEnv, { PWD: ctx.project, XDG_CONFIG_HOME: ctx.configHome, OPENCODE_SERVER_PASSWORD: PASSWORD });
  const child = spawn(ctx.binary, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: ctx.project, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => { log += c; });
  child.stderr.on("data", (c) => { log += c; });
  const server = { api: makeApi(`http://127.0.0.1:${port}`), log: () => log.slice(-1500) };
  server.stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`opencode serve exited early (${child.exitCode}): ${server.log()}`);
    try { if ((await server.api("GET", "/api/info")).ok) return server; } catch { /* not listening yet */ }
    if (Date.now() > deadline) { server.stop(); throw new Error(`opencode serve not healthy in 30s: ${server.log()}`); }
    await sleep(250);
  }
}

/** Tool calls found in one turn's assistant messages: [{tool, status, text, code}]. */
function toolCalls(messages) {
  const calls = [];
  for (const msg of messages) {
    if (msg.type !== "assistant") continue;
    for (const part of msg.content ?? []) {
      if (part.type !== "tool") continue;
      const code = typeof part.state?.input?.code === "string" ? part.state.input.code : "";
      const text = (part.state?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n")
        || part.state?.error?.message || "";
      const names = (part.state?.metadata?.toolCalls ?? []).map((c) => c.tool);
      const direct = /paradoc/.test(part.name ?? "") ? [part.name] : [];
      const toolNames = [...names, ...direct];
      if (code.includes("paradoc_")) toolNames.push(...[...code.matchAll(/paradoc_(status|set|reset)/g)].map((m) => `code:paradoc_${m[1]}`));
      calls.push({ tool: toolNames.join(","), status: part.state?.status, text, code, raw: part });
    }
  }
  return calls;
}

/** Runs `/paradoc <text>` in a NEW session and waits for the idle marker. */
async function dispatch(ctx, server, text) {
  const created = await server.api("POST", "/api/session", { model: ctx.model });
  if (!created.ok) throw new Error(`session.create ${created.status}: ${created.text}`);
  const id = created.json.data.id;
  const sent = await server.api("POST", `/api/session/${id}/command`, { name: "paradoc", text });
  if (sent.status !== 204) throw new Error(`session.command ${sent.status}: ${sent.text}`);
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  for (;;) {
    const res = await server.api("GET", `/api/session/${id}/message?order=asc`);
    const messages = res.json?.data ?? [];
    if (messages.some((m) => m.type === "idle")) return { id, messages, calls: toolCalls(messages) };
    if (Date.now() > deadline) throw new Error(`turn did not go idle in ${TURN_TIMEOUT_MS / 1000}s`);
    await sleep(1000);
  }
}

const hasTool = (calls, name) => calls.find((c) => c.tool.includes(name));

/** One checked step: dispatches `/paradoc <text>`, retries once if the model skipped the tool call. */
async function step(ctx, server, name, text, tool, verify) {
  let last = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const turn = await dispatch(ctx, server, text);
      const call = hasTool(turn.calls, tool);
      if (!call) {
        last = `no ${tool} tool call in turn (tools seen: ${turn.calls.map((c) => c.tool || "?").join(" | ") || "none"})`;
        continue;
      }
      const problem = await verify(call, turn);
      if (!problem) { report(true, name, `${tool} ${call.status}`); return call; }
      last = `${problem}\n    tool=${call.tool} status=${call.status} output:\n${call.text.split("\n").map((l) => `      ${l}`).join("\n")}`;
      if (attempt === 2) break;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  report(false, name, last);
  return undefined;
}

const readConfig = async (ctx) => {
  try { return JSON.parse(await readFile(join(ctx.project, ".paradoc", "config.json"), "utf8")); } catch { return undefined; }
};

async function scenarioLifecycle(ctx) {
  let server = await launch(ctx, {});
  try {
    let listed;
    const deadline = Date.now() + 30_000;
    do {
      listed = await server.api("GET", "/api/command");
      if (listed.json?.data?.some((c) => c.name === "paradoc") || Date.now() > deadline) break;
      await sleep(500);
    } while (true);
    const cmd = listed.json?.data?.find((c) => c.name === "paradoc");
    report(Boolean(cmd), "opencode command.list includes installed /paradoc", cmd ? cmd.description : `got ${JSON.stringify(listed.json?.data)}`);
    if (!cmd) return;

    await step(ctx, server, "opencode /paradoc status (defaults)", "status", "paradoc_status",
      (c) => (c.status === "completed" && /thresholdLines\s+350\s+default/.test(c.text) ? "" : "status did not report thresholdLines default 350"));

    await step(ctx, server, "opencode /paradoc set thresholdLines 500", "set thresholdLines 500", "paradoc_set", async (c) => {
      const cfg = await readConfig(ctx);
      if (c.status !== "completed") return "paradoc_set did not complete";
      return cfg?.thresholdLines === 500 || cfg?.settings?.thresholdLines === 500 || JSON.stringify(cfg ?? {}).includes("500")
        ? "" : `project .paradoc/config.json lacks 500: ${JSON.stringify(cfg)}`;
    });

    const before = JSON.stringify(await readConfig(ctx));
    await step(ctx, server, "opencode /paradoc set thresholdLines abc (invalid)", "set thresholdLines abc", "paradoc_set", async (c) => {
      console.log(`    invalid-input tool result (${c.status}): ${c.text.replace(/\s+/g, " ").slice(0, 240)}`);
      const rejected = c.status === "error" || /thresholdLines/.test(c.text) && /invalid|must be|usage|expected|not a/i.test(c.text);
      if (!rejected) return "invalid value was not rejected with error/usage text";
      return JSON.stringify(await readConfig(ctx)) === before ? "" : "config changed after invalid input";
    });
    server.stop();

    server = await launch(ctx, {});
    await step(ctx, server, "opencode fresh server + new session: status shows persisted project value", "status", "paradoc_status",
      (c) => (/thresholdLines\s+500\s+project/.test(c.text) ? "" : "persisted project value 500 not reported"));
    await step(ctx, server, "opencode /paradoc reset thresholdLines", "reset thresholdLines", "paradoc_reset", async (c) => {
      const cfg = await readConfig(ctx);
      return c.status === "completed" && !JSON.stringify(cfg ?? {}).includes("500") ? "" : `value still present: ${JSON.stringify(cfg)}`;
    });
    await step(ctx, server, "opencode status after reset returns to default", "status", "paradoc_status",
      (c) => (/thresholdLines\s+350\s+default/.test(c.text) ? "" : "default not restored"));
  } finally {
    server.stop();
  }
}

async function scenarioPrecedence(ctx) {
  // Seed the project value through the real tool path, then relaunch with env set: env must win.
  let server = await launch(ctx, {});
  try {
    await step(ctx, server, "opencode precedence: seed project thresholdLines 500", "set thresholdLines 500", "paradoc_set",
      (c) => (c.status === "completed" ? "" : "seed set did not complete"));
    server.stop();

    server = await launch(ctx, { PARADOC_THRESHOLD: "777" });
    await step(ctx, server, "opencode PARADOC_THRESHOLD=777 beats project 500 in status", "status", "paradoc_status", async (c) => {
      if (!/thresholdLines\s+777\s+env/.test(c.text)) return "env value 777 with source env not reported";
      return JSON.stringify(await readConfig(ctx) ?? {}).includes("500") ? "" : "project value 500 should remain stored under the env override";
    });
    server.stop();

    server = await launch(ctx, {});
    await step(ctx, server, "opencode precedence cleanup: reset thresholdLines", "reset thresholdLines", "paradoc_reset",
      (c) => (c.status === "completed" ? "" : "reset did not complete"));
  } finally {
    server.stop();
  }
}

async function runOpenCode() {
  const binary = await findBinary();
  const entry = join(root, "dist", "cli", "install.js");
  try { await access(entry); } catch { throw new Error("run npm run build"); }
  const { install } = await import(pathToFileURL(entry));
  const agentModel = process.env.E2E_AGENT_MODEL || "opencode/deepseek-v4.1-flash-free";
  const scenarios = { lifecycle: scenarioLifecycle, precedence: scenarioPrecedence };
  const names = scenario === "all" ? Object.keys(scenarios) : [scenario];
  if (names.some((n) => !scenarios[n])) throw new Error("--scenario must be lifecycle, precedence, or all");
  console.log(`opencode binary=${binary} model=${agentModel}`);
  for (const name of names) {
    const temp = await mkdtemp(join(tmpdir(), "paradoc-cmd-e2e-"));
    const ctx = { binary, model: modelRef(agentModel), project: join(temp, "project"), configHome: join(temp, "xdg-config") };
    try {
      await mkdir(ctx.project, { recursive: true });
      await mkdir(ctx.configHome, { recursive: true });
      const home = join(temp, "home");
      const written = install({
        targets: ["opencode"], home, cwd: ctx.project,
        env: { XDG_CONFIG_HOME: ctx.configHome, XDG_DATA_HOME: join(home, "data") },
        distDir: join(root, "dist"),
      });
      console.log(`installed (${name}): ${written.filter((l) => l.startsWith("opencode-command")).join(" ")}`);
      await scenarios[name](ctx);
    } catch (error) {
      report(false, `opencode ${name} scenario`, error instanceof Error ? error.message : String(error));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}

async function main() {
  if (!["opencode", "copilot", "all"].includes(host)) throw new Error("--host must be opencode, copilot, or all");
  if (host !== "copilot") await runOpenCode();
  if (host !== "opencode") console.log("SKIP copilot command dispatch: copilot -p sends \"/paradoc ...\" to the model as chat text (extension commands are not dispatched in prompt mode, probed on 1.0.103); proven by hermetic src/cli/acceptance.test.ts instead");
  console.log(failures === 0 ? "OK command e2e" : `FAILED command e2e (${failures} failing step${failures === 1 ? "" : "s"})`);
  if (failures) process.exit(1);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
