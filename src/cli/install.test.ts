import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

const stripComments = (text: string) => text.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
/** Parses a JSONC config the way OpenCode would, so registration changes stay valid JSON. */
const parseConfig = (text: string): Record<string, unknown> => JSON.parse(stripComments(text)) as Record<string, unknown>;
const dirUrl = (path: string) => pathToFileURL(path).href;

describe("install", () => {
  it("copies the runtime without tests and writes both shims pointing at it", () => {
    const { distDir, home, env } = fixture();
    const lines = install({ targets: ["opencode", "copilot"], home, env, distDir });

    const runtime = join(home, ".local", "share", "paradoc");
    assert.ok(existsSync(join(runtime, "dist", "opencode", "plugin-v2.js")));
    assert.ok(!existsSync(join(runtime, "dist", "opencode", "plugin-v2.test.js")));
    assert.equal(readFileSync(join(runtime, "package.json"), "utf8"), '{"type":"module"}\n');

    // OpenCode v2 loads a plugin *directory* entry and runs its index module.
    const ocDir = join(home, ".config", "opencode");
    const pluginIndex = join(ocDir, "plugins", "paradoc", "index.js");
    assert.ok(lines.includes(`opencode: ${pluginIndex}`));
    assert.ok(readFileSync(pluginIndex, "utf8").includes(dirUrl(join(runtime, "dist", "opencode", "plugin-v2.js"))));
    const ocConfig = readFileSync(join(ocDir, "opencode.jsonc"), "utf8");
    assert.ok(ocConfig.includes(dirUrl(join(ocDir, "plugins", "paradoc"))));
    assert.deepEqual(parseConfig(ocConfig).plugins, [dirUrl(join(ocDir, "plugins", "paradoc"))]);
    // The shared plugins root is never written to, and the pre-directory-rule shim is gone.
    assert.ok(!existsSync(join(ocDir, "plugins", "index.js")));
    assert.ok(!existsSync(join(ocDir, "plugins", "paradoc.js")));

    const cp = readFileSync(join(home, ".copilot", "extensions", "paradoc", "extension.mjs"), "utf8");
    assert.ok(cp.includes(dirUrl(join(runtime, "dist", "copilot-cli", "extension-entry.js"))));
  });

  it("--project writes the plugin directory under cwd and is idempotent", () => {
    const { root, distDir, home, env } = fixture();
    const cwd = join(root, "proj");
    install({ targets: ["opencode"], project: true, home, cwd, env, distDir });
    install({ targets: ["opencode"], project: true, home, cwd, env, distDir });
    assert.ok(existsSync(join(cwd, ".opencode", "plugins", "paradoc", "index.js")));
    assert.ok(!existsSync(join(cwd, ".opencode", "plugins", "index.js")));
    const projectConfig = readFileSync(join(cwd, "opencode.jsonc"), "utf8");
    assert.equal(projectConfig.match(/\/plugins\/paradoc(\/index\.js)?/g)?.length, 1);
    assert.deepEqual(parseConfig(projectConfig).plugins, [dirUrl(join(cwd, ".opencode", "plugins", "paradoc"))]);
    assert.ok(existsSync(join(cwd, ".opencode", "commands", "paradoc.md")));
    assert.ok(!existsSync(join(home, ".copilot")));
  });

  it("upgrades a legacy singular plugin array without clobbering other plugins", () => {
    const { root, distDir, home, env } = fixture();
    const cwd = join(root, "existing");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "opencode.jsonc"), '{\n  "plugin": ["existing-plugin"],\n  "theme": "dark"\n}\n');
    install({ targets: ["opencode"], project: true, home, cwd, env, distDir });
    install({ targets: ["opencode"], project: true, home, cwd, env, distDir });
    const config = readFileSync(join(cwd, "opencode.jsonc"), "utf8");
    assert.ok(!config.includes('"plugin":'), "v2 ignores the singular key");
    const parsed = parseConfig(config);
    assert.deepEqual(parsed.plugins, ["existing-plugin", dirUrl(join(cwd, ".opencode", "plugins", "paradoc"))]);
    assert.equal(parsed.theme, "dark");
  });

  it("replaces ParaDoc's own legacy flat-shim entry and deletes the shim file", () => {
    const { root, distDir, home, env } = fixture();
    const cwd = join(root, "legacy");
    const pluginsRoot = join(cwd, ".opencode", "plugins");
    mkdirSync(pluginsRoot, { recursive: true });
    const legacyShim = join(pluginsRoot, "paradoc.js");
    writeFileSync(legacyShim, 'export { ParaDocV2Plugin as default } from "file:///stale/plugin-v2.js";\n');
    writeFileSync(join(cwd, "opencode.jsonc"), `{
  "plugin": [${JSON.stringify(dirUrl(legacyShim))}],
  "theme": "dark"
}
`);
    install({ targets: ["opencode"], project: true, home, cwd, env, distDir });
    const config = readFileSync(join(cwd, "opencode.jsonc"), "utf8");
    assert.ok(!config.includes("paradoc.js"), "the flat shim specifier must not survive: v2 warns it must be a directory");
    assert.ok(!existsSync(legacyShim), "a stale ParaDoc shim would be double-loaded by discovery");
    const parsed = parseConfig(config);
    assert.deepEqual(parsed.plugins, [dirUrl(join(cwd, ".opencode", "plugins", "paradoc"))]);
    assert.equal(parsed.theme, "dark");
  });

  it("appends to an existing plural plugins array, trailing comma included", () => {
    const { root, distDir, home, env } = fixture();
    const cwd = join(root, "plural");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "opencode.jsonc"), '{\n  // user plugins\n  "plugins": ["billion-context", "file:///opt/other",],\n  "theme": "dark"\n}\n');
    install({ targets: ["opencode"], project: true, home, cwd, env, distDir });
    const config = readFileSync(join(cwd, "opencode.jsonc"), "utf8");
    assert.ok(config.includes("// user plugins"));
    const parsed = parseConfig(config);
    assert.deepEqual(parsed.plugins, ["billion-context", "file:///opt/other", dirUrl(join(cwd, ".opencode", "plugins", "paradoc"))]);
    assert.equal(parsed.theme, "dark");
  });

  it("removes only ParaDoc's element from a shared singular plugin array", () => {
    const { root, distDir, home, env } = fixture();
    const cwd = join(root, "shared");
    const legacyShim = join(cwd, ".opencode", "plugins", "paradoc.js");
    mkdirSync(join(cwd, ".opencode", "plugins"), { recursive: true });
    writeFileSync(join(cwd, "opencode.jsonc"), `{
  "plugin": ["other-plugin", ${JSON.stringify(dirUrl(legacyShim))}, "third-plugin"],
  "theme": "dark"
}
`);
    install({ targets: ["opencode"], project: true, home, cwd, env, distDir });
    const parsed = parseConfig(readFileSync(join(cwd, "opencode.jsonc"), "utf8"));
    assert.deepEqual(parsed.plugins, [
      "other-plugin",
      "third-plugin",
      dirUrl(join(cwd, ".opencode", "plugins", "paradoc")),
    ]);
    assert.equal(parsed.theme, "dark");
  });

  it("leaves a user-owned plugins/paradoc.js file alone", () => {
    const { root, distDir, home, env } = fixture();
    const cwd = join(root, "owned");
    const pluginsRoot = join(cwd, ".opencode", "plugins");
    mkdirSync(pluginsRoot, { recursive: true });
    const userShim = join(pluginsRoot, "paradoc.js");
    writeFileSync(userShim, "export default { id: 'mine', setup() {} };\n");
    install({ targets: ["opencode"], project: true, home, cwd, env, distDir });
    assert.equal(readFileSync(userShim, "utf8"), "export default { id: 'mine', setup() {} };\n");
  });

  it("stamps the installed runtime with the version of the package that shipped dist", () => {
    const { root, distDir, home, env } = fixture();
    writeFileSync(join(root, "package.json"), '{"name":"@davidnagy/paradoc","version":"0.3.0"}\n');
    install({ targets: ["opencode", "copilot"], home, env, distDir });
    const runtime = join(home, ".local", "share", "paradoc");
    assert.equal(readFileSync(join(runtime, "package.json"), "utf8"), '{"type":"module","version":"0.3.0"}\n');
  });

  it("keeps the version-less runtime stamp when the shipped package.json is unreadable", () => {
    const { root, distDir, home, env } = fixture();
    writeFileSync(join(root, "package.json"), "{ not json");
    install({ targets: ["copilot"], home, env, distDir });
    assert.equal(readFileSync(join(home, ".local", "share", "paradoc", "package.json"), "utf8"), '{"type":"module"}\n');
  });

  describe("Copilot experimental settings", () => {
    const settingsOf = (home: string) => join(home, ".copilot", "settings.json");
    const wroteSettings = (lines: string[]) => lines.some((line) => line.startsWith("copilot-settings:"));

    it("creates settings.json with experimental enabled when the file is missing", () => {
      const { distDir, home, env } = fixture();
      const lines = install({ targets: ["copilot"], home, env, distDir });
      assert.ok(lines.includes(`copilot-settings: ${settingsOf(home)}`), lines.join(" | "));
      assert.deepEqual(JSON.parse(readFileSync(settingsOf(home), "utf8")), { experimental: true });
      // The file it just wrote is already enabled, so a re-run reports nothing further.
      const again = install({ targets: ["copilot"], home, env, distDir });
      assert.ok(!wroteSettings(again), "an enabled setting must not be rewritten");
    });

    it("inserts experimental into existing settings and preserves unrelated keys", () => {
      const { distDir, home, env } = fixture();
      mkdirSync(join(home, ".copilot"), { recursive: true });
      writeFileSync(settingsOf(home), '{\n  "model": "gpt-5",\n  "instructions": ["rules.md"]\n}\n');
      install({ targets: ["copilot"], home, env, distDir });
      const parsed = JSON.parse(readFileSync(settingsOf(home), "utf8")) as Record<string, unknown>;
      assert.equal(parsed.experimental, true);
      assert.equal(parsed.model, "gpt-5");
      assert.deepEqual(parsed.instructions, ["rules.md"]);
    });

    it("leaves an already-enabled experimental byte-identical across re-runs", () => {
      const { distDir, home, env } = fixture();
      mkdirSync(join(home, ".copilot"), { recursive: true });
      const original = '{\n  "experimental": true,\n  "model": "gpt-5"\n}\n';
      writeFileSync(settingsOf(home), original);
      const first = install({ targets: ["copilot"], home, env, distDir });
      assert.ok(!wroteSettings(first), "nothing to write when the flag is already on");
      assert.equal(readFileSync(settingsOf(home), "utf8"), original);
      install({ targets: ["copilot"], home, env, distDir });
      assert.equal(readFileSync(settingsOf(home), "utf8"), original);
    });

    it("reports an explicit false without overwriting the user's choice", () => {
      const { distDir, home, env } = fixture();
      mkdirSync(join(home, ".copilot"), { recursive: true });
      const original = '{\n  "experimental": false,\n  "model": "gpt-5"\n}\n';
      writeFileSync(settingsOf(home), original);
      const lines = install({ targets: ["copilot"], home, env, distDir });
      assert.equal(readFileSync(settingsOf(home), "utf8"), original, "an explicit false must survive");
      assert.ok(!wroteSettings(lines));
      const warning = lines.find((line) => line.includes("experimental is false"));
      assert.ok(warning, `expected a warning line, got: ${lines.join(" | ")}`);
      assert.ok(warning.includes(settingsOf(home)), warning);
      assert.ok(warning.includes("will not load"), warning);
    });

    it("repairs an empty settings file", () => {
      const { distDir, home, env } = fixture();
      mkdirSync(join(home, ".copilot"), { recursive: true });
      writeFileSync(settingsOf(home), "\n");
      install({ targets: ["copilot"], home, env, distDir });
      assert.deepEqual(JSON.parse(readFileSync(settingsOf(home), "utf8")), { experimental: true });
    });

    it("warns instead of rewriting a non-boolean experimental value", () => {
      const { distDir, home, env } = fixture();
      mkdirSync(join(home, ".copilot"), { recursive: true });
      const original = '{\n  "experimental": "yes",\n  "model": "gpt-5"\n}\n';
      writeFileSync(settingsOf(home), original);
      const lines = install({ targets: ["copilot"], home, env, distDir });
      assert.equal(readFileSync(settingsOf(home), "utf8"), original, "no duplicate key may be inserted");
      assert.ok(lines.some((line) => line.includes("unexpected value")), lines.join(" | "));
    });

    it("does not insert a duplicate key when the experimental member is already broken", () => {
      const { distDir, home, env } = fixture();
      mkdirSync(join(home, ".copilot"), { recursive: true });
      const original = '{\n  "experimental":,\n  "model": "gpt-5"\n}\n';
      writeFileSync(settingsOf(home), original);
      const lines = install({ targets: ["copilot"], home, env, distDir });
      assert.equal(readFileSync(settingsOf(home), "utf8"), original, "a broken member must not gain a second experimental key");
      assert.ok(lines.some((line) => line.includes("unexpected value")), lines.join(" | "));
    });

    it("throws naming an unparseable settings file without modifying it", () => {
      const { distDir, home, env } = fixture();
      mkdirSync(join(home, ".copilot"), { recursive: true });
      const file = settingsOf(home);
      writeFileSync(file, "not json at all");
      assert.throws(() => install({ targets: ["copilot"], home, env, distDir }), /Copilot settings is not a JSON object/);
      assert.equal(readFileSync(file, "utf8"), "not json at all");
    });
  });

  describe("MCP registration", () => {
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

    it("records PARADOC_COPILOT_BIN when a copilot binary is on PATH", () => {
      const { root, distDir, home, env } = fixture();
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "copilot"), "#!/bin/sh\n");
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}${delimiter}${previousPath}`;
      try {
        install({ targets: ["opencode"], home, env, distDir });
      } finally {
        process.env.PATH = previousPath;
      }
      const parsed = parseConfig(readFileSync(join(home, ".config", "opencode", "opencode.jsonc"), "utf8"));
      const server = parsed.mcp as { servers: { paradoc: { environment?: Record<string, string> } } };
      assert.equal(server.servers.paradoc.environment?.PARADOC_COPILOT_BIN, join(bin, "copilot"));
    });

    it("writes a marked OpenCode /paradoc command at global and project scope", () => {
      const global = fixture();
      const globalLines = install({ targets: ["opencode"], home: global.home, env: global.env, distDir: global.distDir });
      const globalCommand = join(global.home, ".config", "opencode", "commands", "paradoc.md");
      const globalText = readFileSync(globalCommand, "utf8");
      assert.ok(globalLines.includes(`opencode-command: ${globalCommand}`));
      assert.ok(globalText.includes("<!-- ParaDoc-generated command; safe to replace -->"));
      assert.ok(globalText.includes("paradoc_status") && globalText.includes("paradoc_set") && globalText.includes("paradoc_reset"));
      assert.ok(globalText.includes("$ARGUMENTS"));

      const project = fixture();
      const cwd = join(project.root, "project");
      const projectLines = install({ targets: ["opencode"], project: true, home: project.home, cwd, env: project.env, distDir: project.distDir });
      assert.ok(projectLines.includes(`opencode-command: ${join(cwd, ".opencode", "commands", "paradoc.md")}`));
    });

    it("rewrites its own OpenCode command but leaves a user-owned command untouched", () => {
      const generated = fixture();
      const command = join(generated.home, ".config", "opencode", "commands", "paradoc.md");
      install({ targets: ["opencode"], home: generated.home, env: generated.env, distDir: generated.distDir });
      writeFileSync(command, "<!-- ParaDoc-generated command; safe to replace -->\nstale");
      const rerun = install({ targets: ["opencode"], home: generated.home, env: generated.env, distDir: generated.distDir });
      assert.ok(rerun.includes(`opencode-command: ${command}`));
      assert.ok(readFileSync(command, "utf8").includes("paradoc_status"));

      const owned = fixture();
      const ownedCommand = join(owned.home, ".config", "opencode", "commands", "paradoc.md");
      mkdirSync(join(owned.home, ".config", "opencode", "commands"), { recursive: true });
      writeFileSync(ownedCommand, "# My command\nDo not replace\n");
      const lines = install({ targets: ["opencode"], home: owned.home, env: owned.env, distDir: owned.distDir });
      assert.equal(readFileSync(ownedCommand, "utf8"), "# My command\nDo not replace\n");
      assert.ok(!lines.some((line) => line.startsWith("opencode-command:")));
    });
  });
});
