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
  mkdirSync(join(distDir, "copilot-cli"), { recursive: true });
  writeFileSync(join(distDir, "copilot-cli", "mcp-entry.js"), "export {};\n");
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

  describe("MCP registration", () => {
    const stripComments = (text: string) => text.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const entryOf = (home: string) => join(home, ".local", "share", "paradoc", "dist", "copilot-cli", "mcp-entry.js");

    it("(a) writes both entries pointing at the runtime mcp-entry", () => {
      const { distDir, home, env } = fixture();
      install({ targets: ["opencode", "copilot"], home, env, distDir });
      const oc = JSON.parse(stripComments(readFileSync(join(home, ".config", "opencode", "opencode.jsonc"), "utf8")));
      assert.deepEqual(oc.mcp.servers.paradoc.command, ["node", entryOf(home)]);
      assert.equal(oc.mcp.servers.paradoc.type, "local");
      const cp = JSON.parse(readFileSync(join(home, ".copilot", "mcp-config.json"), "utf8"));
      assert.deepEqual(cp.mcpServers.paradoc, { type: "local", command: "node", args: [entryOf(home)], tools: ["*"] });
    });

    it("(b) is idempotent", () => {
      const { distDir, home, env } = fixture();
      install({ targets: ["opencode", "copilot"], home, env, distDir });
      install({ targets: ["opencode", "copilot"], home, env, distDir });
      for (const f of [join(home, ".config", "opencode", "opencode.jsonc"), join(home, ".copilot", "mcp-config.json")]) {
        assert.equal(readFileSync(f, "utf8").match(/mcp-entry\.js/g)?.length, 1);
      }
    });

    it("(c) --project writes into cwd opencode.jsonc, not the global file", () => {
      const { root, distDir, home, env } = fixture();
      const cwd = join(root, "proj");
      install({ targets: ["opencode"], project: true, home, cwd, env, distDir });
      assert.ok(readFileSync(join(cwd, "opencode.jsonc"), "utf8").includes("mcp-entry.js"));
      assert.ok(!existsSync(join(home, ".config", "opencode", "opencode.jsonc")));
    });

    it("(d) keeps comments, theme and other servers", () => {
      const { root, distDir, home, env } = fixture();
      const cwd = join(root, "d");
      mkdirSync(cwd, { recursive: true });
      writeFileSync(
        join(cwd, "opencode.jsonc"),
        '{\n  // keep me\n  "mcp": {"servers": {"other": {"type": "local", "command": ["x"]}}},\n  "theme": "dark"\n}\n',
      );
      install({ targets: ["opencode"], project: true, home, cwd, env, distDir });
      const text = readFileSync(join(cwd, "opencode.jsonc"), "utf8");
      assert.ok(text.includes("// keep me"));
      const parsed = JSON.parse(stripComments(text));
      assert.equal(parsed.theme, "dark");
      assert.deepEqual(parsed.mcp.servers.other.command, ["x"]);
      assert.deepEqual(parsed.mcp.servers.paradoc.command, ["node", entryOf(home)]);
    });

    it("(e) adds servers to an mcp object without one", () => {
      const { root, distDir, home, env } = fixture();
      const cwd = join(root, "e");
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, "opencode.jsonc"), '{ "mcp": {} }\n');
      install({ targets: ["opencode"], project: true, home, cwd, env, distDir });
      const parsed = JSON.parse(stripComments(readFileSync(join(cwd, "opencode.jsonc"), "utf8")));
      assert.deepEqual(parsed.mcp.servers.paradoc.command, ["node", entryOf(home)]);
    });

    it("leaves a user-owned paradoc server pointing elsewhere alone", () => {
      const { root, distDir, home, env } = fixture();
      const cwd = join(root, "own");
      mkdirSync(cwd, { recursive: true });
      const original = '{ "mcp": {"servers": {"paradoc": {"type": "local", "command": ["mine"]}}} }\n';
      writeFileSync(join(cwd, "opencode.jsonc"), original);
      install({ targets: ["opencode"], project: true, home, cwd, env, distDir });
      const text = readFileSync(join(cwd, "opencode.jsonc"), "utf8");
      assert.ok(!text.includes("mcp-entry.js"));
      assert.ok(text.includes('"mine"'));
    });

    it("(f) keeps other servers in an existing mcp-config.json", () => {
      const { distDir, home, env } = fixture();
      mkdirSync(join(home, ".copilot"), { recursive: true });
      writeFileSync(join(home, ".copilot", "mcp-config.json"), '{"mcpServers":{"other":{"command":"y"}},"keep":1}');
      install({ targets: ["copilot"], home, env, distDir });
      const cp = JSON.parse(readFileSync(join(home, ".copilot", "mcp-config.json"), "utf8"));
      assert.equal(cp.mcpServers.other.command, "y");
      assert.equal(cp.keep, 1);
      assert.ok(cp.mcpServers.paradoc);
    });

    it("(g) throws on invalid mcp-config.json without modifying it", () => {
      const { distDir, home, env } = fixture();
      mkdirSync(join(home, ".copilot"), { recursive: true });
      const file = join(home, ".copilot", "mcp-config.json");
      writeFileSync(file, "{ not json");
      assert.throws(() => install({ targets: ["copilot"], home, env, distDir }), /Copilot MCP config is not valid JSON/);
      assert.equal(readFileSync(file, "utf8"), "{ not json");
    });

    it("(h) single-target installs touch only their own host", () => {
      const a = fixture();
      install({ targets: ["copilot"], home: a.home, env: a.env, distDir: a.distDir });
      assert.ok(!existsSync(join(a.home, ".config", "opencode")));
      const b = fixture();
      install({ targets: ["opencode"], home: b.home, env: b.env, distDir: b.distDir });
      assert.ok(!existsSync(join(b.home, ".copilot")));
    });
  });
});
