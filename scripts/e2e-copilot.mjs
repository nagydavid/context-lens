#!/usr/bin/env node
// Opt-in live proof for the Copilot CLI extension. It intentionally retains the
// temporary project on both PASS and FAIL so the host logs remain inspectable.
import { spawn, spawnSync } from "node:child_process";
import { access, copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
// PARADOC_E2E_DIST points the harness at an installed runtime **root** (the directory that contains
// `dist/`, i.e. `<XDG_DATA_HOME>/paradoc`), so the throwaway project's extension shim re-exports
// the packed/published entry instead of this checkout's build. Default behaviour (unset) is unchanged.
const runtimeRoot = process.env.PARADOC_E2E_DIST ?? root;
const dist = join(runtimeRoot, "dist", "copilot-cli");
const entryModule = join(dist, "extension-entry.js");
// Harness fixtures are deliberately not shipped in the package, so they always resolve from the
// checkout even when the extension entry under test comes from an installed runtime.
const fixtureModule = join(root, "dist", "copilot-cli", "probe-fixture.js");
const mcpEntryModule = join(dist, "mcp-entry.js");
// Minimum, not exact: the extension contract is stable across patch releases, and an exact pin
// produced constant WARN noise on every newer host.
const minimumVersion = "1.0.103";
const WEB_URL = process.env.PARADOC_E2E_WEB_URL || "https://nodejs.org/api/path.html";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** <0 when `a` is older than `b`. */
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
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
      .filter((name) => name !== "paradoc-e2e")
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

const PDF_SYMBOL = "pdfLensChecksum";
const PDF_PAGES = 6;
const PDF_LINES_PER_PAGE = 50;

/** Hand-written minimal text PDF (computed xref): PDF_PAGES pages of Helvetica prose with one unique symbol. */
function buildE2ePdf() {
  const objects = [];
  const pageIds = Array.from({ length: PDF_PAGES }, (_, i) => 3 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${PDF_PAGES} >>`;
  const fontId = 3 + PDF_PAGES * 2;
  for (let page = 0; page < PDF_PAGES; page++) {
    const lines = Array.from({ length: PDF_LINES_PER_PAGE }, (_, i) => {
      const n = page * PDF_LINES_PER_PAGE + i + 1;
      return n === 217
        ? `Line ${n}: the function ${PDF_SYMBOL} returns the magic number 4242 for every input.`
        : `Line ${n}: filler prose for the live harness document, section ${page + 1}, entry ${i + 1}.`;
    });
    const stream = `BT /F1 10 Tf 12 TL 40 760 Td ${lines.map((l) => `(${l}) '`).join(" ")} ET`;
    objects[pageIds[page]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageIds[page] + 1} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    objects[pageIds[page] + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  objects[fontId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

function hasPdftotext() {
  const probe = spawnSync("pdftotext", ["-v"], { stdio: "ignore" });
  return !probe.error;
}

function interceptedRecords(records) {
  return records.filter((record) => typeof record?.message === "string" && record.message.startsWith("intercepted "));
}

function findViewResult(logText) {
  const candidates = logText.match(/[\s\S]{0,600}\[paradoc\][\s\S]{0,3000}/g) ?? [];
  return candidates.find((candidate) => /Confidence:/.test(candidate) && !/fixtureValue400/.test(candidate));
}

// Each scenario runs with a throwaway COPILOT_HOME so user-level hooks, MCP servers and
// instructions cannot leak in. Only config.json (login state) and settings.json (experimental
// flag) are copied, and the copy is deleted after the run so no credentials are left in the
// retained temp project.
// PARADOC_E2E_SHARED_HOME=1 falls back to the real ~/.copilot.
const sharedHome = process.env.PARADOC_E2E_SHARED_HOME === "1";

async function createIsolatedHome(temp) {
  const home = join(temp, "copilot-home");
  await mkdir(home, { recursive: true });
  const userConfig = join(homedir(), ".copilot", "config.json");
  assert(await exists(userConfig), `${userConfig} not found; log in with copilot first or set PARADOC_E2E_SHARED_HOME=1`);
  await copyFile(userConfig, join(home, "config.json"));
  // settings.json carries `experimental: true`, which gates extension loading.
  const userSettings = join(homedir(), ".copilot", "settings.json");
  if (await exists(userSettings)) await copyFile(userSettings, join(home, "settings.json"));
  return home;
}

async function writeMcpConfig(temp, jsonlPath) {
  const mcpConfigPath = join(temp, "mcp-config.json");
  const mcpEnv = { PARADOC_LOG_FILE: jsonlPath };
  if (process.env.PARADOC_MODEL) mcpEnv.PARADOC_MODEL = process.env.PARADOC_MODEL;
  await writeFile(mcpConfigPath, JSON.stringify({
    mcpServers: {
      "paradoc-e2e": { type: "local", command: process.execPath, args: [mcpEntryModule], tools: ["*"], env: mcpEnv },
    },
  }), "utf8");
  return ["--additional-mcp-config", `@${mcpConfigPath}`];
}

async function runScenario({
  name,
  prompt = "Use the view tool to view big.ts in full (no view_range) and then report what computeLensChecksum returns.",
  installExtension = true,
  extraFiles = {},
  extraArgs = [],
  extraEnv = {},
  fixture: buildFixture = (mod) => mod.buildE2eFixture(),
  check,
}) {
  const temp = await mkdtemp(join(tmpdir(), "paradoc-copilot-e2e-"));
  const logDir = join(temp, "logs");
  const jsonlPath = join(temp, "paradoc.jsonl");
  const transcriptPath = join(temp, "copilot-transcript.txt");
  const paths = `project=${temp}\nlog-dir=${logDir}\ntranscript=${transcriptPath}\nparadoc-log=${jsonlPath}`;
  let isolatedHome;
  try {
    await mkdir(logDir, { recursive: true });
    const fixture = await import(pathToFileURL(fixtureModule).href);
    await writeFile(join(temp, "big.ts"), buildFixture(fixture), "utf8");
    await Promise.all(Object.entries(extraFiles).map(([file, content]) =>
      writeFile(join(temp, file), content, "utf8"),
    ));
    if (installExtension) {
      await mkdir(join(temp, ".github", "extensions", "paradoc"), { recursive: true });
      const extension = await import(pathToFileURL(entryModule).href);
      await writeFile(join(temp, ".github", "extensions", "paradoc", "extension.mjs"), extension.buildExtensionShim(extension.defaultEntryUrl()), "utf8");
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
    if (process.env.PARADOC_E2E_HOST_MODEL) args.push("--model", process.env.PARADOC_E2E_HOST_MODEL);
    const env = {
      ...process.env,
      GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: "true",
      PARADOC_LOG_FILE: jsonlPath,
      ...(isolatedHome ? { COPILOT_HOME: isolatedHome } : {}),
      ...extraEnv,
    };
    delete env.PARADOC_CHILD;
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
// The large scenario additionally falls back to concurrency=1 when a chunk subagent fails,
// mirroring the opencode harness, and reports concurrencyPinned.
async function runScenarioWithRetry(scenario) {
  try {
    return await runScenario(scenario);
  } catch (error) {
    if (scenario.pinOnChunkError && error.chunkError) {
      console.warn(`RETRY ${scenario.name} with PARADOC_CONCURRENCY=1: ${error.message}${error.paths ? `\n${error.paths}` : ""}`);
      const pinned = await runScenario({ ...scenario, extraEnv: { ...scenario.extraEnv, PARADOC_CONCURRENCY: "1" } });
      return { ...pinned, concurrencyPinned: true };
    }
    console.warn(`RETRY ${scenario.name}: ${error.message}${error.paths ? `\n${error.paths}` : ""}`);
    return runScenario(scenario);
  }
}

function parseScenarioFilter(argv) {
  const index = argv.indexOf("--scenario");
  return index === -1 ? "all" : argv[index + 1] ?? "all";
}

async function main() {
  const scenarioFilter = parseScenarioFilter(process.argv.slice(2));
  if (process.env.PARADOC_E2E !== "1") {
    console.log("SKIP copilot e2e (set PARADOC_E2E=1)");
    return;
  }
  if (!await exists(entryModule) || !await exists(fixtureModule) || !await exists(mcpEntryModule)) throw new Error("run npm run build");

  const version = await run("copilot", ["--version"], { cwd: root, env: process.env }, 15_000);
  if (version.code !== 0) throw new Error(`copilot --version failed: ${version.stderr.trim()}`);
  const versionText = version.stdout.trim();
  const foundVersion = versionText.match(/\d+\.\d+\.\d+/)?.[0];
  if (!foundVersion) console.warn(`WARN could not parse a copilot version from: ${versionText}`);
  else if (compareVersions(foundVersion, minimumVersion) < 0) console.warn(`WARN expected copilot >= ${minimumVersion}, got ${versionText}`);

  const fixtureMod = await import(pathToFileURL(fixtureModule).href);
  const largeSymbol = fixtureMod.E2E_LARGE_FIXTURE_SYMBOL;
  const scenarios = [
    {
      name: "happy",
      check: async ({ result, logs, records, logSource, transcriptPath }) => {
        assert(result.code === 0, `copilot exited ${result.code}; see ${transcriptPath}`);
        assert(/loaded\s+1\s+extension\(s\)|extension.*paradoc|paradoc.*extension/i.test(logs), "extension load evidence missing from debug logs");
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
        assert(/loaded\s+1\s+extension\(s\)|extension.*paradoc|paradoc.*extension/i.test(logs), "extension load evidence missing from debug logs");
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
      prompt: "Call the paradoc_read MCP tool with path big.ts and question 'What does computeLensChecksum return?'. Do not use the view tool. Report the answer.",
      extraArgs: ({ temp, jsonlPath }) => writeMcpConfig(temp, jsonlPath),
      check: async ({ result, transcript, logs, records, logSource, transcriptPath }) => {
        assert(result.code === 0, `copilot exited ${result.code}; see ${transcriptPath}`);
        assert(findViewResult(`${transcript}\n${logs}`), "condensed MCP result with Confidence missing, or fixtureValue400 leaked; see transcript and debug logs");
        const intercepted = records.filter((record) => record?.message?.startsWith("intercepted") && Number.isFinite(record?.elapsedMs));
        assert(intercepted.length >= 1, `expected an intercepted MCP record, got ${intercepted.length} (${logSource})`);
      },
    },
    {
      name: "pdf",
      installExtension: false,
      skip: () => (hasPdftotext() ? undefined : "pdf (pdftotext not found)"),
      extraFiles: { "report.pdf": buildE2ePdf() },
      prompt: `Call the paradoc_read MCP tool with path report.pdf and question 'What does ${PDF_SYMBOL} return?'. Do not use any other tool. Report the answer.`,
      extraArgs: ({ temp, jsonlPath }) => writeMcpConfig(temp, jsonlPath),
      check: async ({ result, records, logSource, transcriptPath }) => {
        assert(result.code === 0, `copilot exited ${result.code}; see ${transcriptPath}`);
        const pdfRecords = records.filter((record) => /\.pdf\b/.test(record?.message ?? "")
          && (record.message.startsWith("intercepted ") || /^fallback pdf-/.test(record.message)));
        assert(pdfRecords.length >= 1, `expected an intercepted or fallback pdf-* record for report.pdf, got none among ${records.length} records (${logSource})`);
      },
    },
    {
      name: "web",
      installExtension: false,
      skip: () => (process.env.PARADOC_E2E_WEB === "1" ? undefined : "web (set PARADOC_E2E_WEB=1)"),
      prompt: `Call the paradoc_web_read MCP tool with url ${WEB_URL} and question 'What does path.join do?'. Do not use any other tool. Report the answer.`,
      extraArgs: ({ temp, jsonlPath }) => writeMcpConfig(temp, jsonlPath),
      check: async ({ result, records, logSource, transcriptPath }) => {
        assert(result.code === 0, `copilot exited ${result.code}; see ${transcriptPath}`);
        const host = new URL(WEB_URL).host;
        const webRecords = records.filter((record) => typeof record?.message === "string" && record.message.includes(host)
          && (record.message.startsWith("intercepted ") || record.message.startsWith("fallback ")));
        assert(webRecords.length >= 1, `expected an intercepted/fallback record labelled with the masked URL (${host}), got none among ${records.length} records (${logSource})`);
      },
    },
    {
      name: "bogus-model",
      extraEnv: { PARADOC_MODEL: "github/definitely-not-a-model" },
      check: async ({ result, transcript, logs, records, logSource, transcriptPath }) => {
        assert(result.code === 0, `copilot exited ${result.code}; see ${transcriptPath}`);
        assert(logSource === "jsonl", "paradoc JSONL log was not written");
        const intercepted = records.some((record) => record?.message?.startsWith("intercepted"));
        if (intercepted) {
          throw new Error("bogus model was accepted by copilot (read was intercepted); live fallback not provable with this model spec");
        }
        assert(`${transcript}\n${logs}`.includes("fixtureValue400"), "full file marker fixtureValue400 did not reach the host output or debug logs");
        assert(records.some((record) => record?.level === "warn" && record?.fallbackReason && record?.message?.startsWith("fallback")), "fallback warn record missing from paradoc JSONL log");
      },
    },
    {
      name: "large",
      fixture: (mod) => mod.buildLargeE2eFixture(),
      prompt: `Use the view tool to view big.ts in full (no view_range) and then report what ${largeSymbol} returns.`,
      extraEnv: { PARADOC_CHUNK_LINES: "1000", PARADOC_CONCURRENCY: "3" },
      pinOnChunkError: true,
      check: async ({ result, logs, records, logSource, transcriptPath }) => {
        assert(result.code === 0, `copilot exited ${result.code}; see ${transcriptPath}`);
        const chunkFailure = records.find((record) => /chunk \d+\/\d+/.test(record?.message ?? "") || record?.fallbackReason === "subagent-error");
        const chunkCounts = interceptedRecords(records).map((record) => Number(/chunks=(\d+)/.exec(record.message)?.[1] ?? 0));
        if (!chunkCounts.some((n) => n >= 2) && chunkFailure) {
          const error = new Error(`chunk subagent error: ${chunkFailure.message}`);
          error.chunkError = true;
          throw error;
        }
        assert(chunkCounts.some((n) => n >= 2), `expected an intercepted record with chunks>=2, got [${chunkCounts.join(",")}] (${logSource})`);
        assert(findViewResult(logs), "condensed view result with Confidence missing, or fixtureValue400 leaked; see debug logs");
      },
    },
    {
      name: "cache-repeat",
      prompt: "Use the view tool to view big.ts in full (no view_range). Then use the view tool to view big.ts in full again. Then report what computeLensChecksum returns.",
      check: async ({ result, records, logSource, transcriptPath }) => {
        assert(result.code === 0, `copilot exited ${result.code}; see ${transcriptPath}`);
        const intercepted = interceptedRecords(records);
        assert(intercepted.length >= 2, `expected at least 2 intercepted records, got ${intercepted.length} (${logSource})`);
        assert(!/cacheHit=true/.test(intercepted[0].message), "first intercepted record unexpectedly has cacheHit=true");
        const hit = intercepted.slice(1).find((record) => /cacheHit=true/.test(record.message));
        assert(hit, "no later intercepted record has cacheHit=true");
        const elapsed = Number.isFinite(hit.elapsedMs) ? hit.elapsedMs : Number(/(\d+)ms\)/.exec(hit.message)?.[1]);
        assert(Number.isFinite(elapsed) && elapsed < 50, `cached record elapsed ${elapsed}ms, expected < 50ms`);
      },
    },
    {
      name: "judge",
      extraEnv: { PARADOC_JUDGE: "always" },
      check: async ({ result, transcript, logs, records, logSource, transcriptPath }) => {
        assert(result.code === 0, `copilot exited ${result.code}; see ${transcriptPath}`);
        const intercepted = interceptedRecords(records);
        // Adapter wording: `intercepted <path> (..., judge=<verdict|error>, Nms) judge error: <detail>` at warn level.
        if (intercepted.some((record) => /judge=\w+/.test(record.message))) return;
        const rejected = records.some((record) => record?.fallbackReason === "judge-rejected" || /^fallback judge-rejected /.test(record?.message ?? ""));
        if (rejected) {
          assert(`${transcript}\n${logs}`.includes("fixtureValue400"), "judge-rejected but full file marker fixtureValue400 missing from output");
          return;
        }
        assert(false, `no judge= token or judge-rejected fallback in ${records.length} records (${logSource})`);
      },
    },
  ];

  const names = scenarios.map((scenario) => scenario.name);
  assert(scenarioFilter === "all" || names.includes(scenarioFilter), `unknown scenario "${scenarioFilter}"; valid: ${names.join(", ")}, all`);
  for (const scenario of scenarios.filter((entry) => scenarioFilter === "all" || entry.name === scenarioFilter)) {
    const skipReason = scenario.skip?.();
    if (skipReason) {
      console.log(`SKIP ${skipReason}`);
      continue;
    }
    try {
      const { paths, logSource, concurrencyPinned } = await runScenarioWithRetry(scenario);
      console.log(`PASS ${scenario.name}\n${paths}\nlog-source=${logSource}${concurrencyPinned ? "\nconcurrencyPinned=true" : ""}`);
    } catch (error) {
      console.error(`FAIL ${scenario.name}: ${error.message}${error.paths ? `\n${error.paths}` : ""}`);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => { console.error(`FAIL copilot e2e: ${error.message}`); process.exitCode = 1; });
