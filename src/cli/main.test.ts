import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { TUNING_KEYS } from "../core/tuning.js";

const MAIN = new URL("./main.js", import.meta.url).pathname;

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  cwd: string;
  home: string;
  projectConfig: string;
  globalConfig: string;
  env: NodeJS.ProcessEnv;
}

/** A throwaway cwd + home + XDG config home, with any inherited PARADOC_* tuning removed. */
function setup(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "paradoc-cli-"));
  roots.push(root);
  const cwd = join(root, "project");
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, XDG_DATA_HOME: join(root, "xdg-data") };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PARADOC_")) delete env[key];
  }
  return {
    root,
    cwd,
    home,
    projectConfig: join(cwd, ".paradoc", "config.json"),
    globalConfig: join(xdg, "paradoc", "config.json"),
    env,
  };
}

function run(f: Fixture, ...args: string[]) {
  const result = spawnSync(process.execPath, [MAIN, ...args], { cwd: f.cwd, env: f.env, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The rendered status line for one key: `<value> <source>`. */
function setting(f: Fixture, key: string): { value: string; source: string } {
  const out = run(f, "status");
  assert.equal(out.code, 0, out.stderr);
  const line = out.stdout.split("\n").find((l) => l.trim().startsWith(key));
  assert.ok(line, `status output has no line for ${key}:\n${out.stdout}`);
  const [, value, source] = line.trim().split(/\s+/);
  return { value, source };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function writeRaw(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

describe("paradoc control commands", () => {
  it("status reports defaults, both config paths and no model", () => {
    const f = setup();
    const out = run(f, "status");
    assert.equal(out.code, 0);
    assert.ok(out.stdout.startsWith("ParaDoc status"));
    assert.ok(out.stdout.includes("source precedence: explicit > env > project > global > default"));
    for (const key of TUNING_KEYS) {
      assert.equal(setting(f, key).source, "default", `expected ${key} to be default`);
    }
    assert.ok(out.stdout.includes(`config (project): ${f.projectConfig}`), out.stdout);
    assert.ok(out.stdout.includes(`config (global):  ${f.globalConfig}`), out.stdout);
    assert.ok(out.stdout.includes("model: none  none"), out.stdout);
    assert.ok(!out.stdout.includes("stats:"), "a fresh CLI process has no interceptor stats");
    assert.equal(run(f, "status").stdout, out.stdout, "status must be deterministic");
  });

  it("set writes the project config and status shows source=project", () => {
    const f = setup();
    const out = run(f, "set", "thresholdLines", "500");
    assert.equal(out.code, 0);
    assert.ok(out.stdout.startsWith(`wrote ${f.projectConfig}`), out.stdout);
    assert.ok(out.stdout.includes("restart the host to apply this in the current session"), out.stdout);
    assert.deepEqual(readJson(f.projectConfig).tuning, { thresholdLines: 500 });
    assert.deepEqual(setting(f, "thresholdLines"), { value: "500", source: "project" });
    assert.equal(setting(f, "timeoutMs").source, "default");
  });

  it("set --global writes the home config and status shows source=global", () => {
    const f = setup();
    const out = run(f, "set", "--global", "timeoutMs", "1500");
    assert.equal(out.code, 0);
    assert.ok(out.stdout.startsWith(`wrote ${f.globalConfig}`), out.stdout);
    assert.deepEqual(readJson(f.globalConfig).tuning, { timeoutMs: 1500 });
    assert.deepEqual(setting(f, "timeoutMs"), { value: "1500", source: "global" });
  });

  it("project scope wins over global scope", () => {
    const f = setup();
    run(f, "set", "--global", "concurrency", "4");
    run(f, "set", "concurrency", "2");
    assert.deepEqual(setting(f, "concurrency"), { value: "2", source: "project" });
  });

  it("set --project is the default scope and writes the project file", () => {
    const f = setup();
    const out = run(f, "set", "minTokens", "2000", "--project");
    assert.equal(out.code, 0);
    assert.ok(out.stdout.startsWith(`wrote ${f.projectConfig}`), out.stdout);
  });

  it("set preserves model and unknown keys in the config file", () => {
    const f = setup();
    writeRaw(f.projectConfig, JSON.stringify({ version: 1, model: { providerID: "openai", modelID: "gpt-4o-mini" }, custom: { keep: true } }));
    assert.equal(run(f, "set", "judge", "low-confidence").code, 0);
    const config = readJson(f.projectConfig);
    assert.deepEqual(config.model, { providerID: "openai", modelID: "gpt-4o-mini" });
    assert.deepEqual(config.custom, { keep: true });
    assert.deepEqual(config.tuning, { judge: "low-confidence" });
    assert.ok(run(f, "status").stdout.includes("model: openai/gpt-4o-mini  project"), run(f, "status").stdout);
  });

  it("env tuning is reported with its source", () => {
    const f = setup();
    f.env.PARADOC_THRESHOLD = "120";
    assert.deepEqual(setting(f, "thresholdLines"), { value: "120", source: "env" });
  });

  it("reset removes one key and reset without a key removes the whole block", () => {
    const f = setup();
    run(f, "set", "thresholdLines", "500");
    run(f, "set", "minTokens", "2000");

    const one = run(f, "reset", "thresholdLines");
    assert.equal(one.code, 0);
    assert.ok(one.stdout.startsWith(`wrote ${f.projectConfig}`), one.stdout);
    assert.deepEqual(readJson(f.projectConfig).tuning, { minTokens: 2000 });
    assert.equal(setting(f, "thresholdLines").source, "default");

    const all = run(f, "reset");
    assert.equal(all.code, 0);
    assert.ok(!("tuning" in readJson(f.projectConfig)), "the tuning block should be gone");
    assert.equal(setting(f, "minTokens").source, "default");
  });

  it("reset --global clears only the global scope", () => {
    const f = setup();
    run(f, "set", "--global", "concurrency", "4");
    run(f, "set", "concurrency", "2");
    const out = run(f, "reset", "--global");
    assert.equal(out.code, 0);
    assert.ok(out.stdout.startsWith(`wrote ${f.globalConfig}`), out.stdout);
    assert.ok(!("tuning" in readJson(f.globalConfig)));
    assert.deepEqual(readJson(f.projectConfig).tuning, { concurrency: 2 });
  });

  it("reset with nothing set says nothing to reset", () => {
    const f = setup();
    const out = run(f, "reset");
    assert.equal(out.code, 0);
    assert.equal(out.stdout.trim(), "nothing to reset");
  });

  it("unknown key is a usage error naming the accepted keys", () => {
    const f = setup();
    const out = run(f, "set", "thresholdLinez", "5");
    assert.equal(out.code, 2);
    assert.ok(out.stderr.includes('unknown key "thresholdLinez"'), out.stderr);
    assert.ok(out.stderr.includes(`keys: ${TUNING_KEYS.join(", ")}`), out.stderr);
    assert.ok(out.stderr.includes("example: paradoc set thresholdLines 500"), out.stderr);
    assert.equal(out.stdout, "");
  });

  it("invalid value is a usage error with the reason", () => {
    const f = setup();
    const out = run(f, "set", "thresholdLines", "abc");
    assert.equal(out.code, 2);
    assert.ok(out.stderr.includes('invalid value "abc" for thresholdLines: expected an integer'), out.stderr);
  });

  it("cacheMaxEntries accepts off", () => {
    const f = setup();
    assert.equal(run(f, "set", "cacheMaxEntries", "off").code, 0);
    assert.deepEqual(readJson(f.projectConfig).tuning, { cacheMaxEntries: 0 });
  });

  it("an inconsistent chunk pair is refused with an actionable message", () => {
    const f = setup();
    assert.equal(run(f, "set", "chunkLines", "100").code, 0);
    const out = run(f, "set", "chunkOverlapLines", "200");
    assert.equal(out.code, 1);
    assert.ok(out.stderr.includes("must be smaller than chunkLines"), out.stderr);
    assert.ok(out.stderr.includes("chunkOverlapLines"), out.stderr);
    const tuning = readJson(f.projectConfig).tuning as Record<string, unknown> | undefined;
    assert.equal(tuning?.chunkOverlapLines, undefined, "the bad value must not be written");
    assert.equal(tuning?.chunkLines, 100);
  });

  it("a corrupt config file is refused by name and never overwritten", () => {
    const f = setup();
    writeRaw(f.projectConfig, "{ not json");
    const out = run(f, "set", "thresholdLines", "500");
    assert.equal(out.code, 1);
    assert.ok(out.stderr.includes(`refusing to overwrite ${f.projectConfig}: invalid JSON`), out.stderr);
    assert.equal(readFileSync(f.projectConfig, "utf8"), "{ not json");
  });

  it("status still works with a corrupt config and reports the warning", () => {
    const f = setup();
    writeRaw(f.projectConfig, "{ not json");
    const out = run(f, "status");
    assert.equal(out.code, 0);
    assert.ok(out.stdout.includes("warnings:"), out.stdout);
    assert.ok(out.stdout.includes(`ignoring ${f.projectConfig}: invalid JSON`), out.stdout);
    assert.equal(setting(f, "thresholdLines").source, "default");
  });

  it("bad usage exits 2 with usage on stderr", () => {
    const f = setup();
    for (const args of [["set"], ["set", "thresholdLines"], ["frobnicate"], ["--nope"], []]) {
      const out = run(f, ...args);
      assert.equal(out.code, 2, `expected exit 2 for ${args.join(" ")}`);
      assert.ok(out.stderr.includes("usage: paradoc status"), out.stderr);
      assert.equal(out.stdout, "");
    }
  });

  it("install usage and exit codes are unchanged", () => {
    const f = setup();
    const bad = run(f, "install", "nope");
    assert.equal(bad.code, 2);
    assert.ok(bad.stderr.startsWith("usage: paradoc install [opencode|copilot|all] [--project]\n"), bad.stderr);

    const out = run(f, "install", "copilot");
    assert.equal(out.code, 0);
    const lines = out.stdout.split("\n");
    assert.equal(lines[0], `runtime: ${join(f.env.XDG_DATA_HOME ?? "", "paradoc", "dist")}`);
    assert.ok(lines[1]?.startsWith(`copilot: ${join(f.home, ".copilot", "extensions", "paradoc", "extension.mjs")}`), out.stdout);
    assert.ok(lines[2]?.startsWith(`copilot-mcp: ${join(f.home, ".copilot", "mcp-config.json")}`), out.stdout);
    assert.equal(lines[3], "Restart opencode / copilot to load ParaDoc.");
  });
});
