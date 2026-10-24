import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { configPath, loadModelConfig } from "./config.js";
import type { ConfigOptions, ModelChoice } from "./config.js";
import {
  CONTROL_USAGE,
  applyModel,
  applyReset,
  applySet,
  parseControlArgs,
  renderChange,
  renderStatus,
  RESTART_HINT,
  SOURCE_PRECEDENCE,
  type ChangeResult,
  type ControlAction,
} from "./controls.js";
import { buildStatus, statusConfigPaths } from "./status.js";
import { DEFAULT_TUNING, TUNING_KEYS, loadTuning } from "./tuning.js";
import type { InterceptStats } from "./interceptor.js";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A throwaway root with optional project/global config files (objects are JSON, strings written raw). */
function setup(
  files: { project?: unknown; global?: unknown } = {},
  env: Record<string, string | undefined> = {},
): { opts: ConfigOptions; warnings: string[]; root: string } {
  const root = mkdtempSync(join(tmpdir(), "paradoc-controls-"));
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
    writeFileSync(path, typeof files[scope] === "string" ? files[scope] : JSON.stringify(files[scope]), "utf8");
  }
  return { opts, warnings, root };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function parse(raw: string | undefined): ControlAction {
  return parseControlArgs(raw);
}

/** Every error message must name the accepted keys and show an example. */
function assertActionable(message: string): void {
  assert.match(message, new RegExp(`keys: ${TUNING_KEYS.join(", ")}`));
  assert.match(message, /example: paradoc set thresholdLines 500/);
  assert.match(message, /^paradoc: /);
}

describe("parseControlArgs", () => {
  it("empty input means status", () => {
    for (const raw of ["", "   ", undefined]) assert.deepStrictEqual(parse(raw), { action: "status" });
  });

  it("parses status", () => {
    assert.deepStrictEqual(parse("status"), { action: "status" });
  });

  it("rejects options on status", () => {
    const action = parse("status --global");
    assert.strictEqual(action.action, "error");
    assert.match((action as { message: string }).message, /status takes no key or scope/);
    assertActionable((action as { message: string }).message);
  });

  it("parses set with a numeric value and defaults to project scope", () => {
    assert.deepStrictEqual(parse("set thresholdLines 500"), {
      action: "set",
      key: "thresholdLines",
      value: 500,
      scope: "project",
    });
  });

  it("coerces every numeric key from its string spelling", () => {
    const cases: Array<[string, number]> = [
      ["set timeoutMs 1500", 1500],
      ["set concurrency 4", 4],
      ["set chunkLines 100", 100],
      ["set chunkOverlapLines 10", 10],
      ["set cacheMaxEntries 0", 0],
      ["set minTokens 250", 250],
      ["set thresholdTokens 9000", 9000],
      ["set pdfTimeoutMs 2000", 2000],
      ["set pdfMaxChars 12000", 12000],
    ];
    for (const [raw, value] of cases) {
      const action = parse(raw);
      assert.strictEqual(action.action, "set");
      assert.strictEqual((action as { value: unknown }).value, value, raw);
    }
  });

  it("accepts the three judge modes verbatim", () => {
    for (const mode of ["off", "low-confidence", "always"] as const) {
      assert.deepStrictEqual(parse(`set judge ${mode}`), { action: "set", key: "judge", value: mode, scope: "project" });
    }
  });

  it("rejects an unknown judge mode with the accepted spelling", () => {
    const action = parse("set judge sometimes");
    assert.strictEqual(action.action, "error");
    assert.match((action as { message: string }).message, /expected off, low-confidence or always/);
    assertActionable((action as { message: string }).message);
  });

  it("accepts cacheMaxEntries off as 0 (mirrors PARADOC_CACHE=off)", () => {
    assert.deepStrictEqual(parse("set cacheMaxEntries off"), { action: "set", key: "cacheMaxEntries", value: 0, scope: "project" });
  });

  it("reports a missing key and a missing value separately", () => {
    const noKey = parse("set");
    assert.strictEqual(noKey.action, "error");
    assert.match((noKey as { message: string }).message, /set needs a key and a value/);
    assertActionable((noKey as { message: string }).message);

    const noValue = parse("set thresholdLines");
    assert.strictEqual(noValue.action, "error");
    assert.match((noValue as { message: string }).message, /set needs a value for thresholdLines/);
    assertActionable((noValue as { message: string }).message);
  });

  it("names TUNING_KEYS for an unknown key", () => {
    const action = parse("set threshold 500");
    assert.strictEqual(action.action, "error");
    assert.match((action as { message: string }).message, /unknown key "threshold"/);
    assertActionable((action as { message: string }).message);
  });

  it("rejects non-integer and below-minimum values with the rule that failed", () => {
    const notNumber = parse("set thresholdLines huge");
    assert.match((notNumber as { message: string }).message, /invalid value "huge" for thresholdLines: expected an integer/);

    const belowMin = parse("set thresholdLines 0");
    assert.match((belowMin as { message: string }).message, /expected an integer >= 1/);

    const float = parse("set timeoutMs 1.5");
    assert.match((float as { message: string }).message, /expected an integer/);

    for (const action of [notNumber, belowMin, float]) assertActionable((action as { message: string }).message);
  });

  it("honours --global and --project in either position", () => {
    assert.deepStrictEqual(parse("set thresholdLines 500 --global"), {
      action: "set", key: "thresholdLines", value: 500, scope: "global",
    });
    assert.deepStrictEqual(parse("set --global thresholdLines 500"), {
      action: "set", key: "thresholdLines", value: 500, scope: "global",
    });
    assert.deepStrictEqual(parse("set thresholdLines 500 --project"), {
      action: "set", key: "thresholdLines", value: 500, scope: "project",
    });
  });

  it("rejects combining --global with --project", () => {
    const action = parse("set thresholdLines 500 --global --project");
    assert.strictEqual(action.action, "error");
    assert.match((action as { message: string }).message, /cannot be combined/);
  });

  it("rejects unknown options and extra positional arguments", () => {
    assert.match((parse("set thresholdLines -5") as { message: string }).message, /unknown option "-5"/);
    assert.match((parse("set thresholdLines 500 600") as { message: string }).message, /unexpected extra argument "600"/);
    assert.match((parse("status extra") as { message: string }).message, /status takes no key or scope/);
  });

  it("parses reset with and without a key", () => {
    assert.deepStrictEqual(parse("reset"), { action: "reset", scope: "project" });
    assert.deepStrictEqual(parse("reset judge"), { action: "reset", key: "judge", scope: "project" });
    assert.deepStrictEqual(parse("reset thresholdLines --global"), { action: "reset", key: "thresholdLines", scope: "global" });
    assert.deepStrictEqual(parse("reset --global"), { action: "reset", scope: "global" });
  });

  it("rejects an unknown reset key or too many keys", () => {
    assert.match((parse("reset nope") as { message: string }).message, /unknown key "nope"/);
    assert.match((parse("reset judge concurrency") as { message: string }).message, /reset takes at most one key/);
  });

  it("rejects an unknown subcommand and shows usage for help", () => {
    const unknown = parse("show");
    assert.strictEqual(unknown.action, "error");
    assert.match((unknown as { message: string }).message, /unknown command "show"/);
    assertActionable((unknown as { message: string }).message);

    for (const raw of ["help", "-h", "--help"]) {
      assert.deepStrictEqual(parse(raw), { action: "error", message: CONTROL_USAGE });
    }
  });

  it("collapses arbitrary whitespace between tokens", () => {
    assert.deepStrictEqual(parse("  set   judge   always  "), { action: "set", key: "judge", value: "always", scope: "project" });
  });
});

describe("applySet / applyReset", () => {
  it("writes the parsed value to the project config and reports the path", () => {
    const s = setup();
    const action = parse("set thresholdLines 500");
    assert.strictEqual(action.action, "set");
    const parsed = action as { key: "thresholdLines"; scope: "project" };
    const result = applySet({ [parsed.key]: 500 }, parsed.scope, s.opts);

    assert.deepStrictEqual(result, { ok: true, path: configPath("project", s.opts) });
    const loaded = loadTuning(s.opts);
    assert.strictEqual(loaded.settings.thresholdLines, 500);
    assert.strictEqual(loaded.sources.thresholdLines, "project");
    assert.deepStrictEqual(s.warnings, []);
  });

  it("writes a global-scope value to the home config", () => {
    const s = setup();
    const result = applySet({ judge: "always" }, "global", s.opts);
    assert.deepStrictEqual(result, { ok: true, path: configPath("global", s.opts) });
    assert.strictEqual(loadTuning(s.opts).sources.judge, "global");
  });

  it("preserves model, version and unknown top-level keys", () => {
    const s = setup({
      project: {
        version: 1,
        model: { providerID: "openai", modelID: "mini" },
        custom: { keep: true },
        tuning: { timeoutMs: 5000 },
      },
    });
    const path = configPath("project", s.opts);
    applySet({ concurrency: 4 }, "project", s.opts);

    const written = readJson(path);
    assert.deepStrictEqual(written.model, { providerID: "openai", modelID: "mini" });
    assert.deepStrictEqual(written.custom, { keep: true });
    assert.strictEqual(written.version, 1);
    assert.deepStrictEqual(written.tuning, { timeoutMs: 5000, concurrency: 4 });
  });

  it("surfaces an unknown key as a message naming the accepted keys", () => {
    const s = setup();
    const result = applySet({ nope: 1 } as never, "project", s.opts);
    assert.strictEqual(result.ok, false);
    assert.match((result as { message: string }).message, /unknown tuning key "nope"/);
    assert.match((result as { message: string }).message, new RegExp(TUNING_KEYS.join(", ")));
  });

  it("surfaces the chunk-overlap consistency rule as an actionable fix", () => {
    const s = setup({ project: { version: 1, tuning: { chunkLines: 5 } } });
    const result = applySet({ chunkOverlapLines: 10 }, "project", s.opts);
    assert.strictEqual(result.ok, false);
    const message = (result as { message: string }).message;
    assert.match(message, /invalid tuning value for chunkOverlapLines/);
    assert.match(message, /must be smaller than chunkLines \(5\)/);
    assert.match(message, /set or clear chunkOverlapLines/);
    // The refusal left the file untouched.
    assert.deepStrictEqual(readJson(configPath("project", s.opts)).tuning, { chunkLines: 5 });
  });

  it("refuses to overwrite a corrupt config and names the path", () => {
    const s = setup({ project: "{ not json" });
    const result = applySet({ thresholdLines: 10 }, "project", s.opts);
    assert.strictEqual(result.ok, false);
    assert.match((result as { message: string }).message, /refusing to overwrite/);
    assert.ok((result as { message: string }).message.includes(configPath("project", s.opts)));
  });

  it("removes one key, then the whole tuning block, keeping other content", () => {
    const s = setup({
      project: {
        version: 1,
        model: { providerID: "p", modelID: "m" },
        tuning: { thresholdLines: 10, judge: "always" },
      },
    });
    const path = configPath("project", s.opts);

    const first = applyReset("project", s.opts, ["thresholdLines"]);
    assert.deepStrictEqual(first, { ok: true, path });
    assert.deepStrictEqual(readJson(path).tuning, { judge: "always" });

    const second = applyReset("project", s.opts);
    assert.deepStrictEqual(second, { ok: true, path });
    const after = readJson(path);
    assert.strictEqual("tuning" in after, false);
    assert.deepStrictEqual(after.model, { providerID: "p", modelID: "m" });
  });

  it("reports nothing to reset when there is no tuning block", () => {
    const missing = setup();
    assert.deepStrictEqual(applyReset("project", missing.opts), { ok: true, path: undefined });
    assert.deepStrictEqual(applyReset("project", missing.opts, ["judge"]), { ok: true, path: undefined });

    const noBlock = setup({ project: { version: 1, model: { providerID: "p", modelID: "m" } } });
    assert.deepStrictEqual(applyReset("project", noBlock.opts, ["judge"]), { ok: true, path: undefined });
    assert.deepStrictEqual(readJson(configPath("project", noBlock.opts)).model, { providerID: "p", modelID: "m" });
  });

  it("refuses a corrupt config on reset too", () => {
    const s = setup({ global: "nope" });
    const result = applyReset("global", s.opts);
    assert.strictEqual(result.ok, false);
    assert.ok((result as { message: string }).message.includes(configPath("global", s.opts)));
  });
});

describe("renderStatus", () => {
  const stats: InterceptStats = {
    intercepted: 3,
    passthrough: 1,
    bypassed: 2,
    fallbacks: 4,
    cacheHits: 5,
    delegations: 6,
    delegationMs: 1234,
    estTokensSaved: 4321,
    estTokensDelegated: 2100,
  };

  function statusFor(
    files: { project?: unknown; global?: unknown } = {},
    env: Record<string, string | undefined> = {},
    extra: { stats?: InterceptStats; warnings?: readonly string[]; model?: { choice?: { providerID: string; modelID: string }; source: "explicit" | "env" | "project" | "global" | "picker" | "none" } } = {},
  ): { text: string; s: ReturnType<typeof setup> } {
    const s = setup(files, env);
    const { settings, sources } = loadTuning(s.opts);
    const status = buildStatus({
      settings,
      sources,
      model: extra.model ?? { source: "none" },
      configPaths: statusConfigPaths(s.opts),
      ...(extra.stats ? { stats: extra.stats } : {}),
      ...(extra.warnings ? { warnings: extra.warnings } : {}),
    });
    return { text: renderStatus(status), s };
  }

  it("labels each setting with the source that won", () => {
    const { text, s } = statusFor(
      { project: { version: 1, tuning: { thresholdLines: 120 } }, global: { version: 1, tuning: { concurrency: 3 } } },
      { PARADOC_TIMEOUT_MS: "9000" },
    );
    assert.ok(text.includes(SOURCE_PRECEDENCE));
    assert.match(text, /^\s*thresholdLines\s+120\s+project$/m);
    assert.match(text, /^\s*concurrency\s+3\s+global$/m);
    assert.match(text, /^\s*timeoutMs\s+9000\s+env$/m);
    assert.match(text, /^\s*judge\s+off\s+default$/m);
    // Every key appears exactly once with a source label.
    for (const key of TUNING_KEYS) assert.match(text, new RegExp(`^\\s*${key}\\s+\\S+\\s+(explicit|env|project|global|default)$`, "m"));
    assert.strictEqual(s.warnings.length, 0);
  });

  it("prints the model choice with its source, or none", () => {
    const withModel = statusFor({}, {}, { model: { choice: { providerID: "openai", modelID: "mini" }, source: "project" } });
    assert.match(withModel.text, /^model: openai\/mini  project$/m);

    const none = statusFor();
    assert.match(none.text, /^model: none  none$/m);

    const picker = statusFor({}, {}, { model: { source: "picker" } });
    assert.match(picker.text, /^model: none  picker$/m);
  });

  it("prints both config paths so a wrong cwd is self-evident", () => {
    const { text, s } = statusFor();
    assert.ok(text.includes(`config (project): ${configPath("project", s.opts)}`));
    assert.ok(text.includes(`config (global):  ${configPath("global", s.opts)}`));
  });

  it("shows every InterceptStats counter when stats are present", () => {
    const { text } = statusFor({}, {}, { stats });
    assert.match(text, /stats: intercepted=3 passthrough=1 bypassed=2 fallbacks=4 cacheHits=5/);
    assert.match(text, /stats: delegations=6 delegationMs=1234 estTokensSaved=4321 estTokensDelegated=2100/);
  });

  it("omits the stats block when no interceptor exists for this root", () => {
    const { text } = statusFor();
    assert.strictEqual(text.includes("stats:"), false);
  });

  it("lists warnings when the snapshot has them and omits the block otherwise", () => {
    const withWarnings = statusFor({}, {}, { warnings: ["paradoc: ignoring /x: invalid JSON"] });
    assert.match(withWarnings.text, /warnings:\n {2}paradoc: ignoring \/x: invalid JSON$/);

    const without = statusFor();
    assert.strictEqual(without.text.includes("warnings:"), false);
  });

  it("renders defaults unchanged when nothing is configured", () => {
    const { text } = statusFor();
    for (const key of TUNING_KEYS) {
      assert.match(text, new RegExp(`^\\s*${key}\\s+${String(DEFAULT_TUNING[key])}\\s+default$`, "m"));
    }
  });
});

describe("renderChange", () => {
  it("reports the written path plus the restart hint", () => {
    const s = setup();
    const result: ChangeResult = applySet({ thresholdLines: 500 }, "project", s.opts);
    assert.strictEqual(renderChange("set", result), `wrote ${configPath("project", s.opts)}\n${RESTART_HINT}`);
  });

  it("reports a no-op reset without a restart hint", () => {
    const s = setup();
    assert.strictEqual(renderChange("reset", applyReset("project", s.opts)), "nothing to reset");
  });

  it("passes a write failure through as the message", () => {
    const s = setup({ project: "broken" });
    const result = applyReset("project", s.opts);
    assert.strictEqual(renderChange("reset", result), (result as { message: string }).message);
    assert.strictEqual(renderChange("set", result), (result as { message: string }).message);
  });
});

describe("set model", () => {
  it("parses provider/model, splitting on the first slash, into a set-model action", () => {
    assert.deepStrictEqual(parse("set model openrouter/qwen/qwen3-4b --global"), {
      action: "set-model",
      choice: { providerID: "openrouter", modelID: "qwen/qwen3-4b" },
      scope: "global",
    });
  });

  it("rejects a model value without a provider, with an actionable message", () => {
    const action = parse("set model haiku");
    assert.strictEqual(action.action, "error");
    assert.match((action as { message: string }).message, /expected provider\/model/);
    assertActionable((action as { message: string }).message);
  });

  it("writes the model to the project config and keeps the tuning keys untouched", () => {
    const s = setup({ project: { tuning: { timeoutMs: 5000 } } });
    const action = parse("set model opencode/gpt-5-nano");
    assert.strictEqual(action.action, "set-model");
    const result = applyModel((action as { choice: ModelChoice }).choice, "project", s.opts);

    assert.deepStrictEqual(result, { ok: true, path: configPath("project", s.opts) });
    const written = readJson(configPath("project", s.opts));
    assert.deepStrictEqual(written.model, { providerID: "opencode", modelID: "gpt-5-nano" });
    assert.deepStrictEqual(written.tuning, { timeoutMs: 5000 });
    assert.strictEqual(loadModelConfig(s.opts)?.choice.modelID, "gpt-5-nano");
  });
});
