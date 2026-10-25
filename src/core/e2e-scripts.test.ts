import { strictEqual, ok } from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Compiled to dist/core/, so the repo root is two levels up.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TIMEOUT = 60_000;

function gateOffEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PARADOC_E2E;
  return env;
}

function run(args: string[], env: NodeJS.ProcessEnv = gateOffEnv()) {
  return spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", timeout: TIMEOUT });
}

const harnesses = [
  { script: "scripts/e2e-opencode.mjs", scenario: "cache" },
  { script: "scripts/e2e-copilot.mjs", scenario: "cache-repeat" },
  { script: "scripts/e2e-commands.mjs", scenario: "lifecycle" },
  // The fresh-install acceptance harness: its gate runs before argument parsing, so even an
  // unsupported `--scenario` value must still SKIP rather than reach the argument parser.
  { script: "scripts/accept-fresh-install.mjs", scenario: "large" },
];

describe("live harness scripts (hermetic guard)", () => {
  for (const { script, scenario } of harnesses) {
    it(`${script} parses`, { timeout: TIMEOUT }, () => {
      strictEqual(run(["--check", script]).status, 0);
    });

    it(`${script} skips without PARADOC_E2E`, { timeout: TIMEOUT }, () => {
      const result = run([script]);
      strictEqual(result.status, 0, result.stderr);
      ok(result.stdout.includes("SKIP"), result.stdout);
      if (script.includes("copilot")) {
        strictEqual(result.stdout.trim(), "SKIP copilot e2e (set PARADOC_E2E=1)");
      }
      if (script.includes("commands")) {
        strictEqual(result.stdout.trim(), "SKIP command e2e (set PARADOC_E2E=1)");
      }
      if (script.includes("accept-fresh-install")) {
        strictEqual(result.stdout.trim(), "SKIP fresh-install acceptance (set PARADOC_E2E=1)");
      }
    });

    it(`${script} --scenario ${scenario} still skips (gate runs before scenario validation)`, { timeout: TIMEOUT }, () => {
      const result = run([script, "--scenario", scenario]);
      strictEqual(result.status, 0, result.stderr);
      ok(result.stdout.includes("SKIP"), result.stdout);
    });
  }

  for (const { script } of harnesses) {
    for (const scenario of ["pdf", "web"]) {
      it(`${script} --scenario ${scenario} skips without the gate`, { timeout: TIMEOUT }, () => {
        const result = run([script, "--scenario", scenario]);
        strictEqual(result.status, 0, result.stderr);
        ok(result.stdout.includes("SKIP"), result.stdout);
      });
    }
  }

  it("scripts/bench.mjs runs hermetically", { timeout: TIMEOUT }, () => {
    const result = run(["scripts/bench.mjs", "--iterations", "1", "--latency", "0"]);
    strictEqual(result.status, 0, result.stderr);
    for (const word of ["serial", "parallel", "cached"]) {
      ok(result.stdout.includes(word), `missing "${word}" in: ${result.stdout}`);
    }
  });

  // The M008 reproduction entry point reuses the same gate convention as the harnesses.
  const repro = "scripts/repro-host-interception.mjs";
  const reproSkip = "SKIP host-interception repro (set PARADOC_E2E=1)";

  it(`${repro} parses`, { timeout: TIMEOUT }, () => {
    strictEqual(run(["--check", repro]).status, 0);
  });

  it(`${repro} skips without PARADOC_E2E`, { timeout: TIMEOUT }, () => {
    const result = run([repro]);
    strictEqual(result.status, 0, result.stderr);
    strictEqual(result.stdout.trim(), reproSkip);
  });

  it(`${repro} --out /nonexistent/x.json still skips with exit 0`, { timeout: TIMEOUT }, () => {
    const result = run([repro, "--out", "/nonexistent/x.json"]);
    strictEqual(result.status, 0, result.stderr);
    strictEqual(result.stdout.trim(), reproSkip);
    ok(!result.stdout.includes("nonexistent"), `argument handling leaked before the gate: ${result.stdout}${result.stderr}`);
  });

  it(`${repro} gate runs before argument validation (unknown args never reach the parser)`, { timeout: TIMEOUT }, () => {
    const result = run([repro, "--bogus", "--out"]);
    strictEqual(result.status, 0, result.stderr);
    strictEqual(result.stdout.trim(), reproSkip);
    strictEqual(result.stderr.trim(), "");
  });
});
