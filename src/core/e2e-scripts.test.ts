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
});
