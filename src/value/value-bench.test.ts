import { ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "value-bench.mjs");

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "paradoc-value-cli-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 120_000 });
}

const RECORD_KEYS = [
  "id", "sourceType", "host", "profile", "nativeEstTokens", "renderedEstTokens", "estTokensSaved",
  "estTokensDelegated", "netEstTokensSaved", "savingsPct", "netSavingsPct", "elapsedMs", "chunks",
  "attempts", "cacheHit", "fallbackReason", "resultFallbackReason", "reasonsAgree", "goldCoverage",
  "needlePresent", "omittedRangeCount", "nativePreserved", "savingsMeasurable", "contained",
  "expectedOutcome", "observedOutcome", "outcomeMatchesExpected",
] as const;

describe("scripts/value-bench.mjs", () => {
  it("prints a per sourceType x host table, passes --check and writes one JSONL record per run", () => {
    const out = join(dir, "records.jsonl");
    const result = run(["--out", out, "--latency", "5", "--timeout", "120", "--iterations", "1", "--check"]);
    strictEqual(result.status, 0, result.stderr);

    const lines = result.stdout.trim().split("\n");
    const header = lines.find((l) => l.startsWith("sourceType"));
    ok(header, `no table header in:\n${result.stdout}`);
    ok(/^sourceType\s+host\s+n\s+savings%\s+netSav%\s+p50\(ms\)\s+p95\(ms\)\s+intercept%\s+fallback%\s+gold\s+judge%$/.test(header!), header);

    for (const type of ["source", "text-document", "pdf-text", "web-page"]) {
      // "source" must not match the "sourceType" header row.
      const row = lines.find((l) => new RegExp(`^${type}(?=\\s)`).test(l));
      ok(row, `no table row for ${type}`);
      const match = row!.match(/^\S+\s+\S+\s+(\d+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)$/);
      ok(match, `row for ${type} is not parseable: ${row}`);
      ok(Number(match[1]) > 0, `${type} row has n=0`);
    }

    ok(result.stdout.includes("thresholds: PASS"), `--check did not pass:\n${result.stderr}`);

    const records = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const declared = Number(/records: (\d+)/.exec(result.stdout)?.[1]);
    strictEqual(records.length, declared, "JSONL line count does not match the reported record count");
    ok(records.length > 0);
    for (const record of records) {
      for (const key of RECORD_KEYS) ok(record[key] !== undefined, `record missing ${key}: ${record.id}`);
    }
    strictEqual(new Set(records.map((r) => r.host)).size, 3, "expected all three hosts");
    strictEqual(new Set(records.map((r) => r.sourceType)).size, 4, "expected all four source types");
    // One record per item x host x profile: ids repeat across hosts and profiles only.
    const triples = new Set(records.map((r) => `${r.id}|${r.host}|${r.profile}`));
    strictEqual(triples.size, records.length, "duplicate item x host x profile records");
  });

  it("honours --profiles and --iterations", () => {
    const out = join(dir, "subset.jsonl");
    const result = run(["--out", out, "--profiles", "correct,partial", "--latency", "2", "--timeout", "120", "--iterations", "2"]);
    strictEqual(result.status, 0, result.stderr);
    const records = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    strictEqual(new Set(records.map((r) => r.profile)).size, 2, "expected exactly the two requested profiles");
    strictEqual(new Set(records.map((r) => `${r.id}|${r.host}|${r.profile}`)).size, records.length / 2, "iterations did not duplicate each run");
    ok(result.stdout.includes("iterations: 2"), result.stdout.split("\n")[1]);
  });

  it("--json emits the machine-readable report with thresholds and aggregates", () => {
    const result = run(["--json", "--profiles", "correct", "--latency", "2", "--timeout", "120"]);
    strictEqual(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      records: number;
      skippedPairs: number;
      report: { ok: boolean; violations: unknown[] };
      aggregates: Array<{ sourceType: string; host: string; n: number }>;
      thresholds: Record<string, { minSavingsPct: number }>;
    };
    strictEqual(payload.report.ok, true, JSON.stringify(payload.report.violations));
    ok(payload.aggregates.length >= 4, "expected a row per source type x host");
    strictEqual(Object.keys(payload.thresholds).length, 4);
    ok(payload.skippedPairs > 0, "web items must be reported as unsupported on the hook hosts");
  });

  it("rejects invalid arguments with exit 1", () => {
    const cases: string[][] = [
      ["--profiles", "correct,not-a-profile"],
      ["--profiles", ""],
      ["--latency", "-5"],
      ["--latency", "abc"],
      ["--iterations", "0"],
      ["--timeout", "0"],
      ["--judge", "sometimes"],
      ["--unknown-flag"],
    ];
    for (const args of cases) {
      const result = run(args);
      strictEqual(result.status, 1, `expected exit 1 for ${args.join(" ")}\n${result.stdout}`);
      ok(result.stderr.includes("value-bench:"), `no diagnostic for ${args.join(" ")}: ${result.stderr}`);
    }
  });

  it("--failure-profiles --check passes on failure profiles only, without savings gates", () => {
    const result = run(["--failure-profiles", "--check", "--latency", "2", "--timeout", "120"]);
    strictEqual(result.status, 0, result.stderr);
    ok(result.stdout.includes("failure-profile checks: PASS"), result.stdout);
    ok(result.stdout.includes("profiles: invalid-json,timeout"), result.stdout);
    ok(result.stdout.includes("fallback reason"), result.stdout);
    ok(result.stdout.includes("invalid-response=") && result.stdout.includes("timeout="), result.stdout);
    ok(!result.stdout.includes("savings%"), "failure mode must not print the savings table");
    ok(!result.stdout.includes("thresholds:"), result.stdout);
  });

  it("rejects --failure-profiles combined with a non-failure profile", () => {
    const result = run(["--failure-profiles", "--profiles", "correct", "--latency", "2", "--timeout", "120"]);
    strictEqual(result.status, 1, result.stdout);
    ok(result.stderr.includes("correct"), result.stderr);
  });

  it("the plain failure-profile --profiles command still fails the headline guard with the hint", () => {
    const result = run(["--profiles", "invalid-json,timeout", "--check", "--latency", "2", "--timeout", "120"]);
    strictEqual(result.status, 1, result.stdout);
    ok(result.stderr.includes("noPositiveRecords"), result.stderr);
    ok(result.stderr.includes("--failure-profiles"), result.stderr);
  });

  it("reports a failing threshold check with the offending names and exits 1", () => {
    // A simulated model slower than the interceptor deadline makes every intercepted positive item
    // fall back on timeout, which must trip the per-type fallback-rate ceiling rather than pass silently.
    const result = run(["--profiles", "correct", "--latency", "20", "--timeout", "1", "--check"]);
    strictEqual(result.status, 1, `expected a threshold failure:\n${result.stdout}`);
    ok(result.stderr.includes("thresholds: FAIL"), result.stderr);
    ok(result.stderr.includes("maxFallbackRate"), result.stderr);
    for (const type of ["source", "text-document", "pdf-text", "web-page"]) {
      ok(result.stderr.includes(`${type}.maxFallbackRate`), `missing ${type}.maxFallbackRate in:\n${result.stderr}`);
    }
  });
});
