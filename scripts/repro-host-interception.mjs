#!/usr/bin/env node
// Gated live reproduction of implicit native-read interception on both supported hosts.
// Prints one summary line per run and writes structured JSON evidence (--out, default
// docs/m008-repro-evidence.json). The PARADOC_E2E gate runs before argument validation and
// before any host is touched, so `npm test` never depends on a host, a model, or the network.
//
// Runs (sequential on purpose: both hosts spawn model children and share free-model quota).
// Each definition names the harness scenario it runs (`--scenario <definition.scenario>`):
//   opencode  happy          scripts/e2e-opencode.mjs --scenario happy,
//                            E2E_AGENT_MODEL/E2E_SUBAGENT_MODEL default openai/gpt-5.6-terra
//   opencode  large          --scenario large: 3000-line fixture with chunk fan-out
//   copilot   happy          scripts/e2e-copilot.mjs --scenario happy,
//                            PARADOC_MODEL default github/claude-haiku-4.5
//   copilot   pass-through   --scenario pass-through: a small full view plus a `view_range`
//                            view must produce ZERO intercepted records (offset-only rule)
//   copilot   default-model  same harness WITHOUT the PARADOC_MODEL override, so the global
//                            default model (claude-haiku-5-5) is aliased to claude-haiku-4.5
//                            by COPILOT_MODEL_ALIASES and the read is condensed. This used to
//                            be a labelled known failure (expectedFailure); the v0.2.2 alias
//                            map merged into milestone/M008 makes it an ordinary PASS run.
//
// Usage: PARADOC_E2E=1 node scripts/repro-host-interception.mjs [--out <path>]
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

// Gate first — must precede argument parsing, dist checks, and every host probe.
if (process.env.PARADOC_E2E !== "1") {
  console.log("SKIP host-interception repro (set PARADOC_E2E=1)");
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");
const RUN_TIMEOUT = Number(process.env.PARADOC_REPRO_TIMEOUT_MS || 300_000);
const PROBE_TIMEOUT = 30_000;
const LOG_TAIL_LINES = 40;
const OPENCODE_MODEL = process.env.E2E_AGENT_MODEL || "openai/gpt-5.6-terra";
const OPENCODE_SUBAGENT_MODEL = process.env.E2E_SUBAGENT_MODEL || OPENCODE_MODEL;
const COPILOT_MODEL = process.env.PARADOC_MODEL || "github/claude-haiku-4.5";

function parseArgs(argv) {
  const parsed = { outPath: join(root, "docs", "m008-repro-evidence.json") };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      const value = argv[++i];
      if (!value) throw new Error("--out requires a path");
      parsed.outPath = resolve(root, value);
      continue;
    }
    throw new Error(`unknown argument "${arg}"; usage: node scripts/repro-host-interception.mjs [--out <path>]`);
  }
  return parsed;
}

function run(command, args, options, timeoutMs) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      ...options, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const kill = () => {
      try {
        // The OpenCode harness detaches its own children; kill the whole group.
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* group already gone */ }
    };
    const settle = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { stderr += `\n${error.message}`; });
    child.on("close", settle);
  });
}

async function executable(path) {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

async function exists(path) {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

/** Probe `command` on PATH first, then an absolute fallback path (host install dirs). */
async function probeVersion(command, fallbackPath, args = ["--version"]) {
  const attempts = [command];
  if (fallbackPath) attempts.push(fallbackPath);
  let last = null;
  for (const candidate of attempts) {
    if (candidate !== command && !(await executable(candidate))) continue;
    const result = await run(candidate, args, { cwd: root, env: process.env }, PROBE_TIMEOUT);
    last = { candidate, ...result };
    if (result.code === 0) return { found: true, path: candidate, version: result.stdout.trim() || result.stderr.trim() };
  }
  return { found: false, path: null, version: null, detail: last ? `exit=${last.code ?? "spawn-failed"} ${last.stderr.trim().split("\n")[0]}` : "no candidate" };
}

function tail(text) {
  const lines = String(text).split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
  return lines.slice(-LOG_TAIL_LINES).join("\n");
}

/** `intercepted <path> (N lines, confidence C[, chunks=..][, cacheHit=true][, judge=..], Tms)` — N is the file's line count. */
function parseInterceptedLine(text) {
  const match = text.match(/intercepted\s+(\S+)\s+\((\d+)\s+lines,\s+confidence\s+([^,)]+),[^)]*?(\d+)ms\)/);
  if (!match) return undefined;
  return { source: "plugin-log", path: match[1], fileLines: Number(match[2]), confidence: match[3], elapsedMs: Number(match[4]) };
}

function jsonRecords(text) {
  const records = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try { records.push(JSON.parse(trimmed)); } catch { /* not JSON */ }
  }
  return records;
}

/** The OpenCode harness prints one JSON object per scenario plus a summary; merge the fields they report. */
function parseHarnessJson(text) {
  const merged = {};
  for (const record of jsonRecords(text)) {
    if (!record || typeof record !== "object") continue;
    for (const key of ["ok", "linesReturned", "totalLines", "confidence", "elapsedMs", "modelSource", "hostVersion", "fallbackReason", "chunks", "concurrencyPinned", "childModelCall"]) {
      if (merged[key] === undefined && record[key] !== undefined) merged[key] = record[key];
    }
  }
  if (merged.confidence === undefined && merged.ok === undefined) return undefined;
  return {
    source: "opencode-harness-json",
    ok: merged.ok,
    excerptLines: merged.linesReturned,
    fileLines: merged.totalLines,
    confidence: merged.confidence,
    elapsedMs: merged.elapsedMs,
    modelSource: merged.modelSource,
    hostVersion: merged.hostVersion,
    fallbackReason: merged.fallbackReason,
    chunks: merged.chunks,
    concurrencyPinned: merged.concurrencyPinned,
    childModelCall: merged.childModelCall,
  };
}

/**
 * OpenCode metrics come from two sources: the plugin's own `[paradoc] info: intercepted …`
 * stderr line (elapsed ms, confidence, file line count) and the harness's JSON lines (chunk
 * fan-out, modelSource, host version). Merge them so one record carries everything.
 */
function mergeOpenCodeEvidence(fromLog, fromHarness) {
  if (!fromLog && !fromHarness) return undefined;
  if (!fromLog) return fromHarness;
  if (!fromHarness) return fromLog;
  const merged = { ...fromHarness, ...fromLog };
  // Keep harness-only fields the plugin line never reports.
  for (const key of ["chunks", "concurrencyPinned", "modelSource", "hostVersion", "ok"]) {
    if (merged[key] === undefined && fromHarness[key] !== undefined) merged[key] = fromHarness[key];
  }
  return merged;
}

/** Host debug logs carry the condensed result the model actually saw: `showing N of M lines`. */
async function findShowingLines(logDir) {
  let files = [];
  try { files = await readdir(logDir, { recursive: true }); } catch { return undefined; }
  let budget = 5_000_000;
  for (const file of files) {
    if (budget <= 0) break;
    let text = "";
    try { text = await readFile(join(logDir, file), "utf8"); } catch { continue; }
    budget -= text.length;
    const match = text.match(/showing\s+(\d+)\s+of\s+(\d+)\s+lines/);
    if (match) return { excerptLines: Number(match[1]), fileLines: Number(match[2]) };
  }
  return undefined;
}

/**
 * Copilot harness prints `paradoc-log=<path>` and `log-dir=<path>` on PASS (stdout) and on FAIL
 * (stderr, as part of the failure's path block). The plugin's own JSONL carries the interception
 * record or the classified fallback (fallbackReason + detail), which is where the known model
 * rejection is visible — so search combined stdout+stderr, not stdout alone.
 */
async function collectCopilotEvidence(output) {
  const evidence = { source: "copilot-plugin-log" };
  const logPath = output.match(/paradoc-log=(\S+)/g)?.at(-1)?.split("=")[1];
  const logDir = output.match(/log-dir=(\S+)/g)?.at(-1)?.split("=")[1];
  if (logPath) {
    evidence.logPath = logPath;
    try {
      const records = jsonRecords(await readFile(logPath, "utf8"));
      const intercepted = records.filter((r) => typeof r?.message === "string" && r.message.startsWith("intercepted"));
      const fallbacks = records.filter((r) => typeof r?.fallbackReason === "string");
      // Counts are recorded even when there is no interception at all: a pass-through scenario
      // proves the offset-only rule by asserting interceptedCount === 0.
      evidence.recordCount = records.length;
      evidence.interceptedCount = intercepted.length;
      evidence.fallbackCount = fallbacks.length;
      const record = intercepted.at(-1) ?? fallbacks.at(-1);
      if (record) {
        evidence.intercepted = intercepted.length > 0;
        evidence.message = record.message;
        evidence.path = record.filePath;
        evidence.fileLines = record.lineCount;
        evidence.confidence = record.confidence;
        evidence.elapsedMs = record.elapsedMs;
        evidence.tokensSaved = record.estTokensSaved;
        evidence.modelSource = record.modelSource;
        evidence.fallbackReason = record.fallbackReason;
        evidence.detail = record.detail;
      }
    } catch (error) { evidence.logError = error.message; }
  }
  if (logDir) {
    const showing = await findShowingLines(logDir);
    if (showing) {
      evidence.excerptLines = showing.excerptLines;
      evidence.fileLines = evidence.fileLines ?? showing.fileLines;
    }
  }
  return Object.keys(evidence).length > 1 ? evidence : undefined;
}

function classify(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  if (/^\s*SKIP\b/m.test(text)) return "SKIP";
  if (result.timedOut) return "FAIL";
  return result.code === 0 ? "PASS" : "FAIL";
}

async function readGlobalParadocModel() {
  const path = join(homedir(), ".config", "paradoc", "config.json");
  try {
    const config = JSON.parse(await readFile(path, "utf8"));
    const model = config?.model;
    if (model?.modelID) return `${model.providerID ? `${model.providerID}/` : ""}${model.modelID}`;
  } catch { /* no global config */ }
  return null;
}

async function collectPackage() {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const tags = (await run("git", ["tag", "--list", "v*"], { cwd: root, env: process.env }, PROBE_TIMEOUT))
    .stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const npmProbe = await run("npm", ["view", pkg.name, "version"], { cwd: root, env: process.env }, 90_000);
  const published = npmProbe.code === 0 ? npmProbe.stdout.trim() : null;
  return {
    name: pkg.name,
    checkout: pkg.version,
    published,
    publishedError: published ? undefined : `npm view failed: ${(npmProbe.stderr || npmProbe.stdout).trim().split("\n")[0] || `exit ${npmProbe.code}`}`,
    tags,
  };
}

async function collectBranch(packageInfo) {
  const git = async (args) => run("git", args, { cwd: root, env: process.env }, PROBE_TIMEOUT);
  const head = await git(["rev-parse", "HEAD"]);
  const branch = await git(["branch", "--show-current"]);
  const tagBranches = {};
  for (const tag of packageInfo.tags) {
    const contains = await git(["branch", "--all", "--contains", tag]);
    tagBranches[tag] = contains.stdout.split("\n").map((l) => l.trim().replace(/^[*+]\s*/, "")).filter(Boolean);
  }
  const publishedTag = packageInfo.published ? `v${packageInfo.published}` : null;
  const diff = publishedTag ? await git(["diff", "--stat", "HEAD", publishedTag]) : { code: 1, stdout: "", stderr: "no published version" };
  const files = diff.stdout.split("\n").map((l) => l.trim()).filter((l) => l.includes("|"));
  const summary = diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  return {
    headCommit: head.stdout.trim(),
    headBranch: branch.stdout.trim(),
    checkoutVersion: packageInfo.checkout,
    publishedVersion: packageInfo.published,
    publishedTag,
    tags: packageInfo.tags,
    tagBranches,
    diffStatVsPublishedTag: diff.code === 0 ? { summary, files } : { error: diff.stderr.trim() || `git diff exit ${diff.code}` },
  };
}

async function collectPriorEvidence() {
  const candidates = ["/tmp/oc-e2e3.log", "/tmp/cp-e2e2.log"];
  const found = [];
  for (const path of candidates) {
    if (await exists(path)) found.push({ path, note: "research-slice reference only; not this run's evidence" });
  }
  return found;
}

async function executeRun(definition) {
  const env = { ...process.env, ...definition.env };
  for (const key of definition.deleteEnv ?? []) delete env[key];
  const started = Date.now();
  const result = await run(process.execPath, [join(root, definition.script), "--scenario", definition.harnessScenario ?? definition.scenario], {
    cwd: root, env,
  }, RUN_TIMEOUT);
  const combined = `${result.stdout}${result.stderr}`;
  const status = classify(result);
  // Copilot metrics come from the plugin's own JSONL (the harness only prints paths), so they are
  // collected on FAIL too — that is where a classified fallback and its reason are visible.
  const interception = definition.host === "copilot"
    ? await collectCopilotEvidence(combined)
    : mergeOpenCodeEvidence(parseInterceptedLine(combined), parseHarnessJson(combined));
  const entry = {
    host: definition.host,
    scenario: definition.scenario,
    model: definition.model ?? null,
    status,
    exitCode: result.code ?? null,
    signal: result.signal ?? null,
    timedOut: result.timedOut,
    wallMs: Date.now() - started,
    harness: definition.script,
  };
  if (interception) entry.interception = interception;
  if (status === "FAIL") {
    const reason = interception?.detail ?? interception?.message
      ?? result.stderr.trim().split("\n").filter(Boolean).at(-1);
    if (reason) entry.reason = String(reason).trim();
  }
  if (definition.expectedFailure) {
    entry.expectedFailure = true;
    entry.expectedFailureSignature = definition.expectedFailureSignature;
    const searchable = `${combined}\n${interception ? JSON.stringify(interception) : ""}`;
    entry.expectedFailureMatched = status === "FAIL" && new RegExp(definition.expectedFailureSignature, "i").test(searchable);
  }
  entry.logTail = tail(combined);
  return entry;
}

function summarize(entry) {
  const bits = [`${entry.status} ${entry.host} ${entry.scenario}`, `model=${entry.model ?? "host-default"}`];
  const interception = entry.interception;
  if (interception && (interception.excerptLines !== undefined || interception.fileLines !== undefined)) {
    bits.push(interception.excerptLines !== undefined
      ? `intercepted=${interception.excerptLines}/${interception.fileLines ?? "?"} lines`
      : `intercepted=file=${interception.fileLines} lines`);
  }
  if (interception?.confidence !== undefined) bits.push(`confidence=${interception.confidence}`);
  if (interception?.elapsedMs !== undefined) bits.push(`${Math.round(interception.elapsedMs)}ms`);
  if (interception?.fallbackReason) bits.push(`fallback=${interception.fallbackReason}`);
  if (interception?.interceptedCount !== undefined) bits.push(`interceptedCount=${interception.interceptedCount}`);
  if (interception?.chunks !== undefined) bits.push(`chunks=${interception.chunks}`);
  if (interception?.modelSource) bits.push(`modelSource=${interception.modelSource}`);
  if (entry.expectedFailure) bits.push(`known-failure${entry.expectedFailureMatched ? " (matched)" : " (signature NOT matched)"}`);
  bits.push(`wall=${entry.wallMs}ms`);
  if (entry.timedOut) bits.push("TIMED-OUT");
  return bits.join(" ");
}

async function main() {
  const { outPath } = parseArgs(process.argv.slice(2));

  const distChecks = [
    join(root, "dist", "opencode", "plugin-v2.js"),
    join(root, "dist", "copilot-cli", "extension-entry.js"),
  ];
  const absent = [];
  for (const path of distChecks) if (!(await exists(path))) absent.push(path);
  if (absent.length) throw new Error(`missing build output: ${absent.join(", ")} — run npm run build`);

  const [opencode, copilot] = await Promise.all([
    probeVersion("opencode", join(homedir(), ".opencode", "bin", "opencode")),
    probeVersion("copilot", join(homedir(), ".local", "bin", "copilot")),
  ]);
  const packageInfo = await collectPackage();
  const branch = await collectBranch(packageInfo);
  const globalCopilotModel = await readGlobalParadocModel();

  const definitions = [
    {
      host: "opencode", scenario: "happy", script: "scripts/e2e-opencode.mjs", model: OPENCODE_MODEL,
      env: { E2E_AGENT_MODEL: OPENCODE_MODEL, E2E_SUBAGENT_MODEL: OPENCODE_SUBAGENT_MODEL },
    },
    {
      host: "opencode", scenario: "large", script: "scripts/e2e-opencode.mjs", model: OPENCODE_MODEL,
      env: { E2E_AGENT_MODEL: OPENCODE_MODEL, E2E_SUBAGENT_MODEL: OPENCODE_SUBAGENT_MODEL },
    },
    {
      host: "copilot", scenario: "happy", script: "scripts/e2e-copilot.mjs", model: COPILOT_MODEL,
      env: { PARADOC_MODEL: COPILOT_MODEL },
    },
    {
      host: "copilot", scenario: "pass-through", script: "scripts/e2e-copilot.mjs", model: COPILOT_MODEL,
      env: { PARADOC_MODEL: COPILOT_MODEL },
    },
    {
      // No PARADOC_MODEL override: the global default model must be aliased by
      // COPILOT_MODEL_ALIASES (v0.2.2, merged from milestone/M007) and intercepted.
      // The harness scenario is the ordinary happy read; only the model override differs.
      host: "copilot", scenario: "default-model", harnessScenario: "happy", script: "scripts/e2e-copilot.mjs",
      model: globalCopilotModel ?? "global default",
      env: {}, deleteEnv: ["PARADOC_MODEL"],
    },
  ];

  const runs = [];
  for (const definition of definitions) {
    if (definition.host === "opencode" && !opencode.found) {
      runs.push({
        host: definition.host, scenario: definition.scenario, model: definition.model, status: "SKIP",
        reason: `opencode binary not found (${opencode.detail})`, harness: definition.script, logTail: "",
      });
      continue;
    }
    if (definition.host === "copilot" && !copilot.found) {
      runs.push({
        host: definition.host, scenario: definition.scenario, model: definition.model, status: "SKIP",
        reason: `copilot binary not found (${copilot.detail})`, harness: definition.script, logTail: "",
      });
      continue;
    }
    const entry = await executeRun(definition);
    runs.push(entry);
    console.log(summarize(entry));
  }

  const evidence = {
    generatedAt: new Date().toISOString(),
    hosts: {
      opencode: opencode.found ? opencode.version : null,
      opencodePath: opencode.path,
      copilot: copilot.found ? copilot.version : null,
      copilotPath: copilot.path,
      node: process.version,
    },
    package: packageInfo,
    branch,
    priorEvidence: await collectPriorEvidence(),
    runs,
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`evidence=${outPath}`);

  const hardFailure = runs.some((r) => r.status === "FAIL" && r.expectedFailure !== true);
  const knownFailurePassed = runs.some((r) => r.status === "PASS" && r.expectedFailure === true);
  if (knownFailurePassed) console.log("NOTE expected-failure run PASSED — the known host failure may have been fixed");
  if (hardFailure) process.exitCode = 1;
}

main().catch((error) => { console.error(`FAIL host-interception repro: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
