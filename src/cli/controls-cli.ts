import { loadModelConfig } from "../core/config.js";
import type { ConfigOptions } from "../core/config.js";
import {
  CONTROL_USAGE,
  applyReset,
  applySet,
  parseControlArgs,
  renderChange,
  renderStatus,
  type ChangeResult,
} from "../core/controls.js";
import { buildStatus, statusConfigPaths } from "../core/status.js";
import { loadTuning } from "../core/tuning.js";

/**
 * CLI binding of the host-agnostic control contract (src/core/controls.ts).
 *
 * This module is the deterministic, scriptable surface: it maps a control action onto
 * stdout/stderr and an exit code, and nothing else. All parsing, validation, persistence
 * and rendering happen in controls.ts, so the CLI, the MCP tools and the slash commands
 * cannot drift.
 */

/** Where the CLI resolves config. Mirrors ConfigOptions so hosts and tests inject a temp root. */
export interface ControlCliOptions {
  /** Project root for the project-scope config file. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Environment used for env-scope tuning and XDG paths. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Home dir for the global-scope config file. Defaults to `os.homedir()`. */
  homeDir?: string;
}

export interface ControlCliResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Subcommands handled by the control seam (everything else is `install` or a usage error). */
export const CONTROL_COMMANDS = ["status", "set", "reset"] as const;

export function isControlCommand(command: string | undefined): command is (typeof CONTROL_COMMANDS)[number] {
  return command !== undefined && (CONTROL_COMMANDS as readonly string[]).includes(command);
}

function optionsFor(options: ControlCliOptions, warnings: string[]): ConfigOptions {
  return {
    projectRoot: options.cwd ?? process.cwd(),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    onWarning: (message: string) => {
      warnings.push(message);
    },
  };
}

/**
 * Status snapshot for one root, built through the same resolution `HostRuntime.getStatus`
 * performs (loadTuning + stored model + config paths), deliberately without an interceptor,
 * cache or runner: a CLI invocation has no interception history to report, and constructing
 * one would make `status` need a subagent runner it never uses.
 */
function statusText(options: ControlCliOptions, warnings: string[]): string {
  const config = optionsFor(options, warnings);
  const { settings, sources } = loadTuning(config);
  const stored = loadModelConfig(config);
  return renderStatus(
    buildStatus({
      settings,
      sources,
      model: stored ? { choice: stored.choice, source: stored.source } : { source: "none" },
      configPaths: statusConfigPaths(config),
      warnings,
    }),
  );
}

/** Write failures are reported like every other ParaDoc diagnostic and never as a stack trace. */
function failure(message: string): ControlCliResult {
  const text = message.startsWith("paradoc:") ? message : `paradoc: ${message}`;
  return { stdout: "", stderr: `${text}\n`, code: 1 };
}

function change(action: "set" | "reset", result: ChangeResult, warnings: string[]): ControlCliResult {
  if (!result.ok) return failure(result.message);
  const stderr = warnings.length > 0 ? `${warnings.map((w) => (w.startsWith("paradoc:") ? w : `paradoc: ${w}`)).join("\n")}\n` : "";
  return { stdout: `${renderChange(action, result)}\n`, stderr, code: 0 };
}

/**
 * Run one control command. `argv` is the argument vector after the binary name
 * (e.g. `["set", "thresholdLines", "500", "--global"]`); it is handed to the shared
 * parser exactly as a slash command's raw argument text would be.
 *
 * Exit codes: 0 success, 2 bad usage (usage text on stderr), 1 write/read failure.
 */
export function runControlCommand(argv: readonly string[], options: ControlCliOptions = {}): ControlCliResult {
  const action = parseControlArgs(argv.join(" "));

  switch (action.action) {
    case "status": {
      const warnings: string[] = [];
      return { stdout: `${statusText(options, warnings)}\n`, stderr: "", code: 0 };
    }
    case "set": {
      const warnings: string[] = [];
      const result = applySet({ [action.key]: action.value }, action.scope, optionsFor(options, warnings));
      return change("set", result, warnings);
    }
    case "reset": {
      const warnings: string[] = [];
      const result = applyReset(action.scope, optionsFor(options, warnings), action.key ? [action.key] : undefined);
      return change("reset", result, warnings);
    }
    default:
      return { stdout: "", stderr: `${action.message}\n`, code: 2 };
  }
}

export { CONTROL_USAGE };
