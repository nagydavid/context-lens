#!/usr/bin/env node
// Uses a temporary XDG_CONFIG_HOME so user plugins/config are isolated; XDG_DATA_HOME
// remains untouched because it contains OpenCode provider authentication.
//
// Scenarios (--scenario happy|persist|fallback|large|cache|judge|all, gated by PARADOC_E2E=1):
//   happy    condensed excerpts + confidence, interception < 5s (R001, R003, R005)
//   persist  two separate `opencode run` processes (= two plugin instances) with a
//            pre-seeded project config; both must resolve modelSource "project" and the
//            config file must stay byte-identical (R002). NOTE: the live "first read
//            prompts" picker cannot be shown: the host has no blocking TUI select (D003),
//            so persistence is proven via a pre-seeded project config across fresh
//            instances; picker-save persistence is covered by the S02/S04 hermetic tests.
//   fallback a nonexistent subagent model; the read must return the full file and a
//            paradoc warn `fallback <reason> for <path>` must be logged (R004).
//   large    a 3000-line fixture with chunk fan-out enabled through the v2 env stopgap.
//   cache    one run that reads the fixture twice; the second `intercepted` log must carry
//            cacheHit=true and a tiny elapsed time (in-memory result cache, one process).
//   judge    PARADOC_JUDGE=always; the log must carry judge=<verdict>, or the read must
//            fall back with judge-rejected. A judge error is non-fatal (warn, excerpts kept).
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist", "opencode");
const fixtureModule = join(dist, "e2e-fixture.js");
const pluginModule = join(dist, "plugin-v2.js");
let E2E_FIXTURE_LINES, E2E_FIXTURE_SYMBOL, E2E_LARGE_FIXTURE_LINES, E2E_LARGE_FIXTURE_SYMBOL;
const scenario = process.argv.includes("--scenario")
  ? process.argv[process.argv.indexOf("--scenario") + 1]
  : "all";

function skip(message) {
  console.log(`SKIP: ${message}`);
  process.exit(0);
}

async function exists(path) {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

async function executable(path) {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

async function findBinary() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const bundled = join(homedir(), ".opencode", "bin", "opencode");
  if (await executable(bundled)) return bundled;
  return "opencode";
}

function run(command, args, options) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      ...options, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const settle = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // `opencode run` leaves its `serve --stdio` child behind on some exits; reap the whole group.
      try { if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); } catch { /* group already gone */ }
      resolveRun({ code, signal, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* The command may already have exited. */ }
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      settle(null, "SIGKILL");
    }, 45_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { stderr += `\n${error.message}`; });
    child.on("close", settle);
  });
}

function modelParts(spec) {
  const slash = spec.indexOf("/");
  if (slash < 1 || slash === spec.length - 1) throw new Error(`invalid model: ${spec}`);
  return { providerID: spec.slice(0, slash), modelID: spec.slice(slash + 1) };
}

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

function hostDiagnostics(transcript) {
  return transcript.split("\n")
    .filter((line) => !/watcher (started|subscribe|stopped)/i.test(line))
    .filter((line) => /paradoc|plugin|error|session|tool|read/i.test(line))
    .slice(-80)
    .join("\n");
}

function headerFor(totalLines) {
  return new RegExp(`\\[paradoc\\].*showing (\\d+) of ${totalLines} lines`);
}

function parseEvents(stdout) {
  const events = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try { events.push(JSON.parse(line)); } catch { /* not a JSON event line */ }
  }
  return events;
}

/** Outputs of completed `read` tool calls on the fixture, in order. */
function readOutputs(stdout) {
  return parseEvents(stdout)
    .map((e) => e.part)
    .filter((p) => p?.type === "tool" && p.tool === "read" && p.state?.status === "completed")
    .map((p) => String(p.state.output ?? ""));
}

/** Parses `[paradoc] <level>: <message> {extra-json}` lines printed by the plugin. */
function pluginLogs(transcript) {
  const logs = [];
  for (const line of transcript.split("\n")) {
    const m = line.match(/^\[paradoc\] (\w+): (.*?)(?: (\{.*\}))?$/);
    if (!m) continue;
    let extra;
    try { extra = m[3] ? JSON.parse(m[3]) : undefined; } catch { /* keep message only */ }
    logs.push({ level: m[1], message: m[2], extra });
  }
  return logs;
}

async function setupProject(temp, configHome, modelConfig, fixture) {
  const fixturePath = join(temp, "fixture.ts");
  await mkdir(join(temp, ".paradoc"), { recursive: true });
  await mkdir(join(temp, ".opencode", "plugins"), { recursive: true });
  await writeFile(fixturePath, fixture, "utf8");
  await writeFile(join(temp, ".paradoc", "config.json"), JSON.stringify({ version: 1, model: modelConfig }) + "\n");
  // v2 auto-discovers project shims and invokes their default export. Keep the
  // plugin module's single named export intact for the package API.
  const pluginShim = join(temp, ".opencode", "plugins", "paradoc.js");
  await writeFile(
    pluginShim,
    `export { ParaDocV2Plugin as default } from ${JSON.stringify(pathToFileURL(pluginModule).href)};\n`,
  );
  // v2's project scan is optional in standalone mode, so register the same shim
  // explicitly through the singular plugin array as well.
  await writeFile(join(temp, "opencode.jsonc"), JSON.stringify({ plugin: [pathToFileURL(pluginShim).href] }) + "\n");
  await mkdir(configHome, { recursive: true });
  return fixturePath;
}

async function opencodeRun(ctx, temp, configHome, fixturePath, symbol = E2E_FIXTURE_SYMBOL, extraEnv = {}, promptOverride) {
  const prompt = promptOverride ?? `Use the read tool to read ${fixturePath} in full (no offset or limit), then tell me what ${symbol} returns.`;
  const started = Date.now();
  const result = await run(ctx.binary, ["run", "--standalone", "--auto", "--format", "json", "--print-logs", "--log-level", "debug", "--model", ctx.agentModel, prompt], {
    cwd: temp,
    env: { ...process.env, ...extraEnv, PWD: temp, XDG_CONFIG_HOME: configHome },
  });
  const transcript = `${result.stdout}\n${result.stderr}`;
  if (process.env.E2E_DUMP) await writeFile(process.env.E2E_DUMP, transcript, { flag: "a" });
  assertion(!result.timedOut, `opencode run exceeded 45s:\n${hostDiagnostics(transcript)}`);
  assertion(result.code === 0, `opencode run failed (${result.code}): ${transcript.slice(-1500)}`);
  return { transcript, reads: readOutputs(result.stdout), logs: pluginLogs(transcript), wallMs: Date.now() - started };
}

function checkCondensed(r, totalLines = E2E_FIXTURE_LINES, maxElapsedMs = 5000) {
  const header = headerFor(totalLines);
  const condensed = r.reads.find((o) => header.test(o));
  assertion(condensed, `missing condensed paradoc tool output:\n${hostDiagnostics(r.transcript)}`);
  const confidence = condensed.match(/Confidence:\s*(\d)\/5/);
  assertion(confidence, "missing confidence N/5 in tool output");
  assertion(/--- lines \d+-\d+/.test(condensed), "missing numbered excerpt range in tool output");
  const linesReturned = Number(condensed.match(header)[1]);
  assertion(linesReturned > 0 && linesReturned < totalLines, "tool output was not shorter than fixture");
  const log = r.logs.find((l) => l.level === "info" && /^intercepted /.test(l.message));
  assertion(log, "missing paradoc intercepted log");
  const elapsedMs = Number(log.message.match(/(\d+)ms\)$/)?.[1]);
  assertion(Number.isFinite(elapsedMs), "interception log did not end with elapsed milliseconds");
  assertion(elapsedMs < maxElapsedMs, `interception exceeded ${maxElapsedMs}ms: ${elapsedMs}ms`);
  return { elapsedMs, confidence: Number(confidence[1]), linesReturned, modelSource: log.extra?.modelSource };
}

async function scenarioHappy(ctx, temp, configHome) {
  const fixturePath = await setupProject(temp, configHome, ctx.model, ctx.fixture);
  const r = checkCondensed(await opencodeRun(ctx, temp, configHome, fixturePath));
  assertion(r.modelSource === "project", `expected modelSource project, got ${r.modelSource}`);
  return { scenario: "happy", ok: true, ...r, totalLines: E2E_FIXTURE_LINES };
}

async function scenarioPersist(ctx, temp, configHome) {
  const fixturePath = await setupProject(temp, configHome, ctx.model, ctx.fixture);
  const configPath = join(temp, ".paradoc", "config.json");
  const before = await readFile(configPath);
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const r = checkCondensed(await opencodeRun(ctx, temp, configHome, fixturePath));
    assertion(r.modelSource === "project", `persist run ${i + 1}: expected modelSource project, got ${r.modelSource}`);
    runs.push(r);
  }
  assertion((await readFile(configPath)).equals(before), "project config changed during persist runs");
  const stray = (await readdir(configHome, { recursive: true })).filter((f) => /paradoc/i.test(f));
  assertion(stray.length === 0, `global paradoc config appeared under isolated config home: ${stray}`);
  return {
    scenario: "persist", ok: true, modelSources: runs.map((r) => r.modelSource),
    elapsedMs: Math.max(...runs.map((r) => r.elapsedMs)), confidence: runs[1].confidence,
    configByteIdentical: true,
  };
}

async function scenarioFallback(ctx, temp, configHome) {
  const bad = { providerID: "openai", modelID: "paradoc-does-not-exist" };
  const fixturePath = await setupProject(temp, configHome, bad, ctx.fixture);
  const r = await opencodeRun(ctx, temp, configHome, fixturePath);
  assertion(!r.reads.some((o) => headerFor(E2E_FIXTURE_LINES).test(o)), "fallback read unexpectedly condensed");
  const full = r.reads.find((o) => o.includes("fixtureValue1()") && o.includes("fixtureValue400()") && o.includes("C0NTEXT-LENS"));
  assertion(full, `fallback read did not return the full file:\n${hostDiagnostics(r.transcript)}`);
  const log = r.logs.find((l) => l.level === "warn" && /^fallback \S+ for /.test(l.message));
  assertion(log, `missing warn fallback log:\n${hostDiagnostics(r.transcript)}`);
  assertion(r.wallMs < 45_000, "fallback run too slow");
  return {
    scenario: "fallback", ok: true, fallbackReason: log.message.match(/^fallback (\S+)/)[1],
    logLine: log.message, wallMs: r.wallMs,
  };
}

async function scenarioLarge(ctx, temp, configHome) {
  const fixturePath = await setupProject(temp, configHome, ctx.model, ctx.largeFixture);
  const runLarge = async (concurrency) => {
    const raw = await opencodeRun(
      ctx,
      temp,
      configHome,
      fixturePath,
      E2E_LARGE_FIXTURE_SYMBOL,
      { PARADOC_CHUNK_LINES: "1000", PARADOC_CONCURRENCY: String(concurrency) },
    );
    const condensed = raw.reads.find((output) => headerFor(E2E_LARGE_FIXTURE_LINES).test(output));
    assertion(condensed?.includes(`export function ${E2E_LARGE_FIXTURE_SYMBOL}`), "condensed output omitted fan-out symbol lines");
    const result = checkCondensed(raw, E2E_LARGE_FIXTURE_LINES, Infinity);
    const chunks = Number(raw.logs.find((log) => log.level === "info" && /^intercepted /.test(log.message))?.message.match(/chunks=(\d+)/)?.[1]);
    assertion(chunks >= 3, `expected at least 3 chunks, got ${chunks}`);
    return { ...result, chunks };
  };

  try {
    return { scenario: "large", ok: true, concurrencyPinned: false, concurrency: 3, totalLines: E2E_LARGE_FIXTURE_LINES, ...await runLarge(3) };
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error);
    if (!/(session|chunk \d+\/\d+.*(?:subagent|error)|subagent-error)/i.test(detail)) throw error;
    const pinned = await runLarge(1);
    return { scenario: "large", ok: true, concurrencyPinned: true, concurrency: 1, totalLines: E2E_LARGE_FIXTURE_LINES, ...pinned };
  }
}

async function scenarioCache(ctx, temp, configHome) {
  const fixturePath = await setupProject(temp, configHome, ctx.model, ctx.fixture);
  const prompt = `Use the read tool to read ${fixturePath} in full (no offset or limit). Wait for that result, and only then use the read tool to read ${fixturePath} in full again; never issue both reads in the same step. Then tell me what ${E2E_FIXTURE_SYMBOL} returns.`;
  const r = await opencodeRun(ctx, temp, configHome, fixturePath, E2E_FIXTURE_SYMBOL, {}, prompt);
  checkCondensed(r);
  const intercepts = r.logs.filter((l) => l.level === "info" && /^intercepted /.test(l.message));
  assertion(intercepts.length >= 2, `expected at least 2 intercepted logs, got ${intercepts.length}:\n${hostDiagnostics(r.transcript)}`);
  assertion(!intercepts[0].message.includes("cacheHit=true"), "first read unexpectedly reported cacheHit=true");
  const hit = intercepts.slice(1).find((l) => l.message.includes("cacheHit=true"));
  assertion(hit, `no later intercepted log reported cacheHit=true:\n${intercepts.map((l) => l.message).join("\n")}`);
  const cachedElapsedMs = Number(hit.message.match(/(\d+)ms\)$/)?.[1]);
  assertion(Number.isFinite(cachedElapsedMs) && cachedElapsedMs < 50, `cached interception not fast: ${cachedElapsedMs}ms`);
  const firstElapsedMs = Number(intercepts[0].message.match(/(\d+)ms\)$/)?.[1]);
  return { scenario: "cache", ok: true, cacheHit: true, firstElapsedMs, cachedElapsedMs, intercepts: intercepts.length };
}

async function scenarioJudge(ctx, temp, configHome) {
  const fixturePath = await setupProject(temp, configHome, ctx.model, ctx.fixture);
  const r = await opencodeRun(ctx, temp, configHome, fixturePath, E2E_FIXTURE_SYMBOL, { PARADOC_JUDGE: "always" });
  const rejected = r.logs.find((l) => l.level === "warn" && /^fallback judge-rejected for /.test(l.message));
  if (rejected) {
    assertion(r.reads.some((o) => o.includes("fixtureValue400()")), `judge-rejected read did not return the full file:\n${hostDiagnostics(r.transcript)}`);
    return { scenario: "judge", ok: true, judge: "insufficient", fallbackReason: "judge-rejected", logLine: rejected.message };
  }
  // A judge error logs a warn `intercepted ... judge=error ms) judge error: <detail>`; success logs info.
  const judged = r.logs.find((l) => /^intercepted /.test(l.message) && /judge=(\w+)/.test(l.message));
  if (judged) {
    const verdict = judged.message.match(/judge=(\w+)/)[1];
    checkCondensed(r);
    if (judged.level === "warn" || verdict === "error") {
      return { scenario: "judge", ok: true, judge: "error", judgeWarning: judged.message };
    }
    return { scenario: "judge", ok: true, judge: verdict };
  }
  throw new Error(`no judge verdict in paradoc logs:\n${hostDiagnostics(r.transcript)}`);
}

async function main() {
  if (process.env.PARADOC_E2E !== "1") skip("set PARADOC_E2E=1");
  if (!await exists(pluginModule) || !await exists(fixtureModule)) {
    throw new Error("run npm run build");
  }
  const binary = await findBinary();
  const binaryProbe = await run(binary, ["--version"], { cwd: root, env: process.env });
  if (binaryProbe.code !== 0) skip("opencode binary not found");
  const scenarios = { happy: scenarioHappy, persist: scenarioPersist, fallback: scenarioFallback, large: scenarioLarge,
    cache: scenarioCache, judge: scenarioJudge };
  if (scenario !== "all" && !scenarios[scenario]) {
    throw new Error("--scenario must be happy, persist, fallback, large, cache, judge, or all");
  }
  const fixtureMod = await import(pathToFileURL(fixtureModule));
  E2E_FIXTURE_LINES = fixtureMod.E2E_FIXTURE_LINES;
  E2E_FIXTURE_SYMBOL = fixtureMod.E2E_FIXTURE_SYMBOL;
  E2E_LARGE_FIXTURE_LINES = fixtureMod.E2E_LARGE_FIXTURE_LINES;
  E2E_LARGE_FIXTURE_SYMBOL = fixtureMod.E2E_LARGE_FIXTURE_SYMBOL;
  const agentModel = process.env.E2E_AGENT_MODEL || "opencode/deepseek-v4.1-flash-free";
  const subagentModel = process.env.E2E_SUBAGENT_MODEL || "opencode/beam-free";
  const ctx = {
    binary, agentModel, subagentModel, model: modelParts(subagentModel), fixture: fixtureMod.buildE2eFixture(),
    largeFixture: fixtureMod.buildLargeE2eFixture(),
  };
  const hostVersion = binaryProbe.stdout.trim();
  const names = scenario === "all" ? Object.keys(scenarios) : [scenario];
  const started = Date.now();
  const results = [];
  let failure;
  for (const name of names) {
    const temp = await mkdtemp(join(tmpdir(), "paradoc-e2e-"));
    try {
      // The free subagent model occasionally returns non-JSON (fallback invalid-response);
      // the plugin degrades correctly, but the live assertion needs one retry on a fresh project.
      let result, attempts = 0;
      for (;;) {
        attempts++;
        const attemptTemp = attempts === 1 ? temp : await mkdtemp(join(tmpdir(), "paradoc-e2e-"));
        try {
          result = await scenarios[name](ctx, attemptTemp, join(attemptTemp, "xdg-config"));
          break;
        } catch (error) {
          if (attempts >= 2) throw error;
          console.error(`retrying ${name} after: ${String(error instanceof Error ? error.message : error).split("\n")[0]}`);
        } finally {
          if (attemptTemp !== temp) await rm(attemptTemp, { recursive: true, force: true });
        }
      }
      result.attempts = attempts;
      results.push(result);
      console.log(JSON.stringify({ hostVersion, agentModel, subagentModel, ...result }));
    } catch (error) {
      failure = error;
      console.log(JSON.stringify({ scenario: name, ok: false }));
      console.error(error instanceof Error ? error.message : String(error));
      break;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  const by = (n) => results.find((r) => r.scenario === n);
  console.log(JSON.stringify({
    ok: !failure && results.length === names.length, hostVersion, elapsedMs: (by("happy") ?? by("persist"))?.elapsedMs,
    totalWallMs: Date.now() - started, confidence: (by("happy") ?? by("persist"))?.confidence,
    modelSource: (by("persist") ?? by("happy"))?.modelSources?.join(",") ?? by("happy")?.modelSource,
    fallbackReason: by("fallback")?.fallbackReason,
    chunks: by("large")?.chunks,
    concurrencyPinned: by("large")?.concurrencyPinned,
    cacheHit: by("cache")?.cacheHit,
    judge: by("judge")?.judge,
  }));
  if (failure || results.length !== names.length) process.exit(1);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
