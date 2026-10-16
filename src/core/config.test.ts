import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { after, describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  configPath,
  loadModelConfig,
  parseModelSpec,
  saveModelConfig,
  validateModelChoice,
} from "./config.js";

interface Fixture {
  projectRoot: string;
  homeDir: string;
}

const fixtures: string[] = [];

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "context-lens-config-"));
  fixtures.push(root);
  return {
    projectRoot: join(root, "project"),
    homeDir: join(root, "home"),
  };
}

function options(paths: Fixture, env: Record<string, string | undefined> = {}) {
  return { ...paths, env };
}

after(() => {
  for (const directory of fixtures) rmSync(directory, { recursive: true, force: true });
});

describe("model config", () => {
  it("returns undefined without warnings when nothing is configured", () => {
    const paths = fixture();
    const warnings: string[] = [];

    strictEqual(loadModelConfig({ ...options(paths), onWarning: (warning) => warnings.push(warning) }), undefined);
    deepStrictEqual(warnings, []);
  });

  it("loads a global model when it is the only configuration", () => {
    const paths = fixture();
    saveModelConfig({ providerID: "global", modelID: "small" }, "global", options(paths));

    const stored = loadModelConfig(options(paths));
    strictEqual(stored?.source, "global");
    deepStrictEqual(stored?.choice, { providerID: "global", modelID: "small" });
  });

  it("prefers project configuration over global configuration", () => {
    const paths = fixture();
    saveModelConfig({ providerID: "global", modelID: "small" }, "global", options(paths));
    saveModelConfig({ providerID: "project", modelID: "fast" }, "project", options(paths));

    const stored = loadModelConfig(options(paths));
    strictEqual(stored?.source, "project");
    deepStrictEqual(stored?.choice, { providerID: "project", modelID: "fast" });
  });

  it("prefers a valid environment model over file configuration", () => {
    const paths = fixture();
    saveModelConfig({ providerID: "project", modelID: "fast" }, "project", options(paths));

    const stored = loadModelConfig(options(paths, { CONTEXT_LENS_MODEL: "openai/gpt-x" }));
    strictEqual(stored?.source, "env");
    deepStrictEqual(stored?.choice, { providerID: "openai", modelID: "gpt-x" });
  });

  it("warns for an invalid environment model and falls through to project", () => {
    const paths = fixture();
    const warnings: string[] = [];
    saveModelConfig({ providerID: "project", modelID: "fast" }, "project", options(paths));

    const stored = loadModelConfig({
      ...options(paths, { CONTEXT_LENS_MODEL: "noslash" }),
      onWarning: (warning) => warnings.push(warning),
    });

    strictEqual(stored?.source, "project");
    strictEqual(warnings.length, 1);
    strictEqual(warnings[0].includes("CONTEXT_LENS_MODEL"), true);
  });

  it("warns and returns undefined for corrupt JSON without throwing", () => {
    const paths = fixture();
    const warnings: string[] = [];
    const path = configPath("project", options(paths));
    saveDirectory(path);
    writeFileSync(path, "{not json", "utf8");

    strictEqual(loadModelConfig({ ...options(paths), onWarning: (warning) => warnings.push(warning) }), undefined);
    strictEqual(warnings.length, 1);
    strictEqual(warnings[0].includes(path), true);
  });

  it("warns and ignores wrong versions and invalid models", () => {
    const paths = fixture();
    const warnings: string[] = [];
    const projectPath = configPath("project", options(paths));
    const globalPath = configPath("global", options(paths));
    saveDirectory(projectPath);
    saveDirectory(globalPath);
    writeFileSync(projectPath, JSON.stringify({ version: 2, model: {} }), "utf8");
    writeFileSync(globalPath, JSON.stringify({ version: 1, model: { providerID: "x" } }), "utf8");

    strictEqual(loadModelConfig({ ...options(paths), onWarning: (warning) => warnings.push(warning) }), undefined);
    strictEqual(warnings.length, 2);
    strictEqual(warnings.every((warning) => warning.includes("ignoring")), true);
  });

  it("round-trips endpoint choices through both scopes", () => {
    for (const scope of ["project", "global"] as const) {
      const paths = fixture();
      const choice = { providerID: "openrouter", modelID: "anthropic/x", endpoint: "https://example.test" };
      const path = saveModelConfig(choice, scope, options(paths));

      strictEqual(existsSync(path), true);
      deepStrictEqual(loadModelConfig(options(paths)), { choice, source: scope, path });
    }
  });

  it("leaves no temporary files after saving", () => {
    const paths = fixture();
    const path = saveModelConfig({ providerID: "openai", modelID: "mini" }, "project", options(paths));

    deepStrictEqual(readdirSync(join(path, "..")), ["config.json"]);
  });

  it("honours XDG_CONFIG_HOME", () => {
    const paths = fixture();
    const xdg = join(paths.homeDir, "custom-config");
    const configOptions = options(paths, { XDG_CONFIG_HOME: xdg });
    const path = saveModelConfig({ providerID: "openai", modelID: "mini" }, "global", configOptions);

    strictEqual(path, join(xdg, "context-lens", "config.json"));
    strictEqual(loadModelConfig(configOptions)?.source, "global");
  });

  it("parses the first slash and rejects empty spec parts", () => {
    deepStrictEqual(parseModelSpec(" openrouter/anthropic/claude-x "), {
      providerID: "openrouter",
      modelID: "anthropic/claude-x",
    });
    strictEqual(parseModelSpec("/model"), undefined);
    strictEqual(parseModelSpec("provider/"), undefined);
    strictEqual(parseModelSpec("noslash"), undefined);
  });

  it("validates only canonical model fields and rejects invalid choices when saving", () => {
    deepStrictEqual(validateModelChoice({ providerID: " provider ", modelID: " model ", extra: true }), {
      providerID: "provider",
      modelID: "model",
    });
    strictEqual(validateModelChoice({ providerID: "provider", modelID: "model", endpoint: undefined }), undefined);
    throws(() => saveModelConfig({ providerID: "", modelID: "model" }, "project", options(fixture())), /Invalid model choice/);
  });
});

function saveDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
