import type { ConfigOptions, ConfigScope } from "./config.js";
import type { JudgeMode } from "./judge.js";
import type { ParadocStatus } from "./status.js";
import { clearTuning, saveTuning } from "./tuning-write.js";
import {
  TUNING_KEYS,
  isTuningKey,
  validateTuningValue,
  type TuningKey,
  type TuningSettings,
} from "./tuning.js";

/**
 * Host-agnostic control contract for the `/paradoc` surface.
 *
 * Every host (CLI subcommand, MCP tool, Copilot slash command, OpenCode command
 * template) parses, validates, persists and renders through these functions so the
 * three surfaces cannot drift. Nothing here knows about a host: no argv, no exit
 * codes, no transport. Hosts map `action`/`result` onto their own error channel
 * (exit code, `isError`, thrown Error).
 */

/** One line of usage text shared by every host's error output. */
export const CONTROL_USAGE = [
  "usage: paradoc status | paradoc set <key> <value> [--global|--project] | paradoc reset [key] [--global|--project]",
  `keys: ${TUNING_KEYS.join(", ")}`,
  "example: paradoc set thresholdLines 500",
].join("\n");

/** Hint printed after a successful write: config is read at host startup. */
export const RESTART_HINT = "restart the host to apply this in the current session";

/** Source precedence shown in status output (highest first). */
export const SOURCE_PRECEDENCE = "explicit > env > project > global > default";

/** A parsed `/paradoc` request. `error` carries the actionable message to show the user. */
export type ControlAction =
  | { action: "status" }
  | { action: "set"; key: TuningKey; value: number | JudgeMode; scope: ConfigScope }
  | { action: "reset"; key?: TuningKey; scope: ConfigScope }
  | { action: "error"; message: string };

/** Outcome of a write: the path written (undefined = nothing changed) or a message. */
export type ChangeResult = { ok: true; path?: string } | { ok: false; message: string };

const SCOPE_FLAGS: Record<string, ConfigScope> = {
  "--global": "global",
  "--project": "project",
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parse errors are prefixed like every other ParaDoc diagnostic and always carry usage + keys + example. */
function controlError(detail: string): ControlAction {
  return { action: "error", message: `paradoc: ${detail}\n${CONTROL_USAGE}` };
}

function usageOnly(): ControlAction {
  return { action: "error", message: CONTROL_USAGE };
}

function tokenize(raw: string | undefined): string[] {
  return (raw ?? "").trim().split(/\s+/).filter((token) => token.length > 0);
}

/** Split scope flags from positional arguments. Returns undefined and sets `error` on a bad flag. */
function splitScope(
  tokens: readonly string[],
): { positionals: string[]; scope: ConfigScope } | { error: ControlAction } {
  const positionals: string[] = [];
  let scope: ConfigScope = "project";
  let scopeSeen = false;
  for (const token of tokens) {
    const flag = SCOPE_FLAGS[token];
    if (flag !== undefined) {
      if (scopeSeen && flag !== scope) {
        return { error: controlError("--global and --project cannot be combined") };
      }
      scope = flag;
      scopeSeen = true;
      continue;
    }
    if (token.startsWith("-")) {
      return { error: controlError(`unknown option "${token}"`) };
    }
    positionals.push(token);
  }
  return { positionals, scope };
}

/** Coerce one raw token to a validated value with the same rules loadTuning applies. */
function coerceValue(key: TuningKey, raw: string): { ok: true; value: number | JudgeMode } | { ok: false; reason: string } {
  const text = raw.trim();
  if (key === "judge") return validateTuningValue(key, text);
  // `off` mirrors the PARADOC_CACHE=off env spelling: caching disabled.
  if (key === "cacheMaxEntries" && text === "off") return { ok: true, value: 0 };
  if (!/^\d+$/.test(text)) {
    return {
      ok: false,
      reason: key === "cacheMaxEntries" ? "expected an integer >= 0 or \"off\"" : "expected an integer",
    };
  }
  return validateTuningValue(key, Number(text));
}

function parseSet(tokens: readonly string[]): ControlAction {
  const split = splitScope(tokens);
  if ("error" in split) return split.error;
  const { positionals, scope } = split;

  if (positionals.length === 0) return controlError("set needs a key and a value");
  if (positionals.length === 1) return controlError(`set needs a value for ${positionals[0]}`);
  if (positionals.length > 2) return controlError(`unexpected extra argument "${positionals[2]}"`);

  const [rawKey, rawValue] = positionals;
  if (!isTuningKey(rawKey)) return controlError(`unknown key "${rawKey}"`);
  const coerced = coerceValue(rawKey, rawValue);
  if (!coerced.ok) return controlError(`invalid value "${rawValue}" for ${rawKey}: ${coerced.reason}`);
  return { action: "set", key: rawKey, value: coerced.value, scope };
}

function parseReset(tokens: readonly string[]): ControlAction {
  const split = splitScope(tokens);
  if ("error" in split) return split.error;
  const { positionals, scope } = split;

  if (positionals.length > 1) return controlError(`reset takes at most one key, got ${positionals.join(" ")}`);
  const key = positionals[0];
  if (key !== undefined && !isTuningKey(key)) return controlError(`unknown key "${key}"`);
  return key === undefined ? { action: "reset", scope } : { action: "reset", key, scope };
}

/**
 * Parse the argument text of a `/paradoc` request (slash-command args, CLI argv tail,
 * or MCP tool arguments joined). Empty input means `status`, which is what the OpenCode
 * command template relies on. Errors are actionable: they name the accepted keys and
 * show an example.
 */
export function parseControlArgs(raw: string | undefined): ControlAction {
  const [first, ...rest] = tokenize(raw);

  if (first === undefined) return { action: "status" };
  if (first === "status") {
    if (rest.length > 0) return controlError(`status takes no key or scope, got ${rest.join(" ")}`);
    return { action: "status" };
  }
  if (first === "set") return parseSet(rest);
  if (first === "reset") return parseReset(rest);
  if (first === "help" || first === "-h" || first === "--help") return usageOnly();
  return controlError(`unknown command "${first}"`);
}

/** Thin wrapper over saveTuning: never throws, returns the written path or a message. */
export function applySet(
  partial: Partial<TuningSettings>,
  scope: ConfigScope,
  options: ConfigOptions = {},
): ChangeResult {
  try {
    return { ok: true, path: saveTuning(partial, scope, options) };
  } catch (error: unknown) {
    return { ok: false, message: messageOf(error) };
  }
}

/** Thin wrapper over clearTuning: never throws; `path` is undefined when nothing changed. */
export function applyReset(
  scope: ConfigScope,
  options: ConfigOptions = {},
  keys?: readonly TuningKey[],
): ChangeResult {
  try {
    return { ok: true, path: clearTuning(scope, options, keys) };
  } catch (error: unknown) {
    return { ok: false, message: messageOf(error) };
  }
}

function statsLines(stats: NonNullable<ParadocStatus["stats"]>): string[] {
  return [
    `stats: intercepted=${stats.intercepted} passthrough=${stats.passthrough} bypassed=${stats.bypassed} fallbacks=${stats.fallbacks} cacheHits=${stats.cacheHits}`,
    `stats: delegations=${stats.delegations} delegationMs=${stats.delegationMs} estTokensSaved=${stats.estTokensSaved} estTokensDelegated=${stats.estTokensDelegated}`,
  ];
}

/**
 * The single status rendering used by the CLI, the MCP tools and the slash-command
 * handler: every setting with the source that won, the model choice and its source,
 * both config paths (a wrong spawn cwd is then self-evident), interceptor counters
 * when an interceptor exists for this root, and any warnings.
 */
export function renderStatus(status: ParadocStatus): string {
  const keyWidth = TUNING_KEYS.reduce((max, key) => Math.max(max, key.length), 0);
  const lines: string[] = ["ParaDoc status", `settings (source precedence: ${SOURCE_PRECEDENCE})`];

  for (const key of TUNING_KEYS) {
    lines.push(`  ${key.padEnd(keyWidth)}  ${String(status.settings[key]).padEnd(6)}  ${status.sources[key]}`);
  }

  const model = status.model.choice
    ? `${status.model.choice.providerID}/${status.model.choice.modelID}`
    : "none";
  lines.push(`model: ${model}  ${status.model.source}`);
  lines.push(`config (project): ${status.configPaths.project}`);
  lines.push(`config (global):  ${status.configPaths.global}`);

  if (status.stats) lines.push(...statsLines(status.stats));

  if (status.warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of status.warnings) lines.push(`  ${warning}`);
  }

  return lines.join("\n");
}

/** One-line-per-write rendering of a set/reset result, plus the restart hint. */
export function renderChange(action: "set" | "reset", result: ChangeResult): string {
  if (!result.ok) return result.message;
  if (result.path === undefined) return action === "reset" ? "nothing to reset" : "nothing changed";
  return `wrote ${result.path}\n${RESTART_HINT}`;
}
