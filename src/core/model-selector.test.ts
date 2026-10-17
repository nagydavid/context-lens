import { deepStrictEqual, strictEqual } from "node:assert";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configPath, saveModelConfig } from "./config.js";
import { ModelSelector } from "./model-selector.js";
import type { ModelPickResult, ModelPicker } from "./model-selector.js";

interface Fixture {
  projectRoot: string;
  homeDir: string;
}

const fixtures: string[] = [];
const choice = { providerID: "openrouter", modelID: "anthropic/cheap", endpoint: "https://models.test" };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "paradoc-selector-"));
  fixtures.push(root);
  return { projectRoot: join(root, "project"), homeDir: join(root, "home") };
}

function options(paths: Fixture) {
  return { ...paths, env: {} };
}

class CountingPicker implements ModelPicker {
  calls = 0;

  constructor(private readonly pickResult: () => Promise<ModelPickResult | undefined>) {}

  pick(): Promise<ModelPickResult | undefined> {
    this.calls += 1;
    return this.pickResult();
  }
}

after(() => {
  for (const directory of fixtures) rmSync(directory, { recursive: true, force: true });
});

describe("ModelSelector", () => {
  it("uses a stored project choice without invoking the picker", async () => {
    const paths = fixture();
    saveModelConfig(choice, "project", options(paths));
    const picker = new CountingPicker(async () => ({ choice, scope: "global" }));

    const result = await new ModelSelector({ ...options(paths), picker }).resolve();

    deepStrictEqual(result, { choice, source: "project" });
    strictEqual(picker.calls, 0);
  });

  it("picks, persists, and caches a model", async () => {
    const paths = fixture();
    const picker = new CountingPicker(async () => ({ choice, scope: "global" }));
    const selector = new ModelSelector({ ...options(paths), picker });

    deepStrictEqual(await selector.resolve(), { choice, source: "picker" });
    strictEqual(existsSync(configPath("global", options(paths))), true);
    deepStrictEqual(await selector.resolve(), { choice, source: "picker" });
    strictEqual(picker.calls, 1);
  });

  it("loads a persisted selection in a new selector without prompting", async () => {
    const paths = fixture();
    const firstPicker = new CountingPicker(async () => ({ choice, scope: "project" }));
    await new ModelSelector({ ...options(paths), picker: firstPicker }).resolve();
    const secondPicker = new CountingPicker(async () => {
      throw new Error("should not prompt");
    });

    const result = await new ModelSelector({ ...options(paths), picker: secondPicker }).resolve();

    deepStrictEqual(result, { choice, source: "project" });
    strictEqual(secondPicker.calls, 0);
  });

  it("shares one in-flight picker promise across concurrent resolves", async () => {
    const paths = fixture();
    let release: ((value: ModelPickResult) => void) | undefined;
    const picker = new CountingPicker(() => new Promise((resolve) => {
      release = resolve;
    }));
    const selector = new ModelSelector({ ...options(paths), picker });
    const requests = Array.from({ length: 5 }, () => selector.resolve());

    strictEqual(new Set(requests).size, 1);
    strictEqual(picker.calls, 1);
    release?.({ choice, scope: "project" });
    const results = await Promise.all(requests);
    for (const result of results) deepStrictEqual(result, { choice, source: "picker" });
  });

  it("caches a cancellation as declined", async () => {
    const picker = new CountingPicker(async () => undefined);
    const selector = new ModelSelector({ ...options(fixture()), picker });

    strictEqual(await selector.resolve(), undefined);
    strictEqual(await selector.resolve(), undefined);
    strictEqual(picker.calls, 1);
  });

  it("allows retries after a throwing picker", async () => {
    let fail = true;
    const warnings: string[] = [];
    const picker = new CountingPicker(async () => {
      if (fail) {
        fail = false;
        throw new Error("UI unavailable");
      }
      return { choice, scope: "project" };
    });
    const selector = new ModelSelector({ ...options(fixture()), picker, onWarning: (warning) => warnings.push(warning) });

    strictEqual(await selector.resolve(), undefined);
    deepStrictEqual(await selector.resolve(), { choice, source: "picker" });
    strictEqual(picker.calls, 2);
    strictEqual(warnings[0].includes("UI unavailable"), true);
  });

  it("uses a picked model when saving fails and reports a warning", async () => {
    const root = mkdtempSync(join(tmpdir(), "paradoc-selector-file-"));
    fixtures.push(root);
    const warnings: string[] = [];
    const picker = new CountingPicker(async () => ({ choice, scope: "project" }));
    writeFileSync(join(root, "not-a-directory"), "file", "utf8");

    const result = await new ModelSelector({
      projectRoot: join(root, "not-a-directory"),
      homeDir: join(root, "home"),
      env: {},
      picker,
      onWarning: (warning) => warnings.push(warning),
    }).resolve();

    deepStrictEqual(result, { choice, source: "picker" });
    strictEqual(warnings.some((warning) => warning.includes("could not save model config")), true);
  });

  it("does not cache an empty picker-less resolution", async () => {
    const paths = fixture();
    const selector = new ModelSelector(options(paths));

    strictEqual(await selector.resolve(), undefined);
    saveModelConfig(choice, "project", options(paths));
    deepStrictEqual(await selector.resolve(), { choice, source: "project" });
  });

  it("warns and treats an invalid picker result as a cancellation", async () => {
    const warnings: string[] = [];
    const picker = new CountingPicker(async () => ({
      choice: { providerID: "openai", modelID: "" } as unknown as typeof choice,
      scope: "project",
    }));
    const selector = new ModelSelector({ ...options(fixture()), picker, onWarning: (warning) => warnings.push(warning) });

    strictEqual(await selector.resolve(), undefined);
    strictEqual(await selector.resolve(), undefined);
    strictEqual(picker.calls, 1);
    strictEqual(warnings.some((warning) => warning.includes("invalid model choice")), true);
  });

  it("swallows a throwing warning callback", async () => {
    const picker = new CountingPicker(async () => {
      throw new Error("picker failure");
    });

    strictEqual(await new ModelSelector({ ...options(fixture()), picker, onWarning: () => { throw new Error("warning failure"); } }).resolve(), undefined);
  });
});
