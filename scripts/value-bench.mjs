#!/usr/bin/env node
// Value harness: run the representative corpus through native + ParaDoc paths on all three hosts and
// report token savings, latency, fallback rate and answer-quality proxies by source type and host.
// Hermetic: canned transports, a content-derived simulated cheap model, fixtures generated at runtime.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const USAGE = `usage: value-bench [--out <jsonl>] [--profiles a,b] [--latency ms] [--timeout ms]
                    [--iterations n] [--judge off|low-confidence|always] [--check] [--json]
                    [--failure-profiles]   failure-only validation (invalid-json,timeout): asserts native
                                           preservation and fallback reasons, no savings gates`;

function fail(message) {
  console.error(`value-bench: ${message}\n${USAGE}`);
  process.exit(1);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      out: { type: "string" },
      profiles: { type: "string" },
      latency: { type: "string", default: "20" },
      timeout: { type: "string", default: "1000" },
      iterations: { type: "string", default: "1" },
      judge: { type: "string", default: "off" },
      check: { type: "boolean", default: false },
      "failure-profiles": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  }));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const latency = Number.parseInt(values.latency, 10);
const timeoutMs = Number.parseInt(values.timeout, 10);
const iterations = Number.parseInt(values.iterations, 10);
if (!Number.isInteger(latency) || latency < 0) fail("--latency must be an integer >= 0");
if (!Number.isInteger(timeoutMs) || timeoutMs < 1) fail("--timeout must be an integer >= 1");
if (!Number.isInteger(iterations) || iterations < 1) fail("--iterations must be an integer >= 1");
if (!["off", "low-confidence", "always"].includes(values.judge)) fail(`--judge must be off, low-confidence or always (got "${values.judge}")`);

const distDir = join(import.meta.dirname, "..", "dist", "value");
if (!existsSync(join(distDir, "corpus.js"))) {
  console.error("value-bench: dist/value/ not found; run npm run build first");
  process.exit(1);
}
const load = async (name) => import(pathToFileURL(join(distDir, name)).href);
const { materializeCorpus } = await load("corpus.js");
const { ACCURACY_PROFILES, SimulatedCheapModel } = await load("sim-runner.js");
const { HOST_NAMES, createHosts } = await load("hosts.js");
const { aggregate, runMatrix } = await load("measure.js");
const { FAILURE_PROFILE_REASONS, HEADLINE_PROFILE, isPositiveRecord, SOURCE_THRESHOLDS, evaluateThresholds } = await load("thresholds.js");

const failureMode = values["failure-profiles"];
const failureProfileNames = Object.keys(FAILURE_PROFILE_REASONS);
const defaultProfiles = failureMode ? failureProfileNames.join(",") : ACCURACY_PROFILES.join(",");
const profiles = (values.profiles ?? defaultProfiles).split(",").map((p) => p.trim()).filter(Boolean);
if (profiles.length === 0) fail("--profiles must list at least one profile");
const unknown = profiles.filter((p) => !ACCURACY_PROFILES.includes(p));
if (unknown.length > 0) fail(`--profiles contains unknown profile(s): ${unknown.join(", ")} (valid: ${ACCURACY_PROFILES.join(", ")})`);
if (profiles.length !== new Set(profiles).size) fail("--profiles contains duplicates");

if (failureMode) {
  const nonFailure = profiles.filter((p) => !failureProfileNames.includes(p));
  if (nonFailure.length > 0) fail(`--failure-profiles only accepts ${failureProfileNames.join(", ")}; --profiles contains ${nonFailure.join(", ")}`);
}

const outPath = values.out ? resolve(values.out) : undefined;

const dir = mkdtempSync(join(tmpdir(), "paradoc-value-"));
let exitCode = 0;
try {
  const corpus = materializeCorpus(dir);
  const records = [];
  const skippedRuns = [];
  for (let i = 0; i < iterations; i += 1) {
    const result = await runMatrix({
      corpus,
      hosts: createHosts(),
      profiles,
      latencyMs: latency,
      timeoutMs,
      judge: values.judge,
      runnerFactory: ({ item, profile, latencyMs }) =>
        new SimulatedCheapModel({ profile, needles: item.goldNeedles, latencyMs }),
    });
    records.push(...result.records);
    skippedRuns.push(...result.skipped);
  }

  const aggregates = aggregate(records);
  // The printed table is the headline profile only: mixing accuracy profiles into one savings mean
  // would report a savings figure no real run ever produced. Every profile stays in the JSONL.
  const headlineRows = aggregate(records.filter((r) => r.profile === HEADLINE_PROFILE));

  // Source types whose only positive fixture was skipped by the corpus (e.g. pdftotext absent) cannot
  // be threshold-checked; report them instead of inventing a violation.
  const positiveTypes = new Set(corpus.items.filter((item) => item.expected === "intercept").map((item) => item.sourceType));
  const skippedTypes = [...new Set(corpus.skipped.map((s) => s.sourceType))].filter((type) => !positiveTypes.has(type));

  const report = evaluateThresholds(aggregates, records, { simulatedLatencyMs: latency, skipSourceTypes: skippedTypes, mode: failureMode ? "failure-profile" : "headline" });

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  }

  if (values.json) {
    console.log(JSON.stringify({
      corpus: { dir: "<temp>", items: corpus.items.length, skipped: corpus.skipped, generatedAt: new Date().toISOString() },
      options: { profiles, latencyMs: latency, timeoutMs, iterations, judge: values.judge },
      hosts: HOST_NAMES,
      records: records.length,
      skippedPairs: skippedRuns.length,
      thresholds: SOURCE_THRESHOLDS,
      report,
      aggregates,
    }));
  } else {
    console.log(`corpus: ${corpus.items.length} items, ${corpus.skipped.length} skipped (${corpus.skipped.map((s) => `${s.id}:${s.reason}`).join(", ") || "none"})`);
    console.log(`profiles: ${profiles.join(",")} | simulated latency: ${latency}ms | deadline: ${timeoutMs}ms | iterations: ${iterations} | judge: ${values.judge}`);
    console.log(`records: ${records.length} (${corpus.items.length} items x ${HOST_NAMES.length} hosts - ${skippedRuns.length} unsupported pairs x ${profiles.length} profiles) x ${iterations} iteration(s)`);
    if (failureMode) {
      console.log(`table below: positive items under failure profiles ${profiles.join(",")} — no savings gates apply${outPath ? ` (JSONL: ${outPath})` : ""}`);
      console.log("");
      console.log("sourceType       host            profile       n  fallback%  fallback reason     native preserved");
      for (const profile of profiles) {
        for (const row of aggregate(records.filter((r) => r.profile === profile && isPositiveRecord(r)))) {
          const reasonList = Object.entries(row.fallbackReasons).map(([k, v]) => `${k}=${v}`).join(",") || "none";
          const positives = records.filter((r) => r.profile === profile && isPositiveRecord(r) && r.sourceType === row.sourceType && r.host === row.host);
          const preserved = positives.filter((r) => r.nativePreserved).length;
          console.log(
            row.sourceType.padEnd(15),
            row.host.padEnd(14),
            profile.padEnd(13),
            String(row.n).padStart(2),
            (row.fallbackRate * 100).toFixed(0).padStart(10),
            reasonList.padEnd(19),
            `${preserved}/${positives.length}`,
          );
        }
      }
    } else {
    console.log(`table below: profile "${HEADLINE_PROFILE}" only — every profile is in the JSONL${outPath ? ` (${outPath})` : ""}`);
    console.log("");
    console.log("sourceType       host            n  savings%   netSav%  p50(ms)  p95(ms)  intercept%  fallback%   gold  judge%");
    for (const row of headlineRows) {
      console.log(
        row.sourceType.padEnd(15),
        row.host.padEnd(14),
        String(row.n).padStart(3),
        row.savingsPctMean.toFixed(1).padStart(9),
        row.netSavingsPctMean.toFixed(1).padStart(9),
        row.latencyP50Ms.toFixed(0).padStart(7),
        row.latencyP95Ms.toFixed(0).padStart(7),
        (row.interceptionRate * 100).toFixed(0).padStart(11),
        (row.fallbackRate * 100).toFixed(0).padStart(10),
        row.goldCoverageMean.toFixed(2).padStart(6),
        (row.judgeSufficientRate === null ? "n/a" : `${(row.judgeSufficientRate * 100).toFixed(0)}%`).padStart(7),
      );
    }
    }
    console.log("");
    const reasons = {};
    for (const row of aggregates) for (const [reason, n] of Object.entries(row.fallbackReasons)) reasons[reason] = (reasons[reason] ?? 0) + n;
    console.log(`fallback reasons: ${Object.entries(reasons).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`);
    if (skippedTypes.length > 0) console.log(`thresholds skipped for: ${skippedTypes.join(", ")} (no positive fixture available)`);
  }

  if (values.check) {
    const label = failureMode ? "failure-profile checks" : "thresholds";
    if (report.ok) {
      console.log(`${label}: PASS`);
    } else {
      console.error(`${label}: FAIL (${report.violations.length} violation(s))`);
      for (const v of report.violations) console.error(`  ${v.name} [${v.scope}] measured=${v.measured} limit=${v.limit} — ${v.detail}`);
      exitCode = 1;
    }
  }
} catch (error) {
  console.error(`value-bench: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
