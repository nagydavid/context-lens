#!/usr/bin/env node
// Hermetic benchmark: serial vs parallel vs cached chunked reads with a fake runner.
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "20" },
    latency: { type: "string", default: "25" },
  },
});
const iterations = Number.parseInt(values.iterations, 10);
const latency = Number.parseInt(values.latency, 10);
if (!Number.isInteger(iterations) || iterations < 1 || !Number.isInteger(latency) || latency < 0) {
  console.error("bench: --iterations must be an integer >= 1 and --latency an integer >= 0");
  process.exit(1);
}

const coreIndex = join(import.meta.dirname, "..", "dist", "core", "index.js");
if (!existsSync(coreIndex)) {
  console.error("bench: dist/core/index.js not found; run npm run build first");
  process.exit(1);
}
const { ConcurrencyLimitedRunner, FakeSubagentRunner, LruResultCache, ReadInterceptor } = await import(pathToFileURL(coreIndex).href);

const model = { providerID: "bench", modelID: "fake" };
const handler = (request) => {
  const match = request.prompt.match(/This is lines (\d+)-(\d+)/);
  const start = match ? Number(match[1]) : 1;
  return { structured: { excerpts: [{ startLine: start, endLine: start + 4 }], summary: `bench ${start}`, confidence: 4 } };
};

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

async function measure(filePath, concurrency, cache) {
  const runner = new ConcurrencyLimitedRunner(new FakeSubagentRunner(handler, latency), concurrency);
  const interceptor = new ReadInterceptor({
    runner, model, thresholdLines: 1, chunkLines: 500, chunkOverlapLines: 50, ...(cache ? { cache } : {}),
  });
  const request = { filePath, agentContext: {}, question: "where is the answer?" };
  if (cache) {
    const warm = await interceptor.intercept(request);
    if (!warm.wasIntercepted) throw new Error("warm-up read was not intercepted");
  }
  const times = [];
  let saved = 0;
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const result = await interceptor.intercept(request);
    times.push(performance.now() - start);
    if (!result.wasIntercepted) throw new Error("read was not intercepted");
    if (cache && result.cacheHit !== true) throw new Error("expected cache hit after warm-up");
    saved = result.contextSaved;
  }
  times.sort((a, b) => a - b);
  return { p50: percentile(times, 50), p95: percentile(times, 95), saved };
}

const dir = await mkdtemp(join(tmpdir(), "context-lens-bench-"));
try {
  const filePath = join(dir, "large.txt");
  await writeFile(filePath, Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n"));
  const rows = [
    ["serial", await measure(filePath, 1)],
    ["parallel", await measure(filePath, 4)],
    ["cached", await measure(filePath, 4, new LruResultCache())],
  ];
  console.log(`mode      ${"p50(ms)".padStart(9)}  ${"p95(ms)".padStart(9)}  contextSaved`);
  for (const [mode, r] of rows) {
    console.log(`${mode.padEnd(9)} ${r.p50.toFixed(2).padStart(9)}  ${r.p95.toFixed(2).padStart(9)}  ${String(r.saved).padStart(11)}%`);
  }
} catch (error) {
  console.error(`bench: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
