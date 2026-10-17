#!/usr/bin/env node
// Opt-in live proof for the Copilot CLI extension. It intentionally retains the
// temporary project on both PASS and FAIL so the host logs remain inspectable.
import { spawn } from "node:child_process";
import { access, copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist", "copilot-cli");
const entryModule = join(dist, "extension-entry.js");
const fixtureModule = join(dist, "probe-fixture.js");
const mcpEntryModule = join(dist, "mcp-entry.js");
const expectedVersion = "1.0.98";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(path) {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

function run(command, args, options, timeoutMs = 240_000) {
  return new Promise((resolveRun) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    const settle = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { stderr += `\n${error.message}`; });
    child.on("close", settle);
  });
}

async function mcpDisableArgs() {
  const configPath = join(homedir(), ".copilot", "mcp-config.json");
  if (!await exists(configPath)) return [];
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const servers = config.mcpServers ?? config.servers ?? {};
    return Object.keys(servers)
      .filter((name) => name !== "context-lens-e2e")
      .flatMap((name) => ["--disable-mcp-server", name]);
  } catch (error) {
    console.warn(`WARN could not parse ${configPath}: ${error.message}`);
    return [];
  }
}

async function allLogText(logDir) {
  const files = await readdir(logDir, { recursive: true });
  const chunks = await Promise.all(files.map(async (file) => {
    const path = join(logDir, file);
    try { return await readFile(path, "utf8"); } catch { return ""; }
  }));
  return chunks.join("\n");
}

function findViewResult(logText) {
  const candidates = logText.match(/[\s\S]{0,600}\[context-lens\][\s\S]{0,3000}/g) ?? [];
  return candidates.find((candidate) => /Confidence:/.test(candidate) && !/fixtureValue400/.test(candidate));
}

// Each scenario runs with a throwaway COPILOT_HOME so user-level hooks, MCP servers and
// instructions cannot leak in. Only config.json (login state) and settings.json (experimental
// flag) are copied, and the copy is deleted after the run so no credentials are left in the
// retained temp project.
// CONTEXT_LENS_E2E_SHARED_HOME=1 falls back to the real ~/.copilot.
const sharedHome = process.env.CONTEXT_LENS_E2E_SHARED_HOME === "1";

async function createIsolatedHome(temp) {
  const home = join(temp, "copilot-home");
  await mkdir(home, { recursive: true });
  const userConfig = join(homedir(), ".copilot", "config.json");
  assert(await exists(userConfig), `${userConfig} not found; log in with copilot first or set CONTEXT_LENS_E2E_SHARED_HOME=1`);
  await copyFile(userConfig, join(home, "config.json"));
  // settings.json carries `experimental: true`, which gates extension loading.
  const userSettings = join(homedir(), ".copilot", "settings.json");
  if (await exists(userSettings)) await copyFile(userSettings, join(home, "settings.json"));
  return home;
}

async function runScenario({
  name,
  prompt = "Use the view tool to view big.ts in full (no view_range) and then report what computeLensChecksum returns.",
  installExtension = true,
  extraFiles = {},
  extraArgs = [],
  extraEnv = {},
  check,
}) {
  const temp = await mkdtemp(join(tmpdir(), "context-lens-copilot-e2e-"));
  const logDir = join(temp, "logs");
  const jsonlPath = join(temp, "context-lens.jsonl");
  const transcriptPath = join(temp, "copilot-transcript.txt");
  const paths = `project=${temp}\nlog-dir=${logDir}\ntranscript=${transcriptPath}\ncontext-lens-log=${jsonlPath}`;
  let isolatedHome;
  try {
    await mkdir(logDir, { recursive: true });
    const fixture = await import(pathToFileURL(fixtureModule).href);
    await writeFile(join(temp, "big.ts"), fixture.buildE2eFixture(), "utf8");
    await Promise.all(Object.entries(extraFiles).map(([file, content]) =>
      writeFile(join(temp, file), content, "utf8"),
    ));
    if (installExtension) {
      await mkdir(join(temp, ".github", "extensions", "context-lens"), { recursive: true });
      const extension = await import(pathToFileURL(entryModule).href);
      await writeFile(join(temp, ".github", "extensions", "context-lens", "extension.mjs"), extension.buildExtensionShim(extension.defaultEntryUrl()), "utf8");
    }
    const init = await run("git", ["init"], { cwd: temp, env: process.env }, 15_000);
    assert(init.code === 0, `git init failed: ${init.stderr.trim()}`);

    if (!sharedHome) isolatedHome = await createIsolatedHome(temp);
    console.log(`INFO ${sharedHome ? "using shared ~/.copilot (user hooks and MCP servers apply)" : "isolated COPILOT_HOME (user hooks, MCP servers, instructions excluded)"}`);
    const scenarioArgs = typeof extraArgs === "function"
      ? await extraArgs({ temp, jsonlPath })
      : extraArgs;
    const args = [
      "-p", prompt,
      "--allow-all-tools", "--log-dir", logDir, "--log-level", "debug", ...(sharedHome ? await mcpDisableArgs() : []), ...scenarioArgs,
    ];
    if (process.env.CONTEXT_LENS_E2E_HOST_MODEL) args.push("--model", process.env.CONTEXT_LENS_E2E_HOST_MODEL);
    const env = {
      ...process.env,
      GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: "true",
      CONTEXT_LENS_LOG_FILE: jsonlPath,
      ...(isolatedHome ? { COPILOT_HOME: isolatedHome } : {}),
      ...extraEnv,
    };
    delete env.CONTEXT_LENS_CHILD;
    const result = await run("copilot", args, { cwd: temp, env });
    const transcript = `${result.stdout}\n--- stderr ---\n${result.stderr}`;
    await writeFile(transcriptPath, transcript, "utf8");
    assert(!result.timedOut, "copilot timed out after 240s");

    const logs = await allLogText(logDir);
    let jsonl = "";
    let logSource = "jsonl";
    try { jsonl = await readFile(jsonlPath, "utf8"); } catch { jsonl = logs; logSource = "debug-log fallback"; }
    const records = jsonl.split("\n").map((line) => {
      try { return JSON.parse(line); } catch { return undefined; }
    }).filter(Boolean);
    await check({ result, transcript, logs, records, logSource, paths, transcriptPath });
    return { paths, logSource };
  } catch (error) {
    error.paths = paths;
    throw error;
  } finally {
    if (isolatedHome) await rm(isolatedHome, { recursive: true, force: true });
  }
}

// One retry per scenario absorbs model flakiness (L005); a second failure is real.
async function runScenarioWithRetry(scenario) {
  try {
    return await runScenario(scenario);
  } catch (error) {
    console.warn(`RETRY ${scenario.name}: ${error.message}${error.paths ? `\n${error.paths}` : ""}`);
    return runScenario(scenario);
  }
}

async function main() {
  if (process.env.CONTEXT_LENS_E2E !== "1") {
    console.log("SKIP copilot e2e (set CONTEXT_LENS_E2E=1)");
    return;
  }
  if (!await exists(entryModule) || !await exists(fixtureModule) || !await exists(mcpEntryModule)) throw new Error("run npm run build");

  const version = await run("copilot", ["--version"], { cwd: root, env: process.env }, 15_000);
  if (version.code !== 0) throw new Error(`copilot --version failed: ${version.stderr.trim()}`);
  if (!version.stdout.includes(expectedVersion)) console.warn(`WARN expected copilot ${expectedVersion}, got ${version.stdout.trim()}`);

  const scenarios = [
    {
      name: "happy",
      check: async ({ result, logs, records, logSource, transcriptPath }) => {
        assert(result.code === 0, `copilot exited ${result.code}; see ${transcriptPath}`);
        assert(/loaded\s+1\s+extension\(s\)|extension.*context-lens|context-lens.*extension/i.test(logs), "extension load evidence missing from debug logs");
        assert(findViewResult(logs), "condensed view result with Confidence missing, or fixtureValue400 leaked; see debug logs");
        const intercepted = records.filter((record) => record?.message?.startsWith("intercepted") && Number.isFinite(record?.elapsedMs));
        assert(intercepted.length === 1, `expected exactly one intercepted record, got ${intercepted.length} (${logSource})`);
      },
    },
    {
      name: "pass-through",
      extraFiles: {
        "small.ts": Array.from(
          { length: 40 },
          (_, index) => `export const smallFixtureMarker${index + 1} = ${index + 1};`,
        ).join("\n"),
      },
      prompt: "Use the view tool to view small.ts in full. Then use the view tool on big.ts with view_range [390, 400]. Report the value of smallFixtureMarker40 and the name of the last function in big.ts.",
      check: async ({ result, transcript, logs, records, logSource, transcriptPath }) => {
        assert(result.code === 0, `copilot exited ${result.code}; see ${transcriptPath}`);
        assert(/loaded\s+1\s+extension\(s\)|extension.*context-lens|context-lens.*extension/i.test(logs), "extension load evidence missing from debug logs");
        const output = `${transcript}\n${logs}`;
        assert(output.includes("smallFixtureMarker40"), "small file marker missing from host output or debug logs");
        assert(output.includes("fixtureValue395"), "ranged view marker missing from host output or debug logs");
        const intercepted = records.filter((record) => record?.message?.startsWith("intercepted"));
        assert(intercepted.length === 0, `expected no intercepted records, got ${intercepted.length} (${logSource})`);
        const fallbacks = records.filter((record) => record?.level === "warn" && record?.message?.startsWith("fallback"));
        assert(fallbacks.length === 0, `expected no fallback warn records, got ${fallbacks.length} (${logSource})`);
      },
    },
    {
      name: "mcp",
      installExtension: false,
      prompt: "Call the context_lens_read MCP tool with path big.ts and question 'What does computeLensChecksum return?'. Do not use the view tool. Report the answer.",
      extraArgs: async ({ temp, jsonlPath }) => {
        const mcpConfigPath = join(temp, "mcp-config.json");
        const mcpEnv = { CONTEXT_LENS_LOG_FILE: jsonlPath };
        if (process.env.CONTEXT_LENS_MODEL) mcpEnv.CONTEXT_LENS_MODEL = process.env.CONTEXT_LENS_MODEL;
        await writeFile(mcpConfigPath, JSON.stringify({
          mcpServers: {
            "context-lens-e2e": {
              type: "local",
              command: process.execPath,
              args: [mcpEntryModule],
              tools: ["*"],
              env: mcpEnv,
            },
          },
        }), "utf8");
        return ["--additional-mcp-config", `@${mcpConfigPath}`];
      },
      check: async ({ result, transcript, logs, records, logSource, transcriptPath }) => {
        assert(result.code === 0, `copilot exited ${result.code}; see ${transcriptPath}`);
        assert(findViewResult(`${transcript}\n${logs}`), "condensed MCP result with Confidence missing, or fixtureValue400 leaked; see transcript and debug logs");
        const intercepted = records.filter((record) => record?.message?.startsWith("intercepted") && Number.isFinite(record?.elapsedMs));
        assert(intercepted.length >= 1, `expected an intercepted MCP record, got ${intercepted.length} (${logSource})`);
      },
    },
    {
      name: "bogus-model",
      extraEnv: { CONTEXT_LENS_MODEL: "github/definitely-not-a-model" },
      check: async ({ result, transcript, logs, records, logSource, transcriptPath }) => {
        assert(result.code === 0, `copilot exited ${result.code}; see ${transcriptPath}`);
        assert(logSource === "jsonl", "context-lens JSONL log was not written");
        const intercepted = records.some((record) => record?.message?.startsWith("intercepted"));
        if (intercepted) {
          throw new Error("bogus model was accepted by copilot (read was intercepted); live fallback not provable with this model spec");
        }
        assert(`${transcript}\n${logs}`.includes("fixtureValue400"), "full file marker fixtureValue400 did not reach the host output or debug logs");
        assert(records.some((record) => record?.level === "warn" && record?.fallbackReason && record?.message?.startsWith("fallback")), "fallback warn record missing from context-lens JSONL log");
      },
    },
  ];

  for (const scenario of scenarios) {
    try {
      const { paths, logSource } = await runScenarioWithRetry(scenario);
      console.log(`PASS ${scenario.name}\n${paths}\nlog-source=${logSource}`);
    } catch (error) {
      console.error(`FAIL ${scenario.name}: ${error.message}${error.paths ? `\n${error.paths}` : ""}`);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => { console.error(`FAIL copilot e2e: ${error.message}`); process.exitCode = 1; });
