import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { install } from "./install.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cl-install-"));
  const distDir = join(root, "dist");
  mkdirSync(join(distDir, "opencode"), { recursive: true });
  writeFileSync(join(distDir, "opencode", "plugin-v2.js"), "export {};\n");
  writeFileSync(join(distDir, "opencode", "plugin-v2.test.js"), "export {};\n");
  const home = join(root, "home");
  return { root, distDir, home, env: { XDG_DATA_HOME: undefined, XDG_CONFIG_HOME: undefined } as NodeJS.ProcessEnv };
}

describe("install", () => {
  it("copies the runtime without tests and writes both shims pointing at it", () => {
    const { distDir, home, env } = fixture();
    install({ targets: ["opencode", "copilot"], home, env, distDir });

    const runtime = join(home, ".local", "share", "paradoc");
    assert.ok(existsSync(join(runtime, "dist", "opencode", "plugin-v2.js")));
    assert.ok(!existsSync(join(runtime, "dist", "opencode", "plugin-v2.test.js")));
    assert.equal(readFileSync(join(runtime, "package.json"), "utf8"), '{"type":"module"}\n');

    const oc = readFileSync(join(home, ".config", "opencode", "plugins", "paradoc.js"), "utf8");
    assert.ok(oc.includes(pathToFileURL(join(runtime, "dist", "opencode", "plugin-v2.js")).href));
    const cp = readFileSync(join(home, ".copilot", "extensions", "paradoc", "extension.mjs"), "utf8");
    assert.ok(cp.includes(pathToFileURL(join(runtime, "dist", "copilot-cli", "extension-entry.js")).href));
  });

  it("--project writes the opencode shim under cwd and is idempotent", () => {
    const { root, distDir, home, env } = fixture();
    const cwd = join(root, "proj");
    install({ targets: ["opencode"], project: true, home, cwd, env, distDir });
    install({ targets: ["opencode"], project: true, home, cwd, env, distDir });
    assert.ok(existsSync(join(cwd, ".opencode", "plugins", "paradoc.js")));
    assert.ok(!existsSync(join(home, ".copilot")));
  });
});
