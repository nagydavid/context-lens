import {
  loadModelConfig,
  saveModelConfig,
  validateModelChoice,
} from "./config.js";
import type {
  ConfigOptions,
  ConfigScope,
  ModelChoice,
  ModelSource,
} from "./config.js";

export interface ModelPickResult {
  choice: ModelChoice;
  scope: ConfigScope;
}

export interface ModelPicker {
  pick(): Promise<ModelPickResult | undefined>;
}

export type ResolvedModelSource = ModelSource | "picker";

export interface ResolvedModel {
  choice: ModelChoice;
  source: ResolvedModelSource;
}

export interface ModelSelectorOptions extends ConfigOptions {
  picker?: ModelPicker;
}

/** Resolves one model choice per selector instance, prompting at most once after a cancellation. */
export class ModelSelector {
  private cached: ResolvedModel | undefined;
  private declined = false;
  private inFlight: Promise<ResolvedModel | undefined> | undefined;

  constructor(private readonly options: ModelSelectorOptions = {}) {
    this.resolve = this.resolve.bind(this);
  }

  resolve(): Promise<ResolvedModel | undefined> {
    if (this.cached) return Promise.resolve(this.cached);
    if (this.declined) return Promise.resolve(undefined);
    if (this.inFlight) return this.inFlight;

    const promise = this.resolveUncached().finally(() => {
      if (this.inFlight === promise) this.inFlight = undefined;
    });
    this.inFlight = promise;
    return promise;
  }

  private async resolveUncached(): Promise<ResolvedModel | undefined> {
    try {
      const stored = loadModelConfig(this.options);
      if (stored) {
        this.cached = { choice: stored.choice, source: stored.source };
        return this.cached;
      }

      const picker = this.options.picker;
      if (!picker) return undefined;

      let picked: ModelPickResult | undefined;
      try {
        picked = await picker.pick();
      } catch (error: unknown) {
        this.warn(`paradoc: could not pick model: ${errorMessage(error)}`);
        return undefined;
      }

      if (!picked) {
        this.declined = true;
        return undefined;
      }

      const choice = validateModelChoice(picked.choice);
      if (!choice) {
        this.warn("paradoc: ignoring invalid model choice from picker");
        this.declined = true;
        return undefined;
      }

      try {
        saveModelConfig(choice, picked.scope, this.options);
      } catch (error: unknown) {
        this.warn(`paradoc: could not save model config: ${errorMessage(error)}`);
      }

      this.cached = { choice, source: "picker" };
      return this.cached;
    } catch (error: unknown) {
      this.warn(`paradoc: could not resolve model: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private warn(message: string): void {
    try {
      this.options.onWarning?.(message);
    } catch {
      // Consumer warning handlers must not make resolution reject.
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}
