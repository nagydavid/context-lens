import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// Test-only fixtures and type-only modules (d.ts is published, empty js is not).
const EXCLUDED = new Set(["dist/opencode/e2e-fixture.js", "dist/copilot-cli/probe-fixture.js", "dist/core/models.js", "dist/copilot-cli/types.js"]);

test("every compiled non-test module is listed in package.json files", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    files: string[];
  };
  const listed = new Set(pkg.files);
  const missing: string[] = [];
  for (const dir of ["core", "opencode", "copilot-cli", "cli"]) {
    const entries = readdirSync(new URL(`../${dir}/`, import.meta.url));
    for (const name of entries) {
      if (!name.endsWith(".js") || name.endsWith(".test.js")) continue;
      const rel = `dist/${dir}/${name}`;
      if (EXCLUDED.has(rel)) continue;
      if (!listed.has(rel)) missing.push(rel);
    }
  }
  assert.deepEqual(missing, []);
});
