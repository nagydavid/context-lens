#!/usr/bin/env node
// Fresh-install acceptance harness (M008 S03): install a packed (or registry) ParaDoc artifact into
// isolated homes, prove the INSTALLED registration is the interception shape the M008 contract
// requires, and — with the live gate — run the real hosts against the installed runtime through
// PARADOC_E2E_DIST instead of the checkout build.
//
// Structural pre-flight runs first and names the failed check, so a broken install never spends
// model quota on a host run that structurally could not have intercepted.
//
// Isolation: the installer runs with HOME / XDG_DATA_HOME / XDG_CONFIG_HOME pointed at throwaway
// dirs, so the real ~/.config/opencode and ~/.copilot are never written. Live host runs keep the
// real XDG_DATA_HOME / HOME because that is where provider authentication lives.
//
// Usage:
//   PARADOC_E2E=1 node scripts/accept-fresh-install.mjs [--source <tarball|npm-spec>] [--out <path>] [--skip-live]
// Default source: `npm pack` of this worktree. Default --out: docs/m008-fresh-install-evidence.json.
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

// Gate first — must precede argument parsing, packing, and every host probe.
if (process.env.PARADOC_E2E !== "1") {
  console.log("SKIP fresh-install acceptance (set PARADOC_E2E=1)");
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");
const PROBE_TIMEOUT = 30_000;
const PACK_TIMEOUT = 180_000;
const INSTALL_TIMEOUT = 240_000;
const RUN_TIMEOUT = Number(process.env.PARADOC_ACCEPT_RUN_TIMEOUT_MS || 600_000);
const LOG_TAIL_LINES = 40;
const OPENCODE_MODEL = process.env.E2E_AGENT_MODEL || "openai/gpt-5.6-terra";
const COPILOT_MODEL = process.env.PARADOC_MODEL || "github/claude-haiku-4.5";
// The published release before the plugin-directory rule landed: the negative control for the
// silent no-interception shape (singular `plugin` key, flat shim, no `tool.transform`).
const LEGACY_SPEC = process.env.PARADOC_LEGACY_SPEC || "@davidnagy/paradoc@0.2.2";

function parseArgs(argv) {
  const parsed = { outPath: join(root, "docs", "m008-fresh-install-evidence.json"), source: null, skipLive: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      const value = argv[++i];
      if (!value) throw new Error("--out requires a path");
      parsed.outPath = resolve(root, value);
      continue;
    }
    if (arg === "--source") {
      const value = argv[++i];
      if (!value) throw new Error("--source requires a .tgz path or an npm spec");
      parsed.source = value.endsWith(".tgz")
        ? { kind: "local tarball", spec: value, tarball: resolve(root, value) }
        : { kind: "registry", spec: value };
      continue;
    }
    if (arg === "--skip-live") {
      parsed.skipLive = true;
      continue;
    }
    throw new Error(`unknown argument "${arg}"; usage: node scripts/accept-fresh-install.mjs [--source <tarball|npm-spec>] [--out <path>] [--skip-live]`);
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

async function exists(path) {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

async function executable(path) {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

async function readText(path) {
  return readFile(path, "utf8");
}

async function readJson(path) {
  return JSON.parse(await readText(path));
}

function tail(text) {
  const lines = String(text).split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
  return lines.slice(-LOG_TAIL_LINES).join("\n");
}

function lastLines(text, count) {
  return String(text).split("\n").map((line) => line.trim()).filter(Boolean).slice(-count).join(" | ");
}

async function digest(path, algorithm) {
  const buffer = await readFile(path);
  return createHash(algorithm).update(buffer).digest("base64");
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

async function collectBranch() {
  const git = async (args) => run("git", args, { cwd: root, env: process.env }, PROBE_TIMEOUT);
  const head = await git(["rev-parse", "HEAD"]);
  const branch = await git(["branch", "--show-current"]);
  const status = await git(["status", "--porcelain"]);
  const dirty = status.stdout.trim().length > 0;
  return { headCommit: head.stdout.trim(), headBranch: branch.stdout.trim(), dirty };
}

/**
 * The config a real user has when ParaDoc is installed: a shared plural `plugins` array holding
 * other packages with a trailing comma, plus the legacy singular `plugin` entry pointing at the old
 * flat `plugins/paradoc.js` shim (which also exists on disk). The installer must upgrade this to
 * the plugin-directory shape and delete its own stale shim.
 */
function seededConfig(configDir, includeLegacyEntry = true) {
  const flatShim = join(configDir, "plugins", "paradoc.js");
  const legacyEntry = includeLegacyEntry
    ? `  "plugin": [${JSON.stringify(pathToFileURL(flatShim).href)}],\n`
    : "";
  const text = `{
  "$schema": "https://opencode.ai/config.json",
  // shared plugins array: other packages, trailing comma before the closing bracket
  "plugins": [
    "billion-context",
    "@openchamber/opencode-claude",
  ],
${legacyEntry}  "mcp": {
    "servers": {
      "other": { "type": "remote", "url": "https://example.invalid/mcp" },
    }
  },
}
`;
  return { text, flatShim };
}

/**
 * Seed a throwaway home the way a real user's looks before ParaDoc is installed.
 * `configDir` must match where the installer will actually look: the fresh install redirects
 * XDG_CONFIG_HOME at `<home>/config`, while the HOME-only legacy control falls back to `<home>/.config`.
 */
async function seedHome(home, { copilotSettings, includeLegacyEntry = true, configDir = join(home, "config", "opencode") }) {
  const config = seededConfig(configDir, includeLegacyEntry);
  await mkdir(join(configDir, "plugins"), { recursive: true });
  await writeFile(join(configDir, "opencode.jsonc"), config.text, "utf8");
  // The pre-directory-rule flat shim: ParaDoc's own stale file, which the installer must remove.
  // The legacy negative control seeds WITHOUT it, so the flat shim can only appear if 0.2.2 wrote it.
  if (includeLegacyEntry) {
    await writeFile(config.flatShim, 'export { ParaDocV2Plugin as default } from "file:///stale-paradoc-shim.js";\n', "utf8");
  }
  await mkdir(join(home, ".copilot"), { recursive: true });
  await writeFile(join(home, ".copilot", "settings.json"), copilotSettings, "utf8");
  return { configDir, flatShim: config.flatShim, configPath: join(configDir, "opencode.jsonc") };
}

async function packWorktree(tmp) {
  const result = await run("npm", ["pack", "--pack-destination", tmp], { cwd: root, env: process.env }, PACK_TIMEOUT);
  if (result.code !== 0) throw new Error(`npm pack failed (${result.code}): ${lastLines(result.stderr, 4)}`);
  const filename = String(result.stdout).trim().split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  const tarball = join(tmp, filename);
  if (!(await exists(tarball))) throw new Error(`npm pack did not produce ${tarball}`);
  return { kind: "local tarball", spec: filename, tarball };
}

/** Install the artifact into a throwaway prefix and return the package root inside node_modules. */
async function installPackage(tmp, source) {
  const pkgDir = join(tmp, "pkg");
  await mkdir(pkgDir, { recursive: true });
  const target = source.kind === "local tarball" ? source.tarball : source.spec;
  const result = await run("npm", ["install", "--no-audit", "--no-fund", target], { cwd: pkgDir, env: process.env }, INSTALL_TIMEOUT);
  if (result.code !== 0) throw new Error(`npm install ${target} failed (${result.code}): ${lastLines(result.stderr, 4)}`);
  const pkgRoot = join(pkgDir, "node_modules", "@davidnagy", "paradoc");
  if (!(await exists(join(pkgRoot, "dist", "cli", "main.js")))) {
    throw new Error(`installed package has no dist/cli/main.js under ${pkgRoot}`);
  }
  return pkgRoot;
}

/** Run the installed CLI's installer against the isolated home; returns its reported lines. */
async function runInstalledInstaller(pkgRoot, home) {
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config") };
  delete env.PARADOC_CHILD;
  const result = await run(process.execPath, [join(pkgRoot, "dist", "cli", "main.js"), "install", "all"], { cwd: home, env }, INSTALL_TIMEOUT);
  if (result.code !== 0) throw new Error(`installed paradoc install all failed (${result.code}): ${lastLines(result.stderr, 4)}`);
  return String(result.stdout).split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * Structural pre-flight: every check is named, so a failure says which guarantee the installed
 * artifact is missing before any quota-consuming host run happens.
 */
async function structuralChecks({ runtime, seeded, repoVersion }) {
  const pluginV2 = join(runtime, "dist", "opencode", "plugin-v2.js");
  const extensionEntry = join(runtime, "dist", "copilot-cli", "extension-entry.js");
  const pluginIndex = join(seeded.configDir, "plugins", "paradoc", "index.js");
  const copilotShim = join(seeded.home, ".copilot", "extensions", "paradoc", "extension.mjs");
  const settingsPath = join(seeded.home, ".copilot", "settings.json");
  const runtimeRootUrl = pathToFileURL(runtime).href;
  const pluginDirUrl = pathToFileURL(join(seeded.configDir, "plugins", "paradoc")).href;

  const checks = [];
  const add = async (name, fn) => {
    let ok = false;
    let detail = "";
    try {
      const outcome = await fn();
      ok = outcome === true;
      if (!ok) detail = typeof outcome === "string" ? outcome : "check returned false";
    } catch (error) {
      ok = false;
      detail = error instanceof Error ? error.message : String(error);
    }
    checks.push({ name, ok, detail });
  };

  await add("installed-runtime-version-matches-repo", async () => {
    const stamp = await readJson(join(runtime, "package.json"));
    return stamp.version === repoVersion || `runtime package.json version ${JSON.stringify(stamp.version)} != repo ${repoVersion}`;
  });
  await add("installed-plugin-v2-registers-tool-transform", async () => {
    const text = await readText(pluginV2);
    return text.includes("tool.transform") || `no "tool.transform" in ${pluginV2}`;
  });
  await add("installed-plugin-v2-uses-generate-text", async () => {
    const text = await readText(pluginV2);
    return text.includes("generate.text") || `no "generate.text" in ${pluginV2}`;
  });
  await add("installed-extension-entry-registers-on-post-tool-use", async () => {
    const text = await readText(extensionEntry);
    return text.includes("onPostToolUse") || `no "onPostToolUse" in ${extensionEntry}`;
  });
  await add("opencode-plugin-index-re-exports-installed-runtime", async () => {
    const text = await readText(pluginIndex);
    const url = /from\s+"(file:\/\/[^"]+)"/.exec(text)?.[1] ?? "";
    return url.startsWith(runtimeRootUrl) || `index.js re-exports ${url || "nothing"}, outside ${runtimeRootUrl}`;
  });
  await add("opencode-config-registers-plural-plugins-directory", async () => {
    const config = await readText(seeded.configPath);
    const plural = /"plugins"\s*:\s*\[([\s\S]*?)\]/.exec(config)?.[1] ?? "";
    return plural.includes(pluginDirUrl) || `no plural "plugins" entry for ${pluginDirUrl}`;
  });
  await add("opencode-config-has-no-singular-plugin-key", async () => {
    const config = await readText(seeded.configPath);
    // `"plugins":` never matches: `plugin` is followed by `s` before the closing quote.
    return !/"plugin"\s*:/.test(config) || `legacy singular "plugin" key survived in ${seeded.configPath}`;
  });
  await add("opencode-config-keeps-other-plugins-and-jsonc-comments", async () => {
    const config = await readText(seeded.configPath);
    return (config.includes("billion-context") && config.includes("@openchamber/opencode-claude") && config.includes("// shared plugins array"))
      || `a pre-existing plugin or the JSONC comment was rewritten`;
  });
  await add("opencode-flat-paradoc-shim-removed", async () => {
    return !(await exists(seeded.flatShim)) || `stale flat shim still present: ${seeded.flatShim}`;
  });
  await add("copilot-extension-shim-points-at-installed-runtime", async () => {
    const text = await readText(copilotShim);
    const entryUrl = pathToFileURL(join(runtime, "dist", "copilot-cli", "extension-entry.js")).href;
    return text.includes(entryUrl) || `extension.mjs does not import ${entryUrl}`;
  });
  await add("copilot-settings-enable-experimental", async () => {
    const settings = await readJson(settingsPath);
    return settings.experimental === true || `experimental is ${JSON.stringify(settings.experimental)}, expected true`;
  });
  await add("copilot-settings-preserve-unrelated-keys", async () => {
    const settings = await readJson(settingsPath);
    return settings.seedMarker === "keep-me" || `seedMarker was dropped: ${JSON.stringify(settings)}`;
  });

  return checks;
}

/**
 * The installed installer must never overwrite a user's explicit `experimental: false`, and must say
 * so: a silently dead Copilot hook is the launchability hole the M008 contract names.
 */
async function experimentalFalseProbe(tmp, pkgRoot) {
  const home = join(tmp, "warn-home");
  const settingsPath = join(home, ".copilot", "settings.json");
  await mkdir(join(home, ".copilot"), { recursive: true });
  await writeFile(settingsPath, '{\n  "experimental": false,\n  "seedMarker": "keep-me"\n}\n', "utf8");
  const before = await readText(settingsPath);
  const lines = await runInstalledInstaller(pkgRoot, home);
  const after = await readText(settingsPath);
  return {
    settingsPath,
    lines,
    unchanged: before === after,
    warningLine: lines.find((line) => line.includes("experimental is false in")) ?? null,
    experimentalStillFalse: (await readJson(settingsPath)).experimental === false,
    seedMarkerKept: (await readJson(settingsPath)).seedMarker === "keep-me",
  };
}

/**
 * Negative control: the published 0.2.2 installer must still produce the legacy shape, proving the
 * fresh-install checks detect a real difference rather than restating the same layout.
 */
async function legacyControl(tmp) {
  const home = join(tmp, "legacy-home");
  // Seeded with NO singular `plugin` key and NO flat shim: anything legacy-shaped in the result can
  // only have been produced by the 0.2.2 installer itself.
  const seeded = await seedHome(home, {
    copilotSettings: '{ "seedMarker": "keep-me" }\n',
    includeLegacyEntry: false,
    // HOME-only override: the installer resolves its config dir from `<home>/.config`.
    configDir: join(home, ".config", "opencode"),
  });
  seeded.home = home;
  // cwd must be OUTSIDE the worktree: the worktree's own package.json declares a `paradoc` bin,
  // which shadows the npx-installed one and yields `paradoc: not found` (exit 127).
  const cwd = join(tmp, "legacy-cwd");
  await mkdir(cwd, { recursive: true });
  const result = await run("npx", ["-y", "--package", LEGACY_SPEC, "paradoc", "install", "all"], {
    cwd, env: { ...process.env, HOME: home },
  }, INSTALL_TIMEOUT);
  if (result.code !== 0) {
    const reason = lastLines(`${result.stderr}\n${result.stdout}`, 3) || `exit ${result.code}`;
    return { spec: LEGACY_SPEC, status: "SKIP", reason, note: "legacy install unavailable (offline or registry unreachable); negative control not run" };
  }
  const runtime = join(home, ".local", "share", "paradoc");
  const config = await readText(seeded.configPath);
  const pluginV2 = join(runtime, "dist", "opencode", "plugin-v2.js");
  const pluginV2Text = await exists(pluginV2) ? await readText(pluginV2) : "";
  const stamp = await exists(join(runtime, "package.json")) ? await readJson(join(runtime, "package.json")) : {};
  const checks = {
    singularPluginKey: /"plugin"\s*:\s*\[/.test(config),
    flatShimPresent: await exists(seeded.flatShim),
    noPluralPluginsEntryForParadoc: !/"plugins"\s*:\s*\[[^\]]*paradoc/i.test(config),
    noToolTransform: pluginV2Text.length > 0 && !pluginV2Text.includes("tool.transform"),
    noVersionStamp: stamp.version === undefined,
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return {
    spec: LEGACY_SPEC,
    status: failed.length ? "FAIL" : "PASS",
    checks,
    home,
    seededFrom: seeded.configPath,
    ...(failed.length ? { reason: `legacy shape missing: ${failed.join(", ")}` } : {}),
  };
}

function jsonRecords(text) {
  const records = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try { records.push(JSON.parse(trimmed)); } catch { /* not a JSON record */ }
  }
  return records;
}

/** The OpenCode harness prints one JSON record per scenario; merge the fields it reports. */
function parseOpenCodeHarness(text) {
  const merged = {};
  for (const key of ["ok", "linesReturned", "totalLines", "confidence", "elapsedMs", "modelSource", "hostVersion", "chunks", "concurrencyPinned", "childModelCall"]) {
    for (const record of jsonRecords(text)) {
      if (merged[key] === undefined && record?.[key] !== undefined) merged[key] = record[key];
    }
  }
  return merged;
}

/** `[paradoc] info: intercepted <path> (N lines, confidence C[, chunks=M][, cacheHit=true], Tms)` from the E2E_DUMP transcript. */
function parseOpenCodeDump(text) {
  const lines = String(text).split("\n");
  const intercepted = lines.filter((line) => /^\[paradoc\] info: intercepted /.test(line));
  const fallbacks = lines.filter((line) => /^\[paradoc\] warn: fallback /.test(line));
  const metrics = { interceptedCount: intercepted.length, fallbackCount: fallbacks.length };
  const record = intercepted[0];
  if (record) {
    metrics.fileLines = Number(/(\d+) lines,/.exec(record)?.[1]);
    metrics.confidence = Number(/confidence (\d)/.exec(record)?.[1]);
    metrics.elapsedMs = Number(/(\d+)ms\)/.exec(record)?.[1]);
    const chunks = Number(/chunks=(\d+)/.exec(record)?.[1]);
    if (Number.isFinite(chunks)) metrics.chunks = chunks;
  }
  const fallback = fallbacks[0];
  if (fallback) metrics.fallbackReason = /fallback (\S+) for/.exec(fallback)?.[1];
  return metrics;
}

/** Host debug logs carry what the model actually saw: `showing N of M lines`. */
async function findShowingLines(logDir) {
  let files = [];
  try { files = await readdir(logDir, { recursive: true }); } catch { return undefined; }
  for (const file of files) {
    let text = "";
    try { text = await readFile(join(logDir, file), "utf8"); } catch { continue; }
    const match = text.match(/showing\s+(\d+)\s+of\s+(\d+)\s+lines/);
    if (match) return { excerptLines: Number(match[1]), fileLines: Number(match[2]) };
  }
  return undefined;
}

/** The Copilot harness prints `paradoc-log=` / `log-dir=` on PASS and FAIL; the plugin JSONL is authoritative. */
async function collectCopilotMetrics(output) {
  const metrics = {};
  const logPath = output.match(/paradoc-log=(\S+)/g)?.at(-1)?.split("=")[1];
  const logDir = output.match(/log-dir=(\S+)/g)?.at(-1)?.split("=")[1];
  if (logPath && await exists(logPath)) {
    const records = jsonRecords(await readText(logPath));
    const intercepted = records.filter((r) => typeof r?.message === "string" && r.message.startsWith("intercepted"));
    const fallbacks = records.filter((r) => typeof r?.fallbackReason === "string");
    metrics.recordCount = records.length;
    metrics.interceptedCount = intercepted.length;
    metrics.fallbackCount = fallbacks.length;
    const record = intercepted.at(-1) ?? fallbacks.at(-1);
    if (record) {
      metrics.fileLines = record.lineCount;
      metrics.confidence = record.confidence;
      metrics.elapsedMs = record.elapsedMs;
      metrics.tokensSaved = record.estTokensSaved;
      metrics.modelSource = record.modelSource;
      metrics.fallbackReason = record.fallbackReason;
      const chunks = Number(/chunks=(\d+)/.exec(record.message ?? "")?.[1]);
      if (Number.isFinite(chunks)) metrics.chunks = chunks;
    }
  }
  if (logDir) {
    const showing = await findShowingLines(logDir);
    if (showing) {
      metrics.excerptLines = showing.excerptLines;
      metrics.fileLines = metrics.fileLines ?? showing.fileLines;
    }
  }
  if (/concurrencyPinned=true/.test(output)) metrics.concurrencyPinned = true;
  return metrics;
}

function classify(result) {
  if (result.timedOut) return "FAIL";
  return result.code === 0 ? "PASS" : "FAIL";
}

function summarize(runEntry) {
  const bits = [`${runEntry.status} ${runEntry.host} ${runEntry.scenario}`, `model=${runEntry.model ?? "host-default"}`];
  for (const [key, label] of [
    ["excerptLines", "excerpt"], ["fileLines", "file"], ["confidence", "confidence"], ["elapsedMs", "ms"],
    ["chunks", "chunks"], ["interceptedCount", "interceptedCount"], ["fallbackCount", "fallbackCount"],
    ["tokensSaved", "tokensSaved"], ["modelSource", "modelSource"], ["childModelCall", "childModelCall"],
  ]) {
    if (runEntry[key] !== undefined) bits.push(`${label}=${runEntry[key]}`);
  }
  if (runEntry.concurrencyPinned) bits.push("concurrencyPinned=true");
  if (runEntry.fallbackReason) bits.push(`fallback=${runEntry.fallbackReason}`);
  bits.push(`wall=${runEntry.wallMs}ms`);
  if (runEntry.timedOut) bits.push("TIMED-OUT");
  return bits.join(" ");
}

async function executeLiveRun(definition, context) {
  const env = {
    ...process.env,
    PARADOC_E2E: "1",
    // The installed runtime root (`<XDG_DATA_HOME>/paradoc`, which contains `dist/`): the harnesses
    // load their plugin / extension entry from here instead of the checkout build.
    PARADOC_E2E_DIST: context.runtime,
  };
  if (definition.host === "opencode") {
    env.E2E_AGENT_MODEL = OPENCODE_MODEL;
    env.E2E_SUBAGENT_MODEL = OPENCODE_MODEL;
    // The installed registration lives here; the harness still isolates its own per-attempt config
    // home, so the real ~/.config/opencode is never read or written.
    env.XDG_CONFIG_HOME = context.configHome;
    env.E2E_DUMP = join(context.logDir, `opencode-${definition.scenario}.log`);
  } else {
    env.PARADOC_MODEL = COPILOT_MODEL;
  }
  const started = Date.now();
  const result = await run(process.execPath, [join(root, definition.script), "--scenario", definition.scenario], { cwd: root, env }, RUN_TIMEOUT);
  const combined = `${result.stdout}${result.stderr}`;
  const entry = {
    host: definition.host,
    scenario: definition.scenario,
    model: definition.host === "opencode" ? OPENCODE_MODEL : COPILOT_MODEL,
    status: classify(result),
    exitCode: result.code ?? null,
    signal: result.signal ?? null,
    timedOut: result.timedOut,
    wallMs: Date.now() - started,
    harness: definition.script,
    runtimeSource: context.sourceKind,
  };
  Object.assign(entry, definition.host === "opencode"
    ? { ...parseOpenCodeHarness(combined), ...parseOpenCodeDump(await exists(env.E2E_DUMP) ? await readText(env.E2E_DUMP) : "") }
    : await collectCopilotMetrics(combined));
  if (entry.status === "FAIL") {
    entry.reason = entry.fallbackReason
      ?? String(combined).split("\n").map((l) => l.trim()).filter(Boolean).at(-1)
      ?? `exit ${result.code}`;
  }
  entry.logTail = tail(combined);
  return entry;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tmp = await mkdtemp(join(tmpdir(), "paradoc-fresh-"));
  const logDir = join(tmp, "logs");
  await mkdir(logDir, { recursive: true });

  const repoVersion = (await readJson(join(root, "package.json"))).version;
  const source = options.source ?? await packWorktree(tmp);
  if (source.kind === "local tarball" && !(await exists(source.tarball))) {
    throw new Error(`source tarball not found: ${source.tarball}`);
  }
  const sourceInfo = {
    kind: source.kind,
    spec: source.spec,
    ...(source.tarball ? { tarball: source.tarball } : {}),
  };
  if (source.tarball) {
    sourceInfo.sha256 = await digest(source.tarball, "sha256");
    sourceInfo.integrity = `sha512-${await digest(source.tarball, "sha512")}`;
  }

  const pkgRoot = await installPackage(tmp, source);
  const home = join(tmp, "home");
  const seeded = await seedHome(home, { copilotSettings: '{ "seedMarker": "keep-me" }\n' });
  seeded.home = home;
  const installOutput = await runInstalledInstaller(pkgRoot, home);
  const runtime = join(home, "data", "paradoc");
  const installedVersion = (await readJson(join(runtime, "package.json"))).version ?? null;

  const [opencode, copilot] = await Promise.all([
    probeVersion("opencode", join(homedir(), ".opencode", "bin", "opencode")),
    probeVersion("copilot", join(homedir(), ".local", "bin", "copilot")),
  ]);

  const checks = await structuralChecks({ runtime, seeded, repoVersion });
  const warn = await experimentalFalseProbe(tmp, pkgRoot);
  checks.push(
    { name: "copilot-experimental-false-left-unchanged", ok: warn.unchanged && warn.experimentalStillFalse, detail: warn.unchanged ? "" : `installer rewrote ${warn.settingsPath}` },
    { name: "copilot-experimental-false-warning-line", ok: warn.warningLine !== null, detail: `no "experimental is false" warning in: ${warn.lines.join(" | ")}` },
    { name: "copilot-experimental-false-preserves-other-settings", ok: warn.seedMarkerKept, detail: `unrelated setting dropped from ${warn.settingsPath}` },
  );
  const structural = Object.fromEntries(checks.map(({ name, ok }) => [name, ok]));
  const failedChecks = checks.filter((check) => !check.ok);

  const legacy = await legacyControl(tmp);

  const evidence = {
    generatedAt: new Date().toISOString(),
    source: sourceInfo,
    installedVersion,
    repoVersion,
    branch: await collectBranch(),
    hosts: {
      opencode: opencode.found ? opencode.version : null,
      opencodePath: opencode.path,
      copilot: copilot.found ? copilot.version : null,
      copilotPath: copilot.path,
      node: process.version,
    },
    isolation: {
      tmp,
      home,
      runtime,
      configHome: seeded.configDir,
      note: "installer ran with HOME/XDG_DATA_HOME/XDG_CONFIG_HOME redirected here; live host runs keep the real HOME/XDG_DATA_HOME for provider auth and never write the real host config dirs",
    },
    installOutput,
    experimentalFalseProbe: warn,
    structural,
    structuralDetails: Object.fromEntries(checks.map(({ name, ok, detail }) => [name, ok ? "ok" : detail])),
    legacyControl: legacy,
    runs: [],
  };

  const writeEvidence = async () => {
    await mkdir(dirname(options.outPath), { recursive: true });
    await writeFile(options.outPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(`evidence=${options.outPath}`);
  };

  console.log(`source=${source.kind} ${source.spec}${sourceInfo.sha256 ? ` sha256=${sourceInfo.sha256.slice(0, 16)}...` : ""}`);
  console.log(`installedVersion=${installedVersion} repoVersion=${repoVersion}`);
  for (const check of checks) console.log(`${check.ok ? "OK  " : "FAIL"} structural ${check.name}${check.ok ? "" : `: ${check.detail}`}`);
  console.log(`legacy control ${legacy.spec}: ${legacy.status}${legacy.reason ? ` (${legacy.reason})` : ""}`);

  if (failedChecks.length) {
    // Name the failed pre-flight checks and stop: no host run can intercept, so no quota is spent.
    console.error(`FAIL structural pre-flight: ${failedChecks.map((c) => `${c.name}: ${c.detail}`).join("; ")}`);
    await writeEvidence();
    process.exit(1);
  }
  if (legacy.status === "FAIL") {
    console.error(`FAIL legacy control ${legacy.spec}: ${legacy.reason}`);
    await writeEvidence();
    process.exit(1);
  }

  if (options.skipLive) {
    console.log("SKIP live host runs (--skip-live)");
    await writeEvidence();
    return;
  }

  const definitions = [
    { host: "opencode", scenario: "large", script: "scripts/e2e-opencode.mjs" },
    { host: "opencode", scenario: "happy", script: "scripts/e2e-opencode.mjs" },
    { host: "copilot", scenario: "large", script: "scripts/e2e-copilot.mjs" },
    { host: "copilot", scenario: "pass-through", script: "scripts/e2e-copilot.mjs" },
  ];
  const context = { runtime, configHome: seeded.configDir, logDir, sourceKind: source.kind };
  for (const definition of definitions) {
    if (definition.host === "opencode" && !opencode.found) {
      evidence.runs.push({ host: definition.host, scenario: definition.scenario, status: "SKIP", reason: `opencode binary not found (${opencode.detail})`, harness: definition.script });
      continue;
    }
    if (definition.host === "copilot" && !copilot.found) {
      evidence.runs.push({ host: definition.host, scenario: definition.scenario, status: "SKIP", reason: `copilot binary not found (${copilot.detail})`, harness: definition.script });
      continue;
    }
    const entry = await executeLiveRun(definition, context);
    evidence.runs.push(entry);
    console.log(summarize(entry));
  }

  await writeEvidence();
  const failedRuns = evidence.runs.filter((entry) => entry.status === "FAIL");
  if (failedRuns.length) {
    console.error(`FAIL live runs: ${failedRuns.map((r) => `${r.host} ${r.scenario}: ${r.reason ?? "failed"}`).join("; ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`FAIL fresh-install acceptance: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
