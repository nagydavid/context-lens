import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

/** Returns one human-readable line per file written. */
export function install(options: InstallOptions): string[] {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  const runtime = installRuntime(options.distDir ?? DIST_DEFAULT, join(dataHome, "paradoc"));
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
      written.push(`opencode: ${shim}`);
      written.push(`opencode-config: ${configPath}`);
    } else {
      const dir = join(home, ".copilot", "extensions", "paradoc");
      mkdirSync(dir, { recursive: true });
      const shim = join(dir, "extension.mjs");
      writeFileSync(shim, buildExtensionShim(join(runtime, "copilot-cli", "extension-entry.js")));
      written.push(`copilot: ${shim}`);
    }
  }
  return written;
}
