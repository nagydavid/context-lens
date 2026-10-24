import { configPath } from "./config.js";
import type { ConfigOptions, ModelChoice } from "./config.js";
import type { InterceptStats } from "./interceptor.js";
import type { ResolvedModelSource } from "./model-selector.js";
import type { TuningSettings, TuningSource } from "./tuning.js";

/** Where the effective model choice came from. "picker" means a picker is configured but nothing is stored yet. */
export type StatusModelSource = "explicit" | ResolvedModelSource | "picker" | "none";

export type TuningSourceMap = Record<keyof TuningSettings, TuningSource>;

/** One inspectable snapshot of effective settings, provenance, model choice, config paths and stats. */
export interface ParadocStatus {
  settings: TuningSettings;
  sources: TuningSourceMap;
  model: { choice?: ModelChoice; source: StatusModelSource };
  configPaths: { project: string; global: string };
  /** Running interceptor totals; absent when no interceptor has been built for this root. */
  stats?: InterceptStats;
  /** Warnings surfaced while building the snapshot (malformed config, ignored values). */
  warnings: string[];
}

export interface StatusInput {
  settings: TuningSettings;
  sources: TuningSourceMap;
  model: { choice?: ModelChoice; source: StatusModelSource };
  configPaths: { project: string; global: string };
  stats?: InterceptStats;
  warnings?: readonly string[];
}

/** Assemble a status snapshot from already-resolved parts. Inputs are copied so callers cannot mutate the snapshot. */
export function buildStatus(input: StatusInput): ParadocStatus {
  const status: ParadocStatus = {
    settings: { ...input.settings },
    sources: { ...input.sources },
    model: { ...(input.model.choice ? { choice: { ...input.model.choice } } : {}), source: input.model.source },
    configPaths: { ...input.configPaths },
    warnings: [...(input.warnings ?? [])],
  };
  if (input.stats) status.stats = { ...input.stats };
  return status;
}

/** Config paths for both scopes, resolved the same way loadTuning and the model selector resolve them. */
export function statusConfigPaths(options: ConfigOptions = {}): { project: string; global: string } {
  return { project: configPath("project", options), global: configPath("global", options) };
}
