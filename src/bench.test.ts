import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";

describe("scripts/bench.mjs", () => {
  it("prints serial, parallel and cached rows with parallel and cached faster than serial", () => {
    const script = join(import.meta.dirname, "..", "scripts", "bench.mjs");
    const run = spawnSync(process.execPath, [script, "--iterations", "3", "--latency", "5"], { encoding: "utf8", timeout: 20_000 });
    strictEqual(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split("\n");
    ok(/^mode\s+p50\(ms\)\s+p95\(ms\)\s+contextSaved$/.test(lines[0]), `header: ${lines[0]}`);
    const rows: Record<string, { p50: number; p95: number; saved: number }> = {};
    for (const mode of ["serial", "parallel", "cached"]) {
      const line = lines.find((l) => l.startsWith(mode));
      const match = line?.match(/^\w+\s+([\d.]+)\s+([\d.]+)\s+(\d+)%$/);
      ok(match, `row for ${mode}: ${line}`);
      rows[mode] = { p50: Number(match[1]), p95: Number(match[2]), saved: Number(match[3]) };
    }
    ok(rows.parallel.p50 < rows.serial.p50, "parallel p50 < serial p50");
    ok(rows.cached.p50 < rows.serial.p50, "cached p50 < serial p50");
  });

  it("rejects invalid arguments", () => {
    const script = join(import.meta.dirname, "..", "scripts", "bench.mjs");
    const run = spawnSync(process.execPath, [script, "--iterations", "0"], { encoding: "utf8" });
    strictEqual(run.status, 1);
  });
});
