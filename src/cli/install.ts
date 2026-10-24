import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildExtensionShim } from "../copilot-cli/extension-entry.js";

export type InstallTarget = "opencode" | "copilot";

export interface InstallOptions {
  targets: InstallTarget[];
  /** Install the opencode shim into `<cwd>/.opencode` instead of the global config dir. */
  project?: boolean;
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Built `dist/` directory to copy; defaults to the one this file was loaded from. */
  distDir?: string;
}

const DIST_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Copies the runtime (no tests/maps/types) to a stable dir, since `npx` caches are ephemeral. */
function installRuntime(distDir: string, dataDir: string): string {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  cpSync(distDir, join(dataDir, "dist"), {
    recursive: true,
    filter: (src) => !/\.(test\.js|js\.map|d\.ts|d\.ts\.map)$/.test(src),
  });
  writeFileSync(join(dataDir, "package.json"), '{"type":"module"}\n');
  return join(dataDir, "dist");
}

function registerOpenCodePlugin(configPath: string, shimPath: string): boolean {
  const specifier = JSON.stringify(pathToFileURL(shimPath).href);
  let config = "";
  try {
    config = readFileSync(configPath, "utf8");
  } catch {
    writeFileSync(configPath, `{
  "plugin": [${specifier}]
}
`);
    return true;
  }

  if (config.includes(specifier)) return false;

  const pluginArray = /("plugin"\s*:\s*\[)([\s\S]*?)(\])/.exec(config);
  if (pluginArray) {
    const close = pluginArray.index + pluginArray[0].length - 1;
    const body = pluginArray[2].trim();
    const insertion = body ? `, ${specifier}` : ` ${specifier} `;
    writeFileSync(configPath, `${config.slice(0, close)}${insertion}${config.slice(close)}`);
    return true;
  }

  const close = config.lastIndexOf("}");
  if (close < 0) throw new Error(`OpenCode config is not a JSON object: ${configPath}`);
  const before = config.slice(0, close).trimEnd();
  const comma = before.endsWith("{") || before.endsWith(",") ? "" : ",";
  writeFileSync(configPath, `${before}${comma}\n  "plugin": [${specifier}]\n${config.slice(close)}`);
  return true;
}

/** Yields each significant char (outside strings/comments) with its index; a string is yielded once as `"` with `end`. */
function* significant(text: string, from: number, to: number): Generator<{ i: number; ch: string; end: number }> {
  let i = from;
  while (i < to) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < to && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      yield { i, ch, end: j };
      i = j + 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? to : nl + 1;
    } else if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? to : close + 2;
    } else {
      if (!/\s/.test(ch)) yield { i, ch, end: i };
      i++;
    }
  }
}

/** Index of the `}` matching the `{` at `open`, or -1. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (const t of significant(text, open, text.length)) {
    if (t.ch === "{" || t.ch === "[") depth++;
    else if (t.ch === "}" || t.ch === "]") {
      depth--;
      if (depth === 0) return t.i;
    }
  }
  return -1;
}

/** Locates `{ ... }` bounds of the object-valued member `key` directly inside the object opened at `open`. */
function findObjectMember(text: string, open: number, key: string): { open: number; close: number } | undefined {
  const close = matchBrace(text, open);
  if (close < 0) return undefined;
  let depth = 0;
  const toks = [...significant(text, open, close + 1)];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.ch === "{" || t.ch === "[") depth++;
    else if (t.ch === "}" || t.ch === "]") depth--;
    else if (t.ch === '"' && depth === 1 && toks[k + 1]?.ch === ":" && JSON.parse(text.slice(t.i, t.end + 1)) === key) {
      const value = toks[k + 2];
      if (value?.ch !== "{") return undefined;
      return { open: value.i, close: matchBrace(text, value.i) };
    }
  }
  return undefined;
}

/** Inserts `member` as the first member of the object at `open`/`close`. */
function insertFirstMember(text: string, open: number, close: number, member: string): string {
  const nonEmpty = [...significant(text, open + 1, close)].length > 0;
  return `${text.slice(0, open + 1)} ${member}${nonEmpty ? "," : " "}${text.slice(open + 1)}`;
}

function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return undefined;
}

/**
 * Registers the stdio MCP server under `mcp.servers.paradoc`. Text insertion keeps JSONC comments intact.
 * A pre-existing `paradoc` server (even pointing elsewhere) is the user's entry and is left untouched.
 */
function registerOpenCodeMcp(configPath: string, mcpEntry: string): boolean {
  const config = readFileSync(configPath, "utf8");
  if (config.includes(JSON.stringify(mcpEntry))) return false;
  // OpenCode starts MCP servers with its own PATH, which may not include the Copilot CLI directory.
  const copilotBin = findOnPath("copilot");
  const environment = copilotBin ? `, "environment": {"PARADOC_COPILOT_BIN": ${JSON.stringify(copilotBin)}}` : "";
  const server = `"paradoc": {"type": "local", "command": ["node", ${JSON.stringify(mcpEntry)}]${environment}}`;

  const rootOpen = config.indexOf("{");
  const rootClose = config.lastIndexOf("}");
  if (rootOpen < 0 || rootClose < rootOpen) throw new Error(`OpenCode config is not a JSON object: ${configPath}`);

  const mcp = findObjectMember(config, rootOpen, "mcp");
  if (mcp) {
    const servers = findObjectMember(config, mcp.open, "servers");
    if (servers) {
      if (findObjectMember(config, servers.open, "paradoc")) return false;
      writeFileSync(configPath, insertFirstMember(config, servers.open, servers.close, server));
    } else {
      writeFileSync(configPath, insertFirstMember(config, mcp.open, mcp.close, `"servers": {${server}}`));
    }
    return true;
  }

  const before = config.slice(0, rootClose).trimEnd();
  const comma = before.endsWith("{") || before.endsWith(",") ? "" : ",";
  writeFileSync(configPath, `${before}${comma}\n  "mcp": {"servers": {${server}}}\n${config.slice(rootClose)}`);
  return true;
}

/** Registers the stdio MCP server in Copilot's plain-JSON config; an existing `paradoc` entry is kept. */
const OPENCODE_COMMAND_MARKER = "<!-- ParaDoc-generated command; safe to replace -->";

function openCodeCommand(): string {
  return [
    "---",
    "description: ParaDoc controls: status | set <key> <value> | reset [key] [--global]",
    "---",
    "",
    OPENCODE_COMMAND_MARKER,
    "",
    "Use the ParaDoc MCP control tools. Do not run shell commands or edit config files.",
    "",
    "Interpret `$ARGUMENTS` as one of:",
    "- empty or `status`: call `paradoc_status` with no arguments.",
    "- `set <key> <value> [--global|--project]`: call `paradoc_set` with `key`, `value`, and optional `scope`.",
    "- `reset [key] [--global|--project]`: call `paradoc_reset` with optional `key` and `scope`.",
    "",
    "Report the tool output verbatim. If the arguments do not match a subcommand, report the control usage from the tool without guessing.",
    "",
  ].join("\n");
}

/** Writes only ParaDoc's marked command template; user-owned commands are never replaced. */
function writeOpenCodeCommand(dir: string): string | undefined {
  const commandPath = join(dir, "commands", "paradoc.md");
  if (existsSync(commandPath) && !readFileSync(commandPath, "utf8").includes(OPENCODE_COMMAND_MARKER)) return undefined;
  mkdirSync(dirname(commandPath), { recursive: true });
  writeFileSync(commandPath, openCodeCommand());
  return commandPath;
}

function registerCopilotMcp(configPath: string, mcpEntry: string): boolean {
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      config = parsed as Record<string, unknown>;
    } catch {
      throw new Error(`Copilot MCP config is not valid JSON: ${configPath}`);
    }
  }
  const raw = config.mcpServers;
  const servers = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  if ("paradoc" in servers) return false;
  servers.paradoc = { type: "local", command: "node", args: [mcpEntry], tools: ["*"] };
  config.mcpServers = servers;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

/** Returns one human-readable line per file written. */
export function install(options: InstallOptions): string[] {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  const runtime = installRuntime(options.distDir ?? DIST_DEFAULT, join(dataHome, "paradoc"));
  const mcpEntry = join(runtime, "copilot-cli", "mcp-entry.js");
  const written = [`runtime: ${runtime}`];

  for (const target of options.targets) {
    if (target === "opencode") {
      const dir = options.project ? join(cwd, ".opencode") : join(configHome, "opencode");
      const url = pathToFileURL(join(runtime, "opencode", "plugin-v2.js")).href;
      mkdirSync(join(dir, "plugins"), { recursive: true });
      const shim = join(dir, "plugins", "paradoc.js");
      writeFileSync(shim, `export { ParaDocV2Plugin as default } from ${JSON.stringify(url)};\n`);
      const configPath = options.project ? join(cwd, "opencode.jsonc") : join(dir, "opencode.jsonc");
      registerOpenCodePlugin(configPath, shim);
      registerOpenCodeMcp(configPath, mcpEntry);
      const command = writeOpenCodeCommand(dir);
      written.push(`opencode: ${shim}`);
      written.push(`opencode-config: ${configPath}`);
      written.push(`opencode-mcp: ${configPath}`);
      if (command) written.push(`opencode-command: ${command}`);
    } else {
      const dir = join(home, ".copilot", "extensions", "paradoc");
      mkdirSync(dir, { recursive: true });
      const shim = join(dir, "extension.mjs");
      writeFileSync(shim, buildExtensionShim(join(runtime, "copilot-cli", "extension-entry.js")));
      written.push(`copilot: ${shim}`);
      const mcpConfig = join(home, ".copilot", "mcp-config.json");
      registerCopilotMcp(mcpConfig, mcpEntry);
      written.push(`copilot-mcp: ${mcpConfig}`);
    }
  }
  return written;
}
