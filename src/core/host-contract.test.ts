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
  package: { checkout: string; published: string };
  branch: { headCommit: string; tagBranches?: Record<string, string[]> };
  runs: EvidenceRun[];
}

const doc = readFileSync(resolve(root, DOC), "utf8");
const evidence: Evidence = JSON.parse(readFileSync(resolve(root, EVIDENCE), "utf8"));

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

  it("documents the offset-only eligibility rule and the bare-limit policy", () => {
    ok(doc.includes("offset"), "no offset rule");
    ok(/bare `limit`/.test(doc), "bare-limit policy missing");
  });

  it("states the host-spawned subagent interception policy", () => {
    ok(/ARE intercepted/.test(doc), "subagent interception policy missing");
  });
});

describe("M008 reproduction evidence JSON", () => {
  it("has a package block with checkout and published versions", () => {
    ok(evidence.package && typeof evidence.package === "object", "missing package block");
    strictEqual(typeof evidence.package.checkout, "string");
    strictEqual(typeof evidence.package.published, "string");
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
});
