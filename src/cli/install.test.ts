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
    const ocConfig = readFileSync(join(home, ".config", "opencode", "opencode.jsonc"), "utf8");
    assert.ok(ocConfig.includes(pathToFileURL(join(home, ".config", "opencode", "plugins", "paradoc.js")).href));
    const cp = readFileSync(join(home, ".copilot", "extensions", "paradoc", "extension.mjs"), "utf8");
    assert.ok(cp.includes(pathToFileURL(join(runtime, "dist", "copilot-cli", "extension-entry.js")).href));
  });

  it("--project writes the opencode shim under cwd and is idempotent", () => {
    const { root, distDir, home, env } = fixture();
    const cwd = join(root, "proj");
    install({ targets: ["opencode"], project: true, home, cwd, env, distDir });
    install({ targets: ["opencode"], project: true, home, cwd, env, distDir });
    assert.ok(existsSync(join(cwd, ".opencode", "plugins", "paradoc.js")));
    const projectConfig = readFileSync(join(cwd, "opencode.jsonc"), "utf8");
    assert.equal(projectConfig.match(/paradoc\.js/g)?.length, 1);
    assert.ok(!existsSync(join(home, ".copilot")));
  });

  it("adds the shim to an existing OpenCode plugin array without clobbering config", () => {
    const { root, distDir, home, env } = fixture();
    const cwd = join(root, "existing");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "opencode.jsonc"), '{\n  "plugin": ["existing-plugin"],\n  "theme": "dark"\n}\n');
    install({ targets: ["opencode"], project: true, home, cwd, env, distDir });
    install({ targets: ["opencode"], project: true, home, cwd, env, distDir });
    const config = readFileSync(join(cwd, "opencode.jsonc"), "utf8");
    assert.ok(config.includes('"existing-plugin"'));
    assert.ok(config.includes('"theme": "dark"'));
    assert.equal(config.match(/paradoc\.js/g)?.length, 1);
  });
});
