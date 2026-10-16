import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ModelChoice {
  providerID: string;
  modelID: string;
  endpoint?: string;
}

export type ConfigScope = "project" | "global";
export type ModelSource = "env" | ConfigScope;

export interface StoredModel {
  choice: ModelChoice;
  source: ModelSource;
  path?: string;
}

export interface ConfigOptions {
  projectRoot?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  onWarning?: (message: string) => void;
}

function resolvedOptions(options: ConfigOptions = {}): Required<
  Pick<ConfigOptions, "projectRoot" | "homeDir" | "env">
> {
  return {
    projectRoot: options.projectRoot ?? process.cwd(),
    homeDir: options.homeDir ?? homedir(),
    env: options.env ?? process.env,
  };
}

function warn(options: ConfigOptions, message: string): void {
  try {
    options.onWarning?.(message);
  } catch {
    // Warning callbacks must not affect configuration resolution.
  }
}

export function configPath(scope: ConfigScope, options: ConfigOptions = {}): string {
  const { projectRoot, homeDir, env } = resolvedOptions(options);
  if (scope === "project") return join(projectRoot, ".context-lens", "config.json");

  const configHome = env.XDG_CONFIG_HOME || join(homeDir, ".config");
  return join(configHome, "context-lens", "config.json");
}

export function validateModelChoice(value: unknown): ModelChoice | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.providerID !== "string" || typeof candidate.modelID !== "string") {
    return undefined;
  }

  const providerID = candidate.providerID.trim();
  const modelID = candidate.modelID.trim();
  if (!providerID || !modelID) return undefined;

  if ("endpoint" in candidate) {
    if (typeof candidate.endpoint !== "string") return undefined;
    return { providerID, modelID, endpoint: candidate.endpoint };
  }

  return { providerID, modelID };
}

export function parseModelSpec(spec: string): ModelChoice | undefined {
  const trimmed = spec.trim();
  const separator = trimmed.indexOf("/");
  if (separator === -1) return undefined;

  return validateModelChoice({
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  });
}

function loadFile(path: string, source: ConfigScope, options: ConfigOptions): StoredModel | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error: unknown) {
    if (isMissingFile(error)) return undefined;
    warn(options, `context-lens: ignoring ${path}: ${errorMessage(error)}`);
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn(options, `context-lens: ignoring ${path}: invalid JSON`);
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warn(options, `context-lens: ignoring ${path}: invalid config`);
    return undefined;
  }

  const config = parsed as Record<string, unknown>;
  if (config.version !== 1) {
    warn(options, `context-lens: ignoring ${path}: unsupported version`);
    return undefined;
  }

  const choice = validateModelChoice(config.model);
  if (!choice) {
    warn(options, `context-lens: ignoring ${path}: invalid model`);
    return undefined;
  }

  return { choice, source, path };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function loadModelConfig(options: ConfigOptions = {}): StoredModel | undefined {
  try {
    const env = resolvedOptions(options).env;
    const modelSpec = env.CONTEXT_LENS_MODEL;
    if (modelSpec !== undefined) {
      const choice = parseModelSpec(modelSpec);
      if (choice) return { choice, source: "env" };
      warn(options, "context-lens: ignoring CONTEXT_LENS_MODEL: invalid model spec");
    }

    return (
      loadFile(configPath("project", options), "project", options) ??
      loadFile(configPath("global", options), "global", options)
    );
  } catch (error: unknown) {
    warn(options, `context-lens: could not load model config: ${errorMessage(error)}`);
    return undefined;
  }
}

export function saveModelConfig(
  choice: ModelChoice,
  scope: ConfigScope,
  options: ConfigOptions = {},
): string {
  const validated = validateModelChoice(choice);
  if (!validated) throw new Error("Invalid model choice");

  const path = configPath(scope, options);
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;

  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ version: 1, model: validated }, null, 2)}\n`,
      "utf8",
    );
    renameSync(temporaryPath, path);
    return path;
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}
