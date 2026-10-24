import { deepStrictEqual, strictEqual } from "node:assert";
import { after, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { configPath } from "./config.js";
import { DEFAULT_PDF_MAX_CHARS, DEFAULT_PDF_TIMEOUT_MS } from "./pdf.js";
import { DEFAULT_TUNING, loadTuning, tuningToInterceptorOptions } from "./tuning.js";
import type { TuningSettings } from "./tuning.js";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function setup(
  tuning: { project?: unknown; global?: unknown } = {},
  env: Record<string, string | undefined> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "paradoc-tuning-"));
  roots.push(root);
  const base = {
    projectRoot: join(root, "project"),
    homeDir: join(root, "home"),
    env: { XDG_CONFIG_HOME: join(root, "xdg"), ...env } as Record<string, string | undefined>,
  };
  const warnings: string[] = [];
  const opts = { ...base, onWarning: (m: string) => warnings.push(m) };
  for (const scope of ["project", "global"] as const) {
    if (tuning[scope] === undefined) continue;
    const path = configPath(scope, opts);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, tuning: tuning[scope] }));
  }
  return { opts, warnings, base };
}

const layers = {
  thresholdLines: [100, 200, 300, 400, "PARADOC_THRESHOLD"],
  timeoutMs: [1000, 2000, 3000, 4000, "PARADOC_TIMEOUT_MS"],
  concurrency: [2, 3, 4, 5, "PARADOC_CONCURRENCY"],
  chunkLines: [100, 200, 300, 400, "PARADOC_CHUNK_LINES"],
  chunkOverlapLines: [5, 6, 7, 8, "PARADOC_CHUNK_OVERLAP"],
  cacheMaxEntries: [10, 20, 30, 40, "PARADOC_CACHE"],
  minTokens: [1100, 1200, 1300, 1400, "PARADOC_MIN_TOKENS"],
  thresholdTokens: [8100, 8200, 8300, 8400, "PARADOC_THRESHOLD_TOKENS"],
  pdfTimeoutMs: [11000, 12000, 13000, 14000, "PARADOC_PDF_TIMEOUT_MS"],
  pdfMaxChars: [101000, 102000, 103000, 104000, "PARADOC_PDF_MAX_CHARS"],
} as const;

describe("tuning precedence", () => {
  for (const [key, [g, p, e, x, envName]] of Object.entries(layers)) {
    it(`resolves ${key}: explicit > env > project > global > default`, () => {
      const k = key as keyof TuningSettings;
      const env = { [envName]: String(e) };
      const full = setup({ global: { [k]: g }, project: { [k]: p } }, env);
      const run = (explicit: Partial<TuningSettings>, o = full.opts) => loadTuning({ ...o, explicit });
      let r = run({ [k]: x });
      strictEqual(r.settings[k], x);
      strictEqual(r.sources[k], "explicit");
      r = run({});
      strictEqual(r.settings[k], e);
      strictEqual(r.sources[k], "env");
      const noEnv = setup({ global: { [k]: g }, project: { [k]: p } });
      r = loadTuning(noEnv.opts);
      strictEqual(r.settings[k], p);
      strictEqual(r.sources[k], "project");
      const onlyGlobal = setup({ global: { [k]: g } });
      r = loadTuning(onlyGlobal.opts);
      strictEqual(r.settings[k], g);
      strictEqual(r.sources[k], "global");
      r = loadTuning(setup().opts);
      strictEqual(r.sources[k], "default");
      strictEqual(full.warnings.length, 0);
    });
  }

  it("resolves judge across layers", () => {
    const s = setup({ global: { judge: "always" }, project: { judge: "low-confidence" } }, { PARADOC_JUDGE: "off" });
    strictEqual(loadTuning({ ...s.opts, explicit: { judge: "always" } }).sources.judge, "explicit");
    strictEqual(loadTuning(s.opts).sources.judge, "env");
    const t = setup({ global: { judge: "always" }, project: { judge: "low-confidence" } });
    strictEqual(loadTuning(t.opts).settings.judge, "low-confidence");
    strictEqual(loadTuning(setup({ global: { judge: "always" } }).opts).settings.judge, "always");
  });

  it("ignores undefined explicit values and returns defaults", () => {
    const s = setup();
    const r = loadTuning({ ...s.opts, explicit: { thresholdLines: undefined } });
    deepStrictEqual(r.settings, DEFAULT_TUNING);
  });
});

describe("tuning invalid values", () => {
  it("warns and falls through per layer", () => {
    const s = setup(
      { global: { timeoutMs: 9000 }, project: { timeoutMs: 1.5, concurrency: 0 } },
      { PARADOC_TIMEOUT_MS: "12abc", PARADOC_THRESHOLD: "-3" },
    );
    const r = loadTuning({ ...s.opts, explicit: { thresholdLines: 0, concurrency: 7 } });
    strictEqual(r.settings.thresholdLines, 350);
    strictEqual(r.settings.timeoutMs, 9000);
    strictEqual(r.sources.timeoutMs, "global");
    strictEqual(r.settings.concurrency, 7);
    const joined = s.warnings.join("\n");
    for (const needle of ["explicit thresholdLines", "PARADOC_TIMEOUT_MS", "PARADOC_THRESHOLD", "tuning.timeoutMs"]) {
      strictEqual(joined.includes(needle), true, needle);
    }
  });

  it("rejects non-strict env integers and unknown judge modes", () => {
    const s = setup({ project: { judge: "sometimes" } }, { PARADOC_CHUNK_LINES: "1e3", PARADOC_CONCURRENCY: " 2 " });
    const r = loadTuning(s.opts);
    strictEqual(r.settings.chunkLines, 0);
    strictEqual(r.settings.judge, "off");
    strictEqual(r.settings.concurrency, 2);
    strictEqual(s.warnings.length, 2);
  });

  it("treats PARADOC_CACHE=off as 0 and rejects other cache words", () => {
    strictEqual(loadTuning(setup({}, { PARADOC_CACHE: "off" }).opts).settings.cacheMaxEntries, 0);
    const s = setup({}, { PARADOC_CACHE: "none" });
    strictEqual(loadTuning(s.opts).settings.cacheMaxEntries, 64);
    strictEqual(s.warnings.length, 1);
  });

  it("warns for bad JSON and non-object tuning but not for a missing block", () => {
    const s = setup({ global: [1, 2] });
    const path = configPath("project", s.opts);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{nope");
    const r = loadTuning(s.opts);
    deepStrictEqual(r.settings, DEFAULT_TUNING);
    strictEqual(s.warnings.length, 2);
  });

  it("is silent for a config without tuning and ignores unknown keys", () => {
    const s = setup({ project: { mystery: 1, thresholdLines: 10 } });
    const g = configPath("global", s.opts);
    mkdirSync(dirname(g), { recursive: true });
    writeFileSync(g, JSON.stringify({ version: 1, model: { providerID: "a", modelID: "b" } }));
    const r = loadTuning(s.opts);
    strictEqual(r.settings.thresholdLines, 10);
    strictEqual(s.warnings.length, 0);
  });
});

describe("chunk overlap", () => {
  it("derives overlap 50 when chunking is on and overlap is default", () => {
    const r = loadTuning(setup({ project: { chunkLines: 200 } }).opts);
    strictEqual(r.settings.chunkOverlapLines, 50);
    strictEqual(r.sources.chunkOverlapLines, "default");
    strictEqual(loadTuning(setup({ project: { chunkLines: 10 } }).opts).settings.chunkOverlapLines, 9);
    strictEqual(loadTuning(setup().opts).settings.chunkOverlapLines, 0);
  });

  it("warns when explicit overlap >= chunkLines and uses the derived default", () => {
    const s = setup({ project: { chunkLines: 100 } });
    const r = loadTuning({ ...s.opts, explicit: { chunkOverlapLines: 100 } });
    strictEqual(r.settings.chunkOverlapLines, 50);
    strictEqual(s.warnings.length, 1);
  });
});

describe("tuningToInterceptorOptions", () => {
  it("maps settings to interceptor options", () => {
    deepStrictEqual(tuningToInterceptorOptions({ ...DEFAULT_TUNING, judge: "always", chunkLines: 80 }), {
      thresholdLines: 350,
      timeoutMs: 30000,
      chunkLines: 80,
      chunkOverlapLines: 0,
      minTokens: 1000,
      thresholdTokens: 8000,
      pdfTimeoutMs: DEFAULT_PDF_TIMEOUT_MS,
      pdfMaxChars: DEFAULT_PDF_MAX_CHARS,
      judge: { mode: "always" },
    });
  });

  it("shares one default source with the interceptor and pdf extractor", () => {
    strictEqual(DEFAULT_TUNING.minTokens, 1000);
    strictEqual(DEFAULT_TUNING.thresholdTokens, 8000);
    strictEqual(DEFAULT_TUNING.pdfTimeoutMs, DEFAULT_PDF_TIMEOUT_MS);
    strictEqual(DEFAULT_TUNING.pdfMaxChars, DEFAULT_PDF_MAX_CHARS);
  });

  it("forwards the interceptor-only knobs from env and config", () => {
    const s = setup({ project: { pdfMaxChars: 5000 } }, { PARADOC_MIN_TOKENS: "250", PARADOC_THRESHOLD_TOKENS: "1200", PARADOC_PDF_TIMEOUT_MS: "2500" });
    const r = loadTuning(s.opts);
    deepStrictEqual(tuningToInterceptorOptions(r.settings), {
      ...tuningToInterceptorOptions(DEFAULT_TUNING),
      minTokens: 250,
      thresholdTokens: 1200,
      pdfTimeoutMs: 2500,
      pdfMaxChars: 5000,
    });
    strictEqual(r.sources.minTokens, "env");
    strictEqual(r.sources.pdfMaxChars, "project");
    strictEqual(s.warnings.length, 0);
  });

  it("warns and keeps the default for a bad interceptor-only value", () => {
    const s = setup({}, { PARADOC_MIN_TOKENS: "0", PARADOC_PDF_MAX_CHARS: "many" });
    const r = loadTuning(s.opts);
    strictEqual(r.settings.minTokens, DEFAULT_TUNING.minTokens);
    strictEqual(r.settings.pdfMaxChars, DEFAULT_PDF_MAX_CHARS);
    strictEqual(s.warnings.length, 2);
  });
});
