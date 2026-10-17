import {
  parseModelSpec,
  validateModelChoice,
} from "../core/index.js";
import type {
  ConfigScope,
  ModelChoice,
  ModelPicker,
} from "../core/index.js";

export interface OpenCodePickerChoice<T extends string = string> {
  label: string;
  value: T;
  description?: string;
}

export interface OpenCodePickerUi {
  select<T extends string>(prompt: {
    title: string;
    choices: OpenCodePickerChoice<T>[];
  }): Promise<T | undefined>;
  input(prompt: {
    title: string;
    placeholder?: string;
  }): Promise<string | undefined>;
}

export interface OpenCodeModelPickerOptions {
  suggestions?: ModelChoice[];
}

const PROJECT_SCOPE: OpenCodePickerChoice<ConfigScope> = {
  label: "Project",
  value: "project",
  description: "Save to .paradoc/config.json in this project; you may want to gitignore it.",
};

const GLOBAL_SCOPE: OpenCodePickerChoice<ConfigScope> = {
  label: "Global",
  value: "global",
  description: "Save to ~/.config/paradoc/config.json.",
};

/** Builds a picker around OpenCode UI primitives without imposing model defaults. */
export function createOpenCodeModelPicker(
  ui: OpenCodePickerUi,
  options: OpenCodeModelPickerOptions = {},
): ModelPicker {
  return {
    async pick() {
      const choice = await selectChoice(ui, options.suggestions ?? []);
      if (!choice) return undefined;

      const scope = await ui.select({
        title: "Where should ParaDoc save this model?",
        choices: [PROJECT_SCOPE, GLOBAL_SCOPE],
      });
      if (!scope) return undefined;

      return { choice, scope };
    },
  };
}

async function selectChoice(
  ui: OpenCodePickerUi,
  suggestions: ModelChoice[],
): Promise<ModelChoice | undefined> {
  if (suggestions.length) {
    const choices: OpenCodePickerChoice[] = suggestions.map((suggestion, index) => ({
      label: `${suggestion.providerID}/${suggestion.modelID}`,
      value: String(index),
      ...(suggestion.endpoint ? { description: suggestion.endpoint } : {}),
    }));
    choices.push({
      label: "Enter provider/model…",
      value: "manual",
    });

    const selected = await ui.select({
      title: "Choose a cheap model for ParaDoc",
      choices,
    });
    if (selected === undefined) return undefined;
    if (selected !== "manual") {
      const suggestion = suggestions[Number(selected)];
      return validateModelChoice(suggestion);
    }
  }

  return enterManualChoice(ui);
}

async function enterManualChoice(ui: OpenCodePickerUi): Promise<ModelChoice | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const spec = await ui.input({
      title: "Enter a provider/model identifier",
      placeholder: "provider/model",
    });
    if (spec === undefined) return undefined;

    const choice = parseModelSpec(spec);
    if (choice) return choice;
  }
  return undefined;
}
