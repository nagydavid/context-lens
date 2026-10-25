import { ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Compiled to dist/core/, so the repo root is two levels up.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Only git-tracked docs/ artifacts are read here — never .gsd/ working files.
const DOC = "docs/m008-host-interception-contract.md";
const EVIDENCE = "docs/m008-repro-evidence.json";
const FRESH_EVIDENCE = "docs/m008-fresh-install-evidence.json";

interface EvidenceRun {
  host: string;
  scenario: string;
  status: string;
  model?: string | null;
  expectedFailure?: boolean;
  interception?: {
    interceptedCount?: number;
    excerptLines?: number;
    fileLines?: number;
    confidence?: number;
    elapsedMs?: number;
  };
}
interface Evidence {
  package: { version: string; checkout: string; published: string };
  branch: { headCommit: string; tagBranches?: Record<string, string[]> };
  runs: EvidenceRun[];
}

const doc = readFileSync(resolve(root, DOC), "utf8");
const evidence: Evidence = JSON.parse(readFileSync(resolve(root, EVIDENCE), "utf8"));

// The installed-artifact proof (S03). Read defensively: the section only has to quote whatever
// the harness actually recorded.
let fresh: { installedVersion?: string; source?: { sha256?: string }; runs?: { host: string; scenario: string; status: string; elapsedMs?: number; interceptedCount?: number }[] } | null = null;
try {
  fresh = JSON.parse(readFileSync(resolve(root, FRESH_EVIDENCE), "utf8"));
} catch {
  fresh = null;
}

const headings = [
  "## Verified host versions",
  "## OpenCode contract",
  "## Copilot contract",
  "## Model id aliasing",
  "## Recursion prevention",
  "## Decisions",
  "## S02 work items",
  "## Known risks",
];

// Contract vocabulary S02 must implement against; each must appear verbatim.
const requiredTerms = [
  "ctx.tool.transform",
  "plugins",
  "COPILOT_MODEL_ALIASES",
  "PARADOC_CHILD",
  "milestone/M007",
];

describe("M008 host interception contract doc", () => {
  for (const heading of headings) {
    it(`has heading "${heading}"`, () => {
      ok(doc.includes(heading), `missing heading: ${heading}`);
    });
  }

  for (const term of requiredTerms) {
    it(`mentions ${term}`, () => {
      ok(doc.includes(term), `missing term: ${term}`);
    });
  }

  it("stays under 300 lines", () => {
    const lines = doc.split("\n").length;
    ok(lines < 300, `contract doc is ${lines} lines`);
  });

  it("links the reproduction evidence artifact", () => {
    ok(doc.includes("docs/m008-repro-evidence.json"), "no link to the evidence JSON");
  });

  it("documents fresh-install acceptance and links the installed-artifact evidence", () => {
    ok(doc.includes("## Fresh-install acceptance"), "missing Fresh-install acceptance section");
    ok(
      doc.includes("docs/m008-fresh-install-evidence.json"),
      "no link to the fresh-install (installed-artifact) evidence JSON"
    );
  });

  it("documents the offset-only eligibility rule and the bare-limit policy", () => {
    ok(doc.includes("offset"), "no offset rule");
    ok(/bare `limit`/.test(doc), "bare-limit policy missing");
  });

  it("states the host-spawned subagent interception policy", () => {
    ok(/ARE intercepted/.test(doc), "subagent interception policy missing");
  });
});

describe("M008 reproduction evidence JSON", () => {
  it("has a package block with version, checkout and published versions", () => {
    ok(evidence.package && typeof evidence.package === "object", "missing package block");
    strictEqual(typeof evidence.package.version, "string", "package.version missing");
    strictEqual(typeof evidence.package.checkout, "string");
    strictEqual(typeof evidence.package.published, "string");
    // The release stamp and the checkout stamp must not disagree.
    strictEqual(
      evidence.package.version,
      evidence.package.checkout,
      "package.version must equal package.checkout"
    );
  });

  it("has a branch block with head commit and tag branches", () => {
    ok(evidence.branch && typeof evidence.branch === "object", "missing branch block");
    strictEqual(typeof evidence.branch.headCommit, "string");
    ok(evidence.branch.tagBranches && typeof evidence.branch.tagBranches === "object", "missing tagBranches");
  });

  it("has runs with host/scenario/status fields and valid statuses", () => {
    ok(Array.isArray(evidence.runs) && evidence.runs.length > 0, "runs[] missing");
    const allowed = new Set(["PASS", "FAIL", "SKIP"]);
    for (const run of evidence.runs) {
      strictEqual(typeof run.host, "string", `run missing host: ${JSON.stringify(run)}`);
      strictEqual(typeof run.scenario, "string", `run missing scenario: ${JSON.stringify(run)}`);
      ok(allowed.has(run.status), `invalid status ${run.status} for ${run.host}/${run.scenario}`);
    }
  });

  it("records the live PASS runs on both hosts including the aliased default-model run", () => {
    const byKey = new Map<string, EvidenceRun>(
      evidence.runs.map((r) => [`${r.host}-${r.scenario}`, r])
    );
    // Every scenario the slice demo depends on: a normal read condensed on each host, the
    // large fan-out run, the offset/range pass-through run, and the run that relies on
    // COPILOT_MODEL_ALIASES for the global default model (no longer a labelled failure).
    const expectedPass = ["opencode-happy", "opencode-large", "copilot-happy", "copilot-pass-through", "copilot-default-model"];
    for (const key of expectedPass) {
      const run = byKey.get(key);
      ok(run, `${key} run missing from evidence`);
      strictEqual(run.status, "PASS", `${key} did not PASS`);
      strictEqual(run.expectedFailure, undefined, `${key} must not be labelled expectedFailure`);
    }
    const aliased = byKey.get("copilot-default-model")!;
    ok(
      typeof aliased.model === "string" && aliased.model.includes("claude-haiku-5-5"),
      `copilot-default-model must run the unaliased global default model, got ${aliased.model}`
    );
    const passThrough = byKey.get("copilot-pass-through")!;
    strictEqual(
      passThrough.interception?.interceptedCount,
      0,
      "pass-through run must record zero interceptions (offset-only eligibility rule)"
    );
  });

  it("contract doc quotes the same happy-run statuses as the evidence", () => {
    for (const run of evidence.runs) {
      if (run.status !== "PASS") continue;
      ok(
        doc.includes(`${run.host} / ${run.scenario}`),
        `doc does not reference ${run.host} / ${run.scenario}`
      );
    }
  });

  // The doc claims "every status, version, and number here matches" the evidence, so the numbers
  // are asserted too: a regenerated evidence file with a stale doc row fails here instead of
  // silently publishing a wrong number (see L041: evidence + doc must be updated together).
  it("quotes the measured elapsed time of every PASS run in its own table row", () => {
    const freshStart = doc.indexOf("## Fresh-install acceptance");
    ok(freshStart > 0, "Fresh-install acceptance section missing");
    const checkoutRegion = doc.slice(0, freshStart);
    const freshRegion = doc.slice(freshStart);

    const rowFor = (region: string, host: string, scenario: string) =>
      region.split("\n").find((line) => line.startsWith(`| ${host} / ${scenario} |`));

    for (const run of evidence.runs) {
      if (run.status !== "PASS" || run.interception?.elapsedMs === undefined) continue;
      const row = rowFor(checkoutRegion, run.host, run.scenario);
      ok(row, `no contract-doc table row for ${run.host} / ${run.scenario}`);
      const quoted = `${Math.round(run.interception.elapsedMs)} ms`;
      ok(row.includes(quoted), `doc row for ${run.host} / ${run.scenario} does not quote ${quoted}: ${row}`);
    }

    if (!fresh) return;
    for (const run of fresh.runs ?? []) {
      if (run.status !== "PASS" || typeof run.elapsedMs !== "number") continue;
      const row = rowFor(freshRegion, run.host, run.scenario);
      ok(row, `no fresh-install table row for ${run.host} / ${run.scenario}`);
      const quoted = `${Math.round(run.elapsedMs)} ms`;
      ok(row.includes(quoted), `fresh row for ${run.host} / ${run.scenario} does not quote ${quoted}: ${row}`);
    }
  });

  it("fresh-install section quotes the installed version and artifact hash it was generated from", () => {
    if (!fresh) return; // artifact not present yet (e.g. a partial checkout)
    ok(typeof fresh.installedVersion === "string" && fresh.installedVersion.length > 0, "fresh evidence has no installedVersion");
    ok(
      doc.includes(fresh.installedVersion),
      `doc does not state installedVersion ${fresh.installedVersion}`
    );
    if (fresh.source?.sha256) {
      ok(doc.includes(fresh.source.sha256), `doc does not quote the artifact sha256 ${fresh.source.sha256}`);
    }
  });
});
