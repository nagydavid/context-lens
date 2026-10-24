import {
  deepStrictEqual,
  strictEqual,
  throws,
} from "node:assert";
import { after, describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { configPath } from "./config.js";
import type { ConfigOptions } from "./config.js";
import { DEFAULT_TUNING, loadTuning, TUNING_KEYS } from "./tuning.js";
import type { TuningKey, TuningSettings } from "./tuning.js";
import { clearTuning, saveTuning } from "./tuning-write.js";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function setup(
  files: { project?: unknown; global?: unknown } = {},
  env: Record<string, string | undefined> = {},
): { opts: ConfigOptions; warnings: string[]; root: string } {
  const root = mkdtempSync(join(tmpdir(), "paradoc-tuning-write-"));
  roots.push(root);
  const opts: ConfigOptions = {
    projectRoot: join(root, "project"),
    homeDir: join(root, "home"),
    env: { XDG_CONFIG_HOME: join(root, "xdg"), ...env },
  };
  const warnings: string[] = [];
  opts.onWarning = (message: string) => warnings.push(message);
  for (const scope of ["project", "global"] as const) {
    if (files[scope] === undefined) continue;
    const path = configPath(scope, opts);
    mkdirSync(dirname(path), { recursive: true });
    const body = typeof files[scope] === "string" ? files[scope] : JSON.stringify(files[scope]);
    writeFileSync(path, body, "utf8");
  }
  return { opts, warnings, root };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function tmpFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

describe("saveTuning", () => {
  it("round-trips a project-scope value through loadTuning", () => {
    const s = setup();
    const path = saveTuning({ thresholdLines: 120, concurrency: 3 }, "project", s.opts);
    strictEqual(path, configPath("project", s.opts));
    const loaded = loadTuning(s.opts);
    strictEqual(loaded.settings.thresholdLines, 120);
    strictEqual(loaded.settings.concurrency, 3);
    strictEqual(loaded.sources.thresholdLines, "project");
    strictEqual(loaded.sources.concurrency, "project");
    strictEqual(loaded.sources.timeoutMs, "default");
    strictEqual(s.warnings.length, 0);
  });

  it("round-trips a global-scope value with global provenance", () => {
    const s = setup();
    const path = saveTuning({ judge: "always", cacheMaxEntries: 0 }, "global", s.opts);
    strictEqual(path, configPath("global", s.opts));
    const loaded = loadTuning(s.opts);
    strictEqual(loaded.settings.judge, "always");
    strictEqual(loaded.settings.cacheMaxEntries, 0);
    strictEqual(loaded.sources.judge, "global");
    strictEqual(loaded.sources.cacheMaxEntries, "global");
  });

  it("project values keep outranking global values after a global write", () => {
    const s = setup({ project: { version: 1, tuning: { thresholdLines: 10 } } });
    saveTuning({ thresholdLines: 999 }, "global", s.opts);
    const loaded = loadTuning(s.opts);
    strictEqual(loaded.settings.thresholdLines, 10);
    strictEqual(loaded.sources.thresholdLines, "project");
  });

  it("preserves model, version and unknown top-level keys", () => {
    const s = setup({
      project: { version: 1, model: { providerID: "openai", modelID: "mini" }, custom: { keep: true }, tuning: { timeoutMs: 5000 } },
    });
    const path = saveTuning({ concurrency: 4 }, "project", s.opts);
    const config = readJson(path);
    deepStrictEqual(config.model, { providerID: "openai", modelID: "mini" });
    strictEqual(config.version, 1);
    deepStrictEqual(config.custom, { keep: true });
    deepStrictEqual(config.tuning, { timeoutMs: 5000, concurrency: 4 });
  });

  it("creates the config directory when it does not exist", () => {
    const s = setup();
    const path = saveTuning({ minTokens: 2000 }, "project", s.opts);
    strictEqual(existsSync(path), true);
    deepStrictEqual(readJson(path).tuning, { minTokens: 2000 });
  });

  it("merges into an existing tuning block instead of replacing it", () => {
    const s = setup({ project: { version: 1, tuning: { thresholdLines: 7, judge: "always" } } });
    const path = saveTuning({ thresholdLines: 8 }, "project", s.opts);
    deepStrictEqual(readJson(path).tuning, { thresholdLines: 8, judge: "always" });
  });

  it("leaves no temporary files behind", () => {
    const s = setup();
    const path = saveTuning({ thresholdLines: 42 }, "project", s.opts);
    strictEqual(tmpFiles(dirname(path)).length, 0);
    deepStrictEqual(readdirSync(dirname(path)), ["config.json"]);
  });

  it("env still outranks a saved value", () => {
    const s = setup({}, { PARADOC_THRESHOLD: "77" });
    saveTuning({ thresholdLines: 120 }, "project", s.opts);
    const loaded = loadTuning(s.opts);
    strictEqual(loaded.settings.thresholdLines, 77);
    strictEqual(loaded.sources.thresholdLines, "env");
  });

  it("writes every tuning key with its validated value", () => {
    const s = setup();
    const partial: Partial<TuningSettings> = {
      thresholdLines: 11,
      timeoutMs: 12,
      concurrency: 2,
      chunkLines: 30,
      chunkOverlapLines: 5,
      judge: "low-confidence",
      cacheMaxEntries: 0,
      minTokens: 13,
      thresholdTokens: 14,
      pdfTimeoutMs: 15,
      pdfMaxChars: 16,
    };
    const path = saveTuning(partial, "project", s.opts);
    deepStrictEqual(readJson(path).tuning, partial);
    const loaded = loadTuning(s.opts);
    for (const key of TUNING_KEYS) strictEqual(loaded.sources[key], "project", key);
    strictEqual(loaded.settings.chunkOverlapLines, 5);
  });
});

describe("saveTuning rejections", () => {
  it("rejects invalid values with an actionable message naming the key", () => {
    const s = setup();
    throws(() => saveTuning({ timeoutMs: 0 } as Partial<TuningSettings>, "project", s.opts), /invalid tuning value for timeoutMs: expected an integer >= 1/);
    throws(() => saveTuning({ judge: "sometimes" } as unknown as Partial<TuningSettings>, "project", s.opts), /invalid tuning value for judge: expected off, low-confidence or always/);
    throws(() => saveTuning({ concurrency: 1.5 } as Partial<TuningSettings>, "project", s.opts), /concurrency/);
    throws(() => saveTuning({ thresholdLines: "12" } as unknown as Partial<TuningSettings>, "project", s.opts), /thresholdLines/);
  });

  it("rejects unknown keys and names the accepted keys", () => {
    const s = setup();
    throws(
      () => saveTuning({ mystery: 1 } as unknown as Partial<TuningSettings>, "project", s.opts),
      /unknown tuning key "mystery": expected one of thresholdLines/,
    );
  });

  it("requires at least one defined key", () => {
    const s = setup();
    throws(() => saveTuning({}, "project", s.opts), /needs at least one tuning key/);
    throws(() => saveTuning({ thresholdLines: undefined }, "project", s.opts), /needs at least one tuning key/);
  });

  it("writes nothing when any key in the partial is invalid", () => {
    const s = setup({ project: { version: 1, tuning: { thresholdLines: 3 } } });
    const path = configPath("project", s.opts);
    const before = readFileSync(path, "utf8");
    throws(() => saveTuning({ thresholdLines: 55, concurrency: 0 }, "project", s.opts), /concurrency/);
    strictEqual(readFileSync(path, "utf8"), before);
    strictEqual(loadTuning(s.opts).settings.thresholdLines, 3);
    strictEqual(tmpFiles(dirname(path)).length, 0);
  });

  it("rejects a merged block whose chunkOverlapLines is not smaller than chunkLines", () => {
    const s = setup({ project: { version: 1, tuning: { chunkLines: 100 } } });
    const path = configPath("project", s.opts);
    const before = readFileSync(path, "utf8");
    throws(() => saveTuning({ chunkOverlapLines: 100 }, "project", s.opts), /chunkOverlapLines: must be smaller than chunkLines \(100\)/);
    strictEqual(readFileSync(path, "utf8"), before);
    // A consistent pair is accepted.
    saveTuning({ chunkOverlapLines: 40 }, "project", s.opts);
    deepStrictEqual(readJson(path).tuning, { chunkLines: 100, chunkOverlapLines: 40 });
  });

  it("refuses to overwrite a corrupt or malformed config and names the path", () => {
    const cases: Array<{ label: string; body: unknown }> = [
      { label: "invalid JSON", body: "{nope" },
      { label: "array", body: [1, 2] },
      { label: "scalar", body: "42" },
      { label: "unsupported version", body: { version: 2, tuning: { thresholdLines: 1 } } },
      { label: "invalid tuning block", body: { version: 1, tuning: [1, 2] } },
    ];
    for (const scope of ["project", "global"] as const) {
      for (const testCase of cases) {
        const s = setup({ [scope]: testCase.body });
        const path = configPath(scope, s.opts);
        const before = readFileSync(path, "utf8");
        throws(
          () => saveTuning({ thresholdLines: 12 }, scope, s.opts),
          (error: unknown) => String(error).includes("refusing to overwrite") && String(error).includes(path),
          `${scope} ${testCase.label}`,
        );
        strictEqual(readFileSync(path, "utf8"), before, `${scope} ${testCase.label} unchanged`);
        throws(() => clearTuning(scope, s.opts), /refusing to overwrite/, `${scope} ${testCase.label} clear`);
        strictEqual(readFileSync(path, "utf8"), before, `${scope} ${testCase.label} clear unchanged`);
      }
    }
  });

  it("surfaces a filesystem failure and leaves no temporary file", () => {
    const s = setup();
    const dir = dirname(configPath("project", s.opts));
    mkdirSync(dirname(dir), { recursive: true });
    writeFileSync(dir, "not a directory", "utf8");
    throws(() => saveTuning({ thresholdLines: 12 }, "project", s.opts), /refusing to overwrite|EISDIR|ENOTDIR|EEXIST/);
    strictEqual(tmpFiles(dirname(dir)).length, 0);
  });
});

describe("clearTuning", () => {
  it("removes a single key and keeps the rest of the block", () => {
    const s = setup({ project: { version: 1, model: { providerID: "a", modelID: "b" }, tuning: { thresholdLines: 9, timeoutMs: 800 } } });
    const path = configPath("project", s.opts);
    const written = clearTuning("project", s.opts, ["thresholdLines"]);
    strictEqual(written, path);
    const config = readJson(path);
    deepStrictEqual(config.tuning, { timeoutMs: 800 });
    deepStrictEqual(config.model, { providerID: "a", modelID: "b" });
    strictEqual(loadTuning(s.opts).settings.thresholdLines, DEFAULT_TUNING.thresholdLines);
    strictEqual(loadTuning(s.opts).sources.timeoutMs, "project");
  });

  it("removes the whole tuning block when keys are omitted", () => {
    const s = setup({ project: { version: 1, model: { providerID: "a", modelID: "b" }, custom: 1, tuning: { thresholdLines: 9, concurrency: 4 } } });
    const path = configPath("project", s.opts);
    strictEqual(clearTuning("project", s.opts), path);
    const config = readJson(path);
    strictEqual("tuning" in config, false);
    deepStrictEqual(config.model, { providerID: "a", modelID: "b" });
    strictEqual(config.custom, 1);
    deepStrictEqual(loadTuning(s.opts).settings, DEFAULT_TUNING);
    strictEqual(tmpFiles(dirname(path)).length, 0);
  });

  it("drops the block when the last key is cleared", () => {
    const s = setup({ project: { version: 1, tuning: { thresholdLines: 9 } } });
    const path = configPath("project", s.opts);
    strictEqual(clearTuning("project", s.opts, ["thresholdLines"]), path);
    strictEqual("tuning" in readJson(path), false);
  });

  it("does not create a file when none exists", () => {
    const s = setup();
    const path = configPath("project", s.opts);
    strictEqual(clearTuning("project", s.opts), undefined);
    strictEqual(clearTuning("global", s.opts, ["thresholdLines"]), undefined);
    strictEqual(existsSync(path), false);
    strictEqual(existsSync(configPath("global", s.opts)), false);
    deepStrictEqual(loadTuning(s.opts).settings, DEFAULT_TUNING);
  });

  it("is a no-op when the file has no tuning or no matching key", () => {
    const s = setup({ project: { version: 1, model: { providerID: "a", modelID: "b" } } });
    const path = configPath("project", s.opts);
    const before = readFileSync(path, "utf8");
    strictEqual(clearTuning("project", s.opts), undefined);
    strictEqual(clearTuning("project", s.opts, ["thresholdLines"]), undefined);
    strictEqual(readFileSync(path, "utf8"), before);
  });

  it("clears a global block independently of the project block", () => {
    const s = setup({ project: { version: 1, tuning: { thresholdLines: 9 } }, global: { version: 1, tuning: { thresholdLines: 11, timeoutMs: 700 } } });
    strictEqual(clearTuning("global", s.opts, ["thresholdLines"]), configPath("global", s.opts));
    deepStrictEqual(readJson(configPath("global", s.opts)).tuning, { timeoutMs: 700 });
    const loaded = loadTuning(s.opts);
    strictEqual(loaded.settings.thresholdLines, 9);
    strictEqual(loaded.sources.thresholdLines, "project");
  });

  it("rejects unknown keys", () => {
    const s = setup({ project: { version: 1, tuning: { thresholdLines: 9 } } });
    throws(
      () => clearTuning("project", s.opts, ["mystery"] as unknown as TuningKey[]),
      /unknown tuning key "mystery": expected one of thresholdLines/,
    );
  });

  it("saved then cleared values return to defaults with default provenance", () => {
    const s = setup();
    saveTuning({ thresholdLines: 120, judge: "always" }, "project", s.opts);
    strictEqual(loadTuning(s.opts).sources.judge, "project");
    clearTuning("project", s.opts);
    const loaded = loadTuning(s.opts);
    deepStrictEqual(loaded.settings, DEFAULT_TUNING);
    for (const key of TUNING_KEYS) strictEqual(loaded.sources[key], "default", key);
  });
});
