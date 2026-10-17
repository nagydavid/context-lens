// Baseline vs optimized interception on real files, with a fake cheap model that returns the first
// 40 lines. Counts are measured; token figures are chars/4 estimates. Latency needs a live runner.
import { readFileSync } from "node:fs";
import { ReadInterceptor, FakeSubagentRunner } from "../dist/core/index.js";

const files = process.argv.slice(2);
if (files.length === 0) files.push(...["src/core/interceptor.ts", "src/core/config.ts", "src/copilot-cli/mcp-server.ts", "README.md", "package-lock.json"]);
const answer = { excerpts: [{ startLine: 1, endLine: 40 }], summary: "bench", confidence: 4 };
const reads = [...files, ...files]; // each file read twice, as agents do

async function run(label, options) {
  const runner = new FakeSubagentRunner({ structured: answer });
  const i = new ReadInterceptor({ runner, ...options });
  let primary = 0;
  for (const filePath of reads) {
    const r = await i.intercept({ filePath, question: "bench?", agentContext: {} });
    primary += Math.ceil(r.excerpts.map((e) => e.content).join("\n").length / 4);
  }
  const s = i.stats();
  console.log(`${label.padEnd(10)} model calls=${runner.calls.length} cacheHits=${s.cacheHits} passthrough=${s.passthrough} ` +
    `primary tokens≈${primary} cheap-model tokens≈${s.estTokensDelegated}`);
}
await run("baseline", { minTokens: 0, thresholdTokens: Infinity, cacheSize: 0 });
await run("optimized", {});
const raw = reads.reduce((n, f) => n + Math.ceil(readFileSync(f, "utf8").length / 4), 0);
console.log(`no-lens    primary tokens≈${raw}`);
