import { deepStrictEqual, strictEqual } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { configPath, ModelSelector } from "../core/index.js";
import {
  createOpenCodeModelPicker,
} from "./model-picker.js";
import type {
  OpenCodePickerChoice,
  OpenCodePickerUi,
} from "./model-picker.js";

class ScriptedUi implements OpenCodePickerUi {
  readonly selectPrompts: Array<{ title: string; choices: OpenCodePickerChoice[] }> = [];
  readonly inputPrompts: Array<{ title: string; placeholder?: string }> = [];

  constructor(
    private readonly selectAnswers: Array<string | undefined> = [],
    private readonly inputAnswers: Array<string | undefined> = [],
  ) {}

  async select<T extends string>(prompt: {
    title: string;
    choices: OpenCodePickerChoice<T>[];
  }): Promise<T | undefined> {
    this.selectPrompts.push(prompt as { title: string; choices: OpenCodePickerChoice[] });
    return this.selectAnswers.shift() as T | undefined;
  }

  async input(prompt: { title: string; placeholder?: string }): Promise<string | undefined> {
    this.inputPrompts.push(prompt);
    return this.inputAnswers.shift();
  }
}

describe("createOpenCodeModelPicker", () => {
  const suggestions = [
    { providerID: "anthropic", modelID: "haiku" },
    { providerID: "openai", modelID: "gpt-mini" },
  ];

  it("returns a selected suggestion with global scope", async () => {
    const picker = createOpenCodeModelPicker(new ScriptedUi(["1", "global"]), { suggestions });

    deepStrictEqual(await picker.pick(), { choice: suggestions[1], scope: "global" });
  });

  it("parses a manual provider/model specification at the first slash", async () => {
    const picker = createOpenCodeModelPicker(
      new ScriptedUi(["manual", "project"], ["openrouter/anthropic/x"]),
      { suggestions },
    );

    deepStrictEqual(await picker.pick(), {
      choice: { providerID: "openrouter", modelID: "anthropic/x" },
      scope: "project",
    });
  });

  it("goes straight to input with no suggestions", async () => {
    const ui = new ScriptedUi(["global"], ["openai/gpt-mini"]);
    const result = await createOpenCodeModelPicker(ui).pick();

    deepStrictEqual(result, {
      choice: { providerID: "openai", modelID: "gpt-mini" },
      scope: "global",
    });
    strictEqual(ui.selectPrompts.length, 1);
    strictEqual(ui.inputPrompts.length, 1);
  });

  it("retries malformed manual input at most twice", async () => {
    const succeeds = createOpenCodeModelPicker(
      new ScriptedUi(["project"], ["bad", "/missing-provider", "openai/gpt-mini"]),
    );
    const exhausts = createOpenCodeModelPicker(
      new ScriptedUi([], ["bad", "also-bad", "still-bad"]),
    );

    deepStrictEqual(await succeeds.pick(), {
      choice: { providerID: "openai", modelID: "gpt-mini" },
      scope: "project",
    });
    strictEqual(await exhausts.pick(), undefined);
  });

  it("returns undefined when model or scope selection is cancelled", async () => {
    const modelCancelled = createOpenCodeModelPicker(new ScriptedUi([undefined]), { suggestions });
    const scopeCancelled = createOpenCodeModelPicker(
      new ScriptedUi(["manual", undefined], ["openai/gpt-mini"]),
      { suggestions },
    );

    strictEqual(await modelCancelled.pick(), undefined);
    strictEqual(await scopeCancelled.pick(), undefined);
  });

  it("describes the project scope as a gitignore candidate", async () => {
    const ui = new ScriptedUi(["project"], ["openai/gpt-mini"]);
    await createOpenCodeModelPicker(ui).pick();

    const project = ui.selectPrompts[0].choices.find((choice) => choice.value === "project");
    strictEqual(project?.description?.includes("gitignore"), true);
  });

  it("persists a picked value through ModelSelector without reopening the UI", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "context-lens-picker-project-"));
    const homeDir = mkdtempSync(join(tmpdir(), "context-lens-picker-home-"));
    const ui = new ScriptedUi(["project"], ["openrouter/anthropic/x"]);
    const selector = new ModelSelector({
      projectRoot,
      homeDir,
      env: {},
      picker: createOpenCodeModelPicker(ui),
    });

    try {
      deepStrictEqual(await selector.resolve(), {
        choice: { providerID: "openrouter", modelID: "anthropic/x" },
        source: "picker",
      });
      strictEqual(ui.inputPrompts.length, 1);
      strictEqual(ui.selectPrompts.length, 1);
      const path = configPath("project", { projectRoot, homeDir, env: {} });
      strictEqual(existsSync(path), true);
      strictEqual(await selector.resolve(), await selector.resolve());
      strictEqual(ui.inputPrompts.length, 1);
      strictEqual(ui.selectPrompts.length, 1);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
