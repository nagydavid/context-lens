import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FakeSubagentRunner } from "./fake-runner.js";
import { createHostRuntime } from "./host-runtime.js";
import type { ModelPicker } from "./model-selector.js";
import { buildStatus, statusConfigPaths } from "./status.js";
import { DEFAULT_TUNING, loadTuning } from "./tuning.js";

let tmp: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "paradoc-status-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

interface FixtureOptions {
  project?: unknown;
  global?: unknown;
  env?: Record<string, string | undefined>;
}

/** A throwaway root with optional project/global config files (objects are JSON, strings written raw). */
function fixture(options: FixtureOptions = {}) {
  const dir = mkdtempSync(join(tmp, "root-"));
  const configOptions = {
    projectRoot: dir,
    homeDir: dir,
    env: { XDG_CONFIG_HOME: join(dir, "xdg"), ...(options.env ?? {}) } as Record<string, string | undefined>,
  };
  const paths = statusConfigPaths(configOptions);
  for (const scope of ["project", "global"] as const) {
    const value = options[scope];
    if (value === undefined) continue;
    mkdirSync(dirname(paths[scope]), { recursive: true });
    writeFileSync(paths[scope], typeof value === "string" ? value : JSON.stringify(value));
  }
  return { dir, configOptions };
}

function runtimeFor(f = fixture(), overrides: Partial<Parameters<typeof createHostRuntime>[0]> = {}) {
  const logs: Array<{ level: string; message: string }> = [];
  const runtime = createHostRuntime({
    projectRoot: f.dir,
    configOptions: f.configOptions,
    log: (level, message) => logs.push({ level, message }),
    runner: new FakeSubagentRunner({ structured: { excerpts: [{ startLine: 1, endLine: 2 }], summary: "s", confidence: 3 } }),
    ...overrides,
  });
  return { runtime, logs, dir: f.dir };
}

describe("buildStatus", () => {
  it("copies inputs so the snapshot cannot be mutated through them", () => {
    const { settings, sources } = loadTuning(fixture().configOptions);
    const status = buildStatus({
      settings,
      sources,
      model: { choice: { providerID: "p", modelID: "m" }, source: "project" },
      configPaths: { project: "/p/.paradoc/config.json", global: "/g/paradoc/config.json" },
    });
    settings.thresholdLines = 1;
    sources.thresholdLines = "env";
    assert.equal(status.settings.thresholdLines, DEFAULT_TUNING.thresholdLines);
    assert.equal(status.sources.thresholdLines, "default");
    assert.notEqual(status.settings, settings);
    assert.notEqual(status.model.choice, undefined);
  });

  it("defaults warnings to an empty list and omits stats when none are supplied", () => {
    const { settings, sources } = loadTuning(fixture().configOptions);
    const status = buildStatus({
      settings,
      sources,
      model: { source: "none" },
      configPaths: { project: "/p", global: "/g" },
    });
    assert.deepStrictEqual(status.settings, DEFAULT_TUNING);
    assert.deepStrictEqual(status.model, { source: "none" });
    assert.deepStrictEqual(status.warnings, []);
    assert.equal(status.stats, undefined);
    for (const key of Object.keys(DEFAULT_TUNING) as (keyof typeof DEFAULT_TUNING)[]) {
      assert.equal(status.sources[key], "default", key);
    }
  });
});

describe("runtime.getStatus", () => {
  it("reports defaults, default provenance, config paths and no stats before an interceptor exists", async () => {
    const { runtime, dir } = runtimeFor();
    const status = await runtime.getStatus();
    assert.deepStrictEqual(status.settings, DEFAULT_TUNING);
    assert.deepStrictEqual(status.model, { source: "none" });
    assert.equal(status.stats, undefined, "status must not build an interceptor");
    assert.deepStrictEqual(status.warnings, []);
    assert.equal(status.configPaths.project, join(dir, ".paradoc", "config.json"));
    assert.equal(status.configPaths.global, join(dir, "xdg", "paradoc", "config.json"));
  });

  it("reports provenance for the explicit, env, project and global layers", async () => {
    const explicit = runtimeFor(fixture({ env: { PARADOC_THRESHOLD: "300" } }), { explicit: { thresholdLines: 500 } });
    const explicitStatus = await explicit.runtime.getStatus();
    assert.equal(explicitStatus.sources.thresholdLines, "explicit");
    assert.equal(explicitStatus.settings.thresholdLines, 500);

    const env = runtimeFor(fixture({ env: { PARADOC_THRESHOLD: "300" } }));
    assert.equal((await env.runtime.getStatus()).sources.thresholdLines, "env");

    const project = runtimeFor(fixture({ project: { version: 1, tuning: { thresholdLines: 200 } } }));
    const projectStatus = await project.runtime.getStatus();
    assert.equal(projectStatus.sources.thresholdLines, "project");
    assert.equal(projectStatus.settings.thresholdLines, 200);

    const global = runtimeFor(fixture({ global: { version: 1, tuning: { thresholdLines: 100 } } }));
    const globalStatus = await global.runtime.getStatus();
    assert.equal(globalStatus.sources.thresholdLines, "global");
    assert.equal(globalStatus.settings.thresholdLines, 100);

    const none = runtimeFor();
    assert.equal((await none.runtime.getStatus()).sources.thresholdLines, "default");
  });

  it("reports the stored model choice and its source", async () => {
    const project = runtimeFor(fixture({ project: { version: 1, model: { providerID: "proj", modelID: "m1" } } }));
    const projectStatus = await project.runtime.getStatus();
    assert.equal(projectStatus.model.source, "project");
    assert.deepStrictEqual(projectStatus.model.choice, { providerID: "proj", modelID: "m1" });

    const global = runtimeFor(fixture({ global: { version: 1, model: { providerID: "glob", modelID: "m2" } } }));
    const globalStatus = await global.runtime.getStatus();
    assert.equal(globalStatus.model.source, "global");
    assert.deepStrictEqual(globalStatus.model.choice, { providerID: "glob", modelID: "m2" });

    const env = runtimeFor(fixture({ env: { PARADOC_MODEL: "openai/gpt-x" } }));
    const envStatus = await env.runtime.getStatus();
    assert.equal(envStatus.model.source, "env");
    assert.deepStrictEqual(envStatus.model.choice, { providerID: "openai", modelID: "gpt-x" });
  });

  it("names a configured picker as the model source without invoking it", async () => {
    let picks = 0;
    const picker: ModelPicker = {
      pick: async () => {
        picks += 1;
        return { choice: { providerID: "p", modelID: "m" }, scope: "project" };
      },
    };
    const { runtime } = runtimeFor(fixture(), { picker });
    const status = await runtime.getStatus();
    assert.deepStrictEqual(status.model, { source: "picker" });
    assert.equal(picks, 0, "status must never prompt for a model");
  });

  it("prefers a stored model over the picker", async () => {
    let picks = 0;
    const picker: ModelPicker = {
      pick: async () => {
        picks += 1;
        return { choice: { providerID: "p", modelID: "m" }, scope: "project" };
      },
    };
    const { runtime } = runtimeFor(fixture({ project: { version: 1, model: { providerID: "stored", modelID: "s" } } }), { picker });
    const status = await runtime.getStatus();
    assert.equal(status.model.source, "project");
    assert.deepStrictEqual(status.model.choice, { providerID: "stored", modelID: "s" });
    assert.equal(picks, 0);
  });

  it("resolves status for another root using that root's project config", async () => {
    const { runtime, dir } = runtimeFor();
    const other = join(dir, "nested");
    mkdirSync(join(other, ".paradoc"), { recursive: true });
    writeFileSync(join(other, ".paradoc", "config.json"), JSON.stringify({ version: 1, tuning: { thresholdLines: 210 } }));
    const status = await runtime.getStatus(other);
    assert.equal(status.settings.thresholdLines, 210);
    assert.equal(status.sources.thresholdLines, "project");
    assert.equal(status.configPaths.project, join(other, ".paradoc", "config.json"));
    assert.equal(status.configPaths.global, join(dir, "xdg", "paradoc", "config.json"));
  });

  it("includes interceptor stats once an interceptor exists for the root", async () => {
    const { runtime, dir } = runtimeFor();
    const file = join(dir, "big.ts");
    writeFileSync(file, Array.from({ length: 400 }, (_, i) => `const line_${i + 1} = ${i + 1};`).join("\n"));
    const interceptor = runtime.interceptorFor(dir);

    const built = await runtime.getStatus();
    assert.ok(built.stats, "stats appear once the interceptor is built");
    assert.equal(built.stats.intercepted, 0);

    const result = await interceptor.intercept({ filePath: file, projectRoot: dir, question: "which line?", agentContext: {} });
    assert.ok(result.wasIntercepted);
    const status = await runtime.getStatus();
    assert.equal(status.stats?.intercepted, 1);
    assert.equal(status.stats?.passthrough, 0);

    assert.equal((await runtime.getStatus(join(dir, "other-root"))).stats, undefined, "other roots stay untouched");
  });

  it("never throws on a malformed config and surfaces warnings instead", async () => {
    const { runtime } = runtimeFor(fixture({ project: "{ not json", global: { version: 1, tuning: [1, 2] } }));
    const status = await runtime.getStatus();
    assert.deepStrictEqual(status.settings, DEFAULT_TUNING);
    assert.equal(status.warnings.length >= 2, true, JSON.stringify(status.warnings));
    assert.ok(status.warnings.some((w) => w.includes("invalid JSON")), JSON.stringify(status.warnings));
    assert.ok(status.warnings.some((w) => w.includes("invalid tuning")), JSON.stringify(status.warnings));
  });

  it("surfaces an ignored tuning value and an invalid model spec as warnings", async () => {
    const { runtime } = runtimeFor(fixture({ env: { PARADOC_THRESHOLD: "lots", PARADOC_MODEL: "noslash" } }));
    const status = await runtime.getStatus();
    assert.equal(status.settings.thresholdLines, DEFAULT_TUNING.thresholdLines);
    assert.equal(status.model.source, "none");
    assert.ok(status.warnings.some((w) => w.includes("PARADOC_THRESHOLD")), JSON.stringify(status.warnings));
    assert.ok(status.warnings.some((w) => w.includes("PARADOC_MODEL")), JSON.stringify(status.warnings));
  });
});
