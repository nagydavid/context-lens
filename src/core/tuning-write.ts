import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "./config.js";
import type { ConfigOptions, ConfigScope } from "./config.js";
import { errorMessage, isRecord } from "./host-runtime.js";
import {
  TUNING_KEYS,
  isTuningKey,
  validateTuningValue,
  type TuningKey,
  type TuningSettings,
} from "./tuning.js";

/**
 * Canonical tuning write seam.
 *
 * Hosts (the `/paradoc set` / `/paradoc reset` bindings) must go through these two
 * functions so validation, config-shape preservation and atomic writes happen in one
 * place. Reads stay in tuning.ts (loadTuning); nothing else writes the tuning block.
 */

type WrittenValue = number | TuningSettings["judge"];

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Read the config file we are about to rewrite.
 * Missing file is an empty object; anything unparseable or malformed throws, because
 * silently replacing a config the user hand-wrote would destroy their settings.
 */
function readExistingConfig(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error: unknown) {
    if (isMissingFile(error)) return {};
    throw new Error(`paradoc: refusing to overwrite ${path}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`paradoc: refusing to overwrite ${path}: invalid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`paradoc: refusing to overwrite ${path}: invalid config`);
  }
  if (parsed.version !== 1) {
    throw new Error(`paradoc: refusing to overwrite ${path}: unsupported version`);
  }
  if (parsed.tuning !== undefined && !isRecord(parsed.tuning)) {
    throw new Error(`paradoc: refusing to overwrite ${path}: invalid tuning`);
  }
  return parsed;
}

function tuningBlock(config: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(config.tuning) ? config.tuning : undefined;
}

/** Validate every key before anything touches the filesystem. */
function validatePartial(partial: Partial<TuningSettings>): Map<TuningKey, WrittenValue> {
  const entries = Object.entries(partial ?? {});
  const validated = new Map<TuningKey, WrittenValue>();

  for (const [key, value] of entries) {
    if (value === undefined) continue;
    if (!isTuningKey(key)) {
      throw new Error(`paradoc: unknown tuning key "${key}": expected one of ${TUNING_KEYS.join(", ")}`);
    }
    const result = validateTuningValue(key, value);
    if (!result.ok) {
      throw new Error(`paradoc: invalid tuning value for ${key}: ${result.reason}`);
    }
    validated.set(key, result.value);
  }

  if (validated.size === 0) {
    throw new Error(`paradoc: saveTuning needs at least one tuning key: expected one of ${TUNING_KEYS.join(", ")}`);
  }
  return validated;
}

/**
 * The chunk overlap rule loadTuning applies is mirrored here so a written block is
 * never internally inconsistent (which would make loadTuning warn on every read).
 */
function assertChunkConsistency(merged: Record<string, unknown>): void {
  const chunkLines = merged.chunkLines;
  const overlap = merged.chunkOverlapLines;
  if (typeof chunkLines !== "number" || typeof overlap !== "number" || chunkLines <= 0) return;
  if (overlap >= chunkLines) {
    throw new Error(
      `paradoc: invalid tuning value for chunkOverlapLines: must be smaller than chunkLines (${chunkLines}); set or clear chunkOverlapLines`,
    );
  }
}

/** Atomic write mirroring saveModelConfig: tmp file in the same directory, then rename. */
function writeConfig(path: string, config: Record<string, unknown>): string {
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, path);
    return path;
  } catch (error: unknown) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may never have been created.
    }
    throw error;
  }
}

/**
 * Merge validated values into the `tuning` block of one scope's config file.
 * `model`, `version` and unknown top-level keys are preserved; the written path is returned.
 */
export function saveTuning(
  partial: Partial<TuningSettings>,
  scope: ConfigScope,
  options: ConfigOptions = {},
): string {
  const validated = validatePartial(partial);
  const path = configPath(scope, options);
  const config = readExistingConfig(path);
  const merged: Record<string, unknown> = { ...tuningBlock(config) };
  for (const [key, value] of validated) merged[key] = value;
  assertChunkConsistency(merged);
  return writeConfig(path, { ...config, version: 1, tuning: merged });
}

/**
 * Remove tuning keys from one scope's config file, or the whole `tuning` block when
 * `keys` is omitted. Other file content is left intact, no file is created when none
 * exists, and a no-op clear does not rewrite the file. Returns the path written, or
 * undefined when nothing changed.
 */
export function clearTuning(
  scope: ConfigScope,
  options: ConfigOptions = {},
  keys?: readonly (keyof TuningSettings)[],
): string | undefined {
  if (keys !== undefined) {
    for (const key of keys) {
      if (!isTuningKey(key)) {
        throw new Error(`paradoc: unknown tuning key "${String(key)}": expected one of ${TUNING_KEYS.join(", ")}`);
      }
    }
  }

  const path = configPath(scope, options);
  const config = readExistingConfig(path);
  const block = tuningBlock(config);
  if (!block) return undefined;

  if (keys === undefined) {
    const { tuning: _tuning, ...rest } = config;
    return writeConfig(path, rest);
  }

  const merged: Record<string, unknown> = { ...block };
  let removed = 0;
  for (const key of keys) {
    if (key in merged) {
      delete merged[key];
      removed += 1;
    }
  }
  if (removed === 0) return undefined;

  if (Object.keys(merged).length === 0) {
    const { tuning: _tuning, ...rest } = config;
    return writeConfig(path, rest);
  }
  return writeConfig(path, { ...config, tuning: merged });
}
