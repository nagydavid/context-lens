# ParaDoc M006: value validation (slice S02)

Purpose: the citable numbers M006/S03 and milestone acceptance need, plus an honest statement of what
hermetic numbers do **not** prove. Every figure below is copied from a real harness run
(`npm run value`, simulated model latency 20 ms, interceptor deadline 1000 ms, judge off, 1 iteration,
280 records). Nothing here is estimated by hand.

## Idea

ParaDoc claims that a cheap-model subagent can replace a large host tool output with focused excerpts
and cost the main model far fewer tokens. S02 measures that claim end to end: a representative corpus
runs through the **native path** (what the host would show the model with no ParaDoc) and through the
**real ParaDoc surface of each shipped host adapter**, and the harness reports token savings, latency,
fallback rate and non-circular answer-quality proxies per source type and host, against named
thresholds the CLI enforces.

## How to rerun

```bash
npm run build
npm run value                                   # table + fallback histogram + threshold verdict
npm run value -- --out /tmp/paradoc-value.jsonl # also writes one JSONL record per item x host x profile
npm run value -- --json                         # machine-readable report (thresholds + aggregates)
npm run value:failure                           # failure-profile-only validation (see below)
```

Flags (`scripts/value-bench.mjs`): `--out <jsonl>`, `--profiles a,b`, `--latency <ms>` (default 20),
`--timeout <ms>` (default 1000), `--iterations <n>` (default 1), `--judge off|low-confidence|always`,
`--check` (exit 1 on a threshold violation), `--failure-profiles`, `--json`, `--help`. Invalid arguments exit 1. The corpus
is materialized into a fresh `mkdtemp` directory and removed in a `finally` block; the harness never
writes into the repo and never uses `process.cwd()` as a config root.

A threshold failure prints one line per violation on stderr and exits 1:

```text
thresholds: FAIL (1 violation)
  source.minNetSavingsPct [source] measured=-40.0 limit=-25 — mean net savings -40.0% is below the -25% floor (6 positive records)
```

## Corpus

`src/value/corpus.ts` generates 22 items deterministically at runtime into the harness temp dir. No
binaries are committed and no dependencies were added; two materializations are byte-identical
(asserted in `src/value/corpus.test.ts`). Source types map 1:1 onto the interceptor's own document
classification (`DocumentKind`), so the harness measures the categories the product actually claims.

| Source type | Items | Positive (`intercept`) | Negative |
|---|---|---|---|
| `source` | 7 | 2 (`src-retry-ledger`, `src-wide-report`) | 2 passthrough (`src-tiny-helper`, `src-ranged`), 3 guard fallbacks |
| `text-document` | 4 | 2 (`doc-warehouse`, `doc-atlas`) | 1 passthrough (`doc-small-note`), 1 guard fallback |
| `pdf-text` | 6 | 1 (`pdf-atlas-runbook`) | 5 guard fallbacks |
| `web-page` | 5 | 1 (`web-docs-guide`) | 4 guard fallbacks |
| **Total** | **22** | **6** | **16** |

Negative items and their expected outcomes:

| Item | Expected outcome |
|---|---|
| `src-tiny-helper`, `doc-small-note` | `passthrough` (below the size thresholds) |
| `src-ranged` | `passthrough` (an explicit ranged read bypasses interception) |
| `src-too-large`, `pdf-oversized` | `fallback:file-too-large`, `fallback:pdf-too-large` |
| `src-binary` | `fallback:binary-file` |
| `src-missing`, `doc-missing` | `fallback:file-not-found` |
| `pdf-encrypted` / `pdf-no-text` / `pdf-truncated` / `pdf-extractor-unavailable` | `fallback:pdf-encrypted` / `pdf-no-text` / `pdf-malformed` / `extractor-unavailable` |
| `web-loopback` / `web-non-html` / `web-redirect-loop` / `web-oversized` | `fallback:unsafe-url` / `unsupported-content-type` / `too-many-redirects` / `content-too-large` |

### How the fixtures are built

- **Source files / text documents** — synthetic multi-section files written line by line; gold ranges
  are computed by the generator from the lines it actually wrote (`goldRangesFor`), so a gold range can
  never disagree with the fixture. `src-wide-report` is a wide-line file that exercises the
  `thresholdTokens` path; `src-ranged` is an explicit ranged read.
- **PDFs** — hand-built byte-level PDFs (Helvetica `Tj` text operators plus a hand-computed xref),
  round-tripped through the real `pdftotext` subprocess. Negative PDFs carry an `/Encrypt` dict, no
  text operators, or a truncated header; the oversized item is oversized after extraction, and
  `pdf-extractor-unavailable` injects a failing `PdfExtractor`. When `pdftotext` is absent from `PATH`
  the real-extraction items are reported as `skipped:pdftotext-missing` and their source type is
  excluded from threshold checking instead of producing a fake violation.
- **Web pages** — canned HTML in the shape of a docs page (nav chrome plus prose), served through an
  injected `WebTransport` and canned `LookupFn`; no network is used. Negative web items are a loopback
  URL, a non-HTML content type, a redirect loop, and an oversized body.
- **Per-item tuning** — each item carries its own `CorpusTuning` overrides (`thresholdLines`,
  `minTokens`, `maxFileBytes`, `pdfMaxChars`, `webMaxBytes`, `webMaxRedirects`, …) which the hosts
  apply through `configOptions`, so ambient config on the developer machine cannot change a measurement.

### Host × source-type matrix

Hosts are driven through their shipped public entry points, not a reimplementation
(`src/value/hosts.ts`): `createParaDocHooks` → `tool.execute.after` (opencode),
`createCopilotHooks` → `onPostToolUse(buildViewInput(...))` (copilot-hooks), and
`createMcpServer.handleMessage` → `tools/call paradoc_read | paradoc_web_read` (copilot-mcp).

| | source | text-document | pdf-text | web-page |
|---|---|---|---|---|
| opencode | yes | yes | yes | **no** |
| copilot-hooks | yes | yes | yes | **no** |
| copilot-mcp | yes | yes | yes | yes |

Web reads exist only on the MCP host, so 10 item×host pairs are recorded as unsupported/skipped rather
than silently scored as zero: 22 items × 3 hosts − 10 unsupported pairs = 56 pairs × 5 profiles =
**280 records** per iteration.

## Method

- **Native baseline** — the exact text the host would hand the model with ParaDoc off: file content for
  file items, `htmlToText`-converted text for web items (the document the MCP host actually serves,
  provenance header included — a baseline and a reply that are different documents cannot be compared).
- **Token estimates** — `chars / 4` via the interceptor's own `estimateTokens` (`src/core/interceptor.ts`),
  the same rule the product uses (MEM048). It is an estimate, not a tokenizer.
- **Main-model savings** — `savingsPct = (nativeEstTokens − renderedEstTokens) / nativeEstTokens`, where
  `renderedEstTokens` measures the *rendered host reply*, so render chrome (`--- lines a-b` headers,
  `NNNNN| ` prefixes, omitted-lines list, HINT) is charged, not ignored (MEM087).
- **Net savings (the honest figure)** — `estTokensDelegated` is the token count the interceptor reports
  having sent to the cheap model; `netEstTokensSaved = nativeEstTokens − renderedEstTokens −
  estTokensDelegated` and `netSavingsPct` is that over the native estimate. A condensation that forwards
  the whole document to a subagent is not a net saving, and the harness refuses to report one.
- **Answer quality (non-circular)** — `src/value/sim-runner.ts` is a `SubagentRunner` that reads the
  numbered file content out of the *prompt it actually receives*, locates the gold needle inside that
  content, and reports the line numbers where it found it. It never trusts a manifest-supplied range,
  so a wrong gold range in the manifest produces a wrong-looking measurement instead of a silently
  passing one. `goldCoverage` is the share of gold lines (or gold needles where no ranges exist, i.e.
  PDF and web) present in the reply; `needlePresent` is whether the answer string survived.
- **Accuracy profiles** — `correct` (exact range), `partial` (half the range), `wrong` (a range that
  excludes the needle), `invalid-json` (unparseable model output), `timeout` (sleeps past the caller's
  deadline). Each run gets a fresh runner and a fresh cache, so runs never share model or cache state.
- **Fallback cross-check** — the interceptor's diagnostics record (`ts`, `level`, `message`, event and
  stats) is parsed back out of each host's own diagnostics sink and compared with the reason the host
  delivered to the model (`resultFallbackReason`, surfaced on the MCP host). `reasonsAgree` must hold.

## Measured results — `correct` profile

### Harness table (all items of a type, as `npm run value` prints it)

```text
sourceType       host            n  savings%   netSav%  p50(ms)  p95(ms)  intercept%  fallback%   gold  judge%
pdf-text        copilot-hooks    6      48.6      -6.9       0      42          17         83   1.00     n/a
pdf-text        copilot-mcp      6      97.5     -13.3       0      42          17         83   1.00     n/a
pdf-text        opencode         6      48.6      -6.9       1      43          17         83   1.00     n/a
source          copilot-hooks    7      32.1      -4.7       0      22          29         43   1.00     n/a
source          copilot-mcp      7      20.5     -53.2       0      22          29         43   0.86     n/a
source          opencode         7      32.1      -4.7       0      23          29         43   1.00     n/a
text-document   copilot-hooks    4      64.0     -12.0       1      21          50         25   1.00     n/a
text-document   copilot-mcp      4      15.2     -60.7       0      21          50         25   1.00     n/a
text-document   opencode         4      64.0     -12.0       0      21          50         25   1.00     n/a
web-page        copilot-mcp      5      97.7     -14.3       0      28          20         80   1.00     n/a
```

Read this table with care: `n` is items of that type on that host **including negative fixtures**,
whose replies are short error messages or unmodified passthrough text. Those items drag `savings%`,
`netSav%` and `fallback%` around (a guard-stage error reply looks like a huge "saving"; a passthrough
looks like zero). The threshold-checked numbers are the positive-only figures below.

### Positive items only (what the thresholds check), pooled across hosts

| Source type | n | savings% | net savings% | gold coverage | p95 ms | added latency (p95 − 20 ms) |
|---|---|---|---|---|---|---|
| `source` | 6 | 96.4 | −14.1 | 1.00 | 23 | 3 ms |
| `text-document` | 6 | 96.1 | −17.8 | 1.00 | 21 | 1 ms |
| `pdf-text` | 3 | 97.3 | −13.6 | 1.00 | 43 | 23 ms |
| `web-page` | 1 | 97.7 | −14.3 | 1.00 | 28 | 8 ms |

Per positive item (tokens, `correct` profile; `opencode` / `copilot-hooks` / `copilot-mcp` reply sizes):

| Item | native est. tokens | reply est. tokens | delegated to cheap model | savings% | net savings% |
|---|---|---|---|---|---|
| `src-retry-ledger` | 6,204 | 201 / 200 / 193 | 7,355 / 7,355 / 7,349 | 96.8 / 96.8 / 96.9 | −21.8 / −21.8 / −21.6 |
| `src-wide-report` | 9,875 | 405 / 405 / 389 | 10,127 / 10,127 / 10,112 | 95.9 / 95.9 / 96.1 | −6.7 / −6.7 / −6.3 |
| `doc-warehouse` | 4,559 | 188 / 188 / 174 | 5,258 / 5,258 / 5,246 | 95.9 / 95.9 / 96.2 | −19.5 / −19.5 / −18.9 |
| `doc-atlas` | 6,123 | 234 / 234 / 220 | 6,897 / 6,897 / 6,885 | 96.2 / 96.2 / 96.4 | −16.5 / −16.5 / −16.0 |
| `pdf-atlas-runbook` | 7,331 | 201 / 201 / 186 | 8,136 / 8,136 / 8,123 | 97.3 / 97.3 / 97.5 | −13.7 / −13.7 / −13.3 |
| `web-docs-guide` | 8,214 | 188 (MCP only) | 9,203 | 97.7 | −14.3 |

The native estimate is identical on every host (it is the same document); the reply differs slightly on
`copilot-mcp` because that host wraps content in its own chrome lines, which the harness strips before
comparing but still counts in the reply the model receives.

The headline claim holds on the main model: a ~6–10k-token document comes back as a 188–405 token
reply, a **96–98% reduction in what the main model reads**, with the gold answer present
(`goldCoverage` 1.00, needle present 16/16 positive item×host pairs). The net column is negative
because the shipped default `chunkLines: 0` delegates the whole document to the cheap model in one
call: the main model's context shrinks by ~96%, but the cheap model was fed everything. Net savings
turn positive only when delegation is cheaper than the native read (multi-chunk reads, cached results,
or documents the main model would otherwise re-read); the thresholds are floors on the honest net
figure, not on the flattering one.

### ParaDoc's own latency (simulated model latency removed)

With `--latency 0` the wall clock is ParaDoc's own work (10 iterations, 2,800 records, thresholds PASS):

| Source type | n | p50 | p95 | max |
|---|---|---|---|---|
| `source` | 60 | 1 ms | 1 ms | 3 ms |
| `text-document` | 60 | 0 ms | 1 ms | 1 ms |
| `pdf-text` | 30 | 22 ms | 23 ms | 23 ms |
| `web-page` | 10 | 3 ms | 9 ms | 9 ms |

PDF is the only source type with a meaningful fixed cost: the `pdftotext` subprocess. Everything else is
single-digit milliseconds on top of the model call.

## Containment — degraded profiles

Over the 16 positive item×host pairs, per profile:

| Profile | intercepted | fell back | fallback reason | native text preserved | mean gold coverage | needle present | contained |
|---|---|---|---|---|---|---|---|
| `correct` | 16 | 0 | — | 0 | 1.00 | 16/16 | 16/16 |
| `partial` | 16 | 0 | — | 0 | 0.72 | 16/16 | 16/16 |
| `wrong` | 16 | 0 | — | 0 | **0.00** | **0/16** | 16/16 |
| `invalid-json` | 0 | 16 | `invalid-response` ×16 | 16/16 | 0.94 | 15/16 | 16/16 |
| `timeout` | 0 | 16 | `timeout` ×16 | 16/16 | 0.94 | 15/16 | 16/16 |

- `wrong` is visibly wrong: full interception, zero gold coverage, needle gone. The harness cannot be
  fooled into reporting success by a bad model, which is what makes the quality proxies usable.
- `invalid-json` and `timeout` never corrupt the reply: every one of them returned the item's native
  text (`nativePreserved` 16/16) after announcing an interception-stage fallback, so the model saw the
  original content, not a mangled condensation. Their mean gold coverage of 0.94 is the *native* text
  scoring well, not the condensation.
- `timeout` fell back at ≤1,022 ms against a 1,000 ms deadline, and `attempts` was **1** for every
  timeout record: `TimeoutError` is not in `TRANSIENT_CODES`/`TRANSIENT_MESSAGE` (`src/core/transient.ts`),
  so a deadline miss is not retried — it fails fast to the native text.
- `partial` keeps the needle but shortens the context around it (gold 0.72), which is why only `wrong`
  is required to miss gold.

## Fallback rates and reasons

Over all 280 records (all profiles): **187 fallbacks** — 155 guard-stage (deliberate short error
instead of content) and 32 interception-stage (native text must be returned).

```text
invalid-response=16 timeout=16 pdf-encrypted=15 pdf-no-text=15 pdf-malformed=15 pdf-too-large=15
extractor-unavailable=15 file-too-large=15 binary-file=15 file-not-found=30 unsafe-url=5
unsupported-content-type=5 too-many-redirects=5 content-too-large=5
```

Interception-stage fallbacks occur only under the `invalid-json` and `timeout` profiles (16 pairs each);
under the `correct` profile **no positive item fell back on any host** (0% positive fallback rate,
against a 10% ceiling). All 40 negative item×host pairs × 5 profiles = 200 records matched their
expected outcome: **0 mismatches**. `reasonsAgree` held on every cross-checked record: 0 mismatches.

## Thresholds

From `src/value/thresholds.ts` (`HEADLINE_PROFILE = "correct"`, `REFERENCE_SIMULATED_LATENCY_MS = 20`).
Each limit was set from a real harness run and then loosened with margin so the check catches a genuine
regression instead of run-to-run noise.

| Source type | min net savings % | min savings % | min gold coverage | max fallback rate | max added latency |
|---|---|---|---|---|---|
| `source` | −25 (measured −14.1) | 90 (measured 96.4) | 0.95 (measured 1.00) | 0.10 (measured 0.00) | 250 ms (measured 3) |
| `text-document` | −25 (measured −17.8) | 90 (measured 96.1) | 0.95 (measured 1.00) | 0.10 (measured 0.00) | 250 ms (measured 1) |
| `pdf-text` | −20 (measured −13.6) | 90 (measured 97.3) | 0.95 (measured 1.00) | 0.10 (measured 0.00) | 350 ms (measured 23) |
| `web-page` | −20 (measured −14.3) | 90 (measured 97.7) | 0.95 (measured 1.00) | 0.10 (measured 0.00) | 250 ms (measured 8) |

Rationale per limit:

- **Net savings floors (−25 / −20%)** — floors on the honest accounting, which subtracts the tokens the
  cheap model was fed. Single-chunk documents at the shipped `chunkLines: 0` default are net-negative
  by design; the floor says "do not get materially worse", not "prove a net win the product does not
  claim". A collapse to −40% would mean delegation stopped being bounded.
- **Main-model savings floors (90%)** — the product's actual claim: the main model should read a small
  excerpt, not the file. Measured 96–98%.
- **Gold coverage floor (0.95)** — the condensation must still contain the answer. Measured 1.00 on
  positive items under `correct`.
- **Fallback ceiling on positive items (10%)** — items that should be intercepted must actually be
  intercepted. Measured 0%. Guard-stage fallbacks on negative fixtures are not counted here; they are
  the correct behavior and are checked by the negative-outcome rule instead.
- **Added latency ceilings (250 ms; 350 ms for PDF)** — p95 of intercepted positive runs minus the
  simulated model latency, i.e. what ParaDoc's own work adds. Measured 1–23 ms; the ceilings leave room
  for a slower machine and for the `pdftotext` subprocess, which is why PDF gets 350 ms.

Global rules (`GLOBAL_THRESHOLDS`), all enabled:

| Rule | Meaning | Measured |
|---|---|---|
| `negativeItemsMustMatch` | every negative item produces its expected outcome on every host and profile | 200/200 match |
| `interceptionFallbacksMustPreserveNative` | interception-stage fallbacks (`no-runner`, `subagent-error`, `timeout`, `invalid-response`, `invalid-confidence`, `no-valid-excerpts`, `judge-rejected`) must return the item's native text | 32/32 preserved |
| `wrongProfileMustMissGold` | the profile defined to exclude the answer must actually miss it when intercepted | 16/16 miss |
| `reasonsMustAgree` | the reason the host delivered must not contradict the reason the interceptor logged | 0 contradictions |

Guard-stage reasons (`file-too-large`, `unsafe-url`, `pdf-encrypted`, …) are deliberately **excluded**
from the native-preservation rule: they return a short error instead of the content by design.

Violation names are stable and machine-readable: `<sourceType>.minNetSavingsPct`,
`<sourceType>.minSavingsPct`, `<sourceType>.minGoldCoverage`, `<sourceType>.maxFallbackRate`,
`<sourceType>.maxAddedLatencyMs`, `<sourceType>.noPositiveRecords`, `negative-outcome`,
`native-not-preserved`, `wrong-profile-faked-success`, `reason-mismatch`. Failure-profile mode (below)
adds `failure-profile.reason`, `failure-profile.native-not-preserved`, `failure-profile.intercepted`
and `failure-profile.no-positive-records`. A source type whose only
positive fixture was skipped (e.g. `pdftotext` absent) is reported as skipped rather than violated.

**Downstream consumers:** S03 (Cross-Host Interactive Controls) and milestone acceptance cite these
thresholds and numbers — the roadmap's boundary map records S02 as producing "representative corpus,
measurements, thresholds, limitations" consumed by S03 and milestone acceptance. S03's `/paradoc status`
output should report the same counters these thresholds are computed from (`interceptorFor` stats,
`estTokensSaved`, `estTokensDelegated`, fallback counters) so a user sees the same accounting the
harness enforces.

## Failure-profile-only validation

The S02 command `node scripts/value-bench.mjs --profiles invalid-json,timeout --check` exits 1 with
`{source,text-document,pdf-text,web-page}.noPositiveRecords`: the headline guard needs `correct`
records, and a failure-only run has none. The guard is intentionally preserved; its detail now says
the headline profile `correct` produced no positive records and points to `--failure-profiles`.

The corrected equivalent is explicit and deterministic:

```bash
npm run value:failure     # = node scripts/value-bench.mjs --failure-profiles --check
```

`--failure-profiles` defaults `--profiles` to `invalid-json,timeout`, and combining it with any other
profile (e.g. `--profiles correct`) exits 1 naming the offending profile. It prints a per
sourceType x host table (n, fallback %, fallback reason, native preserved) and a
`failure-profile checks: PASS|FAIL` line; no savings, gold or latency gates apply. Asserted for every
positive record: `wasIntercepted=false`, `nativePreserved=true`, and fallback reason `invalid-response`
(invalid-json) or `timeout`. Plus the global rules (negative-outcome, native-not-preserved,
reason-mismatch, wrong-profile-faked-success). Violations: `failure-profile.reason`,
`failure-profile.native-not-preserved`, `failure-profile.intercepted`,
`failure-profile.no-positive-records` (a run total, so a skipped pdf fixture does not false-fail).

Observed run: 112 records (22 items x 3 hosts - 10 unsupported pairs x 2 profiles); every positive row
is 100% fallback with native preserved; `invalid-response=16 timeout=16`; `failure-profile checks: PASS`.

## Structural decisions

`gsd_decision_save` is not available to this task, so the structural decisions are recorded here (and
in the S02 task summaries):

1. **Fixtures are generated at runtime** into the harness temp dir by `materializeCorpus`. No binaries
   are committed, no new dependencies were added, and determinism is asserted by comparing two
   materializations byte-for-byte.
2. **The harness lives in `src/value` and is compiled but unpublished** — `package.json` `files` is
   unchanged, so `dist/value/**` never ships to npm, while `npm test` still runs the harness tests.
3. **Hosts are driven through their shipped entry points only** (`tool.execute.after`,
   `onPostToolUse`, MCP `tools/call`), so the numbers measure the adapters users actually run.
4. **Answer quality is measured by a content-derived runner**, never by a manifest-supplied range, to
   keep the quality proxies non-circular.
5. **Config is isolated to the corpus temp dir** (homeDir, projectRoot, cwd, `configOptions.env`) —
   never `process.cwd()` — so a developer's ambient config cannot move a measurement.

## Limitations

- **A hermetic simulated model is not live model answer quality.** `SimulatedCheapModel` proves the
  pipeline routes, renders, guards and falls back correctly and that a *correct* extraction preserves
  the gold answer. It says nothing about whether a real cheap model would pick the right lines on a
  real question. The `wrong` profile exists precisely to show the harness would notice a bad model.
- **Latency excludes the real model and the network.** Every millisecond here is ParaDoc's own work plus
  a fixed simulated delay. Real end-to-end latency (model call, network, host startup) remains measured
  by the gated live scripts `scripts/e2e-opencode.mjs` and `scripts/e2e-copilot.mjs` (`PARADOC_E2E=1`,
  `PARADOC_E2E_WEB=1`).
- **Token counts are `chars/4` estimates, not a tokenizer.** They are the same estimates the product
  reports, so the ratios are consistent, but absolute token figures are not billing-grade and a real
  tokenizer could shift the savings percentages.
- **Net savings are negative at the shipped default chunking.** With `chunkLines: 0` the whole document
  is delegated once, so the harness's honest net figure is negative for single-chunk documents. The
  main-model reduction (96–98%) is the measured win; a net win requires chunked or cached delegation,
  which this corpus does not exercise as a positive item.
- **The web native baseline is converted text, not raw HTML.** The MCP host serves `htmlToText` output
  with a provenance header, so the baseline mirrors that document. Savings against raw HTML bytes would
  be larger and would compare two different documents.
- **Web is MCP-only.** OpenCode and Copilot hooks intercept file views only, so web rows exist for
  `copilot-mcp` alone; the other hosts record those pairs as unsupported rather than as zero savings.
- **The corpus is representative, not exhaustive.** 22 items across four source types with 16 negative
  fixtures cover the guard and fallback surface the product claims, but real repositories contain
  languages, encodings, generated files, monorepo configs, scanned/image PDFs and JS-heavy pages that
  are not in the corpus. Per-type positive counts are small (`web-page` has one positive item), so a
  single fixture change can move a per-type mean.
- **Judge is off by default.** `judge%` shows `n/a` because the default run does not invoke the judge
  gate; run `npm run value -- --judge always` to populate it. Thresholds do not depend on judge output.
- **Numbers are single-iteration by default.** Non-latency figures were byte-identical across two runs;
  p50/p95 jitter by 1–2 ms. Use `--iterations <n>` for a wider latency sample.

## Failure modes and load behavior (harness)

External dependencies of the harness itself, and how each failure surfaces:

| Dependency | Failure path | Handling |
|---|---|---|
| `pdftotext` subprocess | absent from `PATH` | items reported `skipped:pdftotext-missing`, source type excluded from thresholds instead of producing a false violation; injected-extractor PDF items still run |
| Temp directory (`mkdtemp`) | creation or fixture write failure | the whole run fails with `value-bench: <error>` and exit 1; cleanup runs in `finally` |
| `dist/value/**` | harness run without `npm run build` | explicit `dist/value/ not found; run npm run build first`, exit 1 |
| CLI arguments | bad latency/timeout/iterations/judge/profiles, duplicates, unknown profile | `value-bench: <message>` + usage, exit 1 (asserted in `src/value/value-bench.test.ts`) |
| Host adapters | a host returns a different fallback reason than the interceptor logged | `reason-mismatch` threshold violation, exit 1 |
| Model output | unparseable JSON or deadline miss | interception-stage fallback with native text preserved; enforced by `native-not-preserved` |

Load: the matrix is sequential (`runMatrix` awaits each item×host×profile run), so wall time is the
resource that saturates first. At 10× iterations (2,800 records) the run took 2 m 47 s at 156 MB peak
RSS and still passed thresholds; per-record cost is dominated by the `pdftotext` subprocess, not by
memory. Records are held in one array before aggregation, so memory grows linearly with
items × hosts × profiles × iterations — the practical bound is iterations, and the harness has no
parallelism to saturate. Fixture disk usage is bounded by the generator's own size caps (the oversized
PDF and oversized web body are capped by `pdfMaxChars` / `webMaxBytes` guards, not unbounded).

## Negative tests protecting this harness

- `src/value/corpus.test.ts` — determinism (two materializations byte-identical), manifest integrity,
  PDF round-trip through real `pdftotext` plus the forced `pdftotext`-missing skip path, negative PDF
  fixtures (encrypted dict, no text operators, truncated header), web fixtures through canned transports
  (loopback, non-HTML, redirect loop, oversized body).
- `src/value/sim-runner.test.ts` — prompt parsing, each profile's response shape, and explicit
  content-derivation tests (the runner finds the needle from the prompt, not from a hard-coded range).
- `src/value/hosts.test.ts` — host×type matrix, record schema, the negative-item expected-reason matrix
  on every host that supports the item, degraded profiles are contained, web items recorded as
  MCP-only/skipped on the other hosts.
- `src/value/measure.test.ts` — record helpers, `buildRecord` (net savings, native preservation,
  containment), `aggregate` (percentiles, rates, reason histograms).
- `src/value/thresholds.test.ts` — deliberately bad aggregates produce the *named* violations for every
  floor and ceiling, guard-stage vs interception-stage split, `noPositiveRecords` instead of a silent
  pass, `wrong-profile-faked-success`, `reason-mismatch`, violation shape.
- `src/value/value-bench.test.ts` — spawns the real CLI: table header and rows for each source type,
  JSONL line count and schema, `--profiles`/`--iterations`, `--json`, invalid arguments exit 1, and a
  failing threshold check exits 1 naming the offending checks; `--failure-profiles --check` exits 0
  with `failure-profile checks: PASS` and no savings-gate text, `--failure-profiles --profiles correct`
  is rejected, and the old `--profiles invalid-json,timeout --check` still exits 1 with the hint.

## Cross-host command acceptance

Slice S05 proves `/paradoc` status, set and reset (R008/R009) through the artifacts the installer produces, not through in-process calls.

| Behavior | OpenCode | Copilot CLI |
|---|---|---|
| status (defaults) | hermetic: installed `mcp-entry.js` over stdio; live: `e2e:commands` `status` step | hermetic: installed `extension-entry` via `command.handler` |
| set (writes the launch project's `.paradoc/config.json`) | hermetic + live `set thresholdLines 500` | hermetic (`acceptance.test.ts`) |
| reset key / reset all | hermetic + live `reset` | hermetic |
| invalid key, value or scope | hermetic (`isError`, file unchanged) + live invalid `set` | hermetic (thrown actionable error, file unchanged) |
| env over project precedence | hermetic + live relaunch with `PARADOC_THRESHOLD` set | n/a live; env handling shared with the MCP path |
| fresh-session persistence | hermetic (second spawned process) + live (new server, new session) | hermetic (second registration) |
| installed command text | hermetic: marker, description, `$ARGUMENTS` mapping, `opencode.jsonc` entry; live: `command.list` includes `paradoc` | hermetic: shim imports the installed runtime |

How to run:

- `npm test` runs the hermetic `src/cli/acceptance.test.ts` (temp HOME/XDG, no model needed) and the `e2e-scripts` guard that the live script parses and SKIPs without the gate.
- `PARADOC_E2E=1 npm run e2e:commands [-- --host opencode]` runs the live OpenCode dispatch, printing one `PASS|FAIL <step>` line per check. It uses a temp config and project and needs an authenticated model.

Honest limits:

- OpenCode expands the template into a user turn and the model then calls the MCP tools, so the live check is LLM-mediated. Assertions key on tool-call parts and the config file, and a step retries once if the model skips the call. A failure may be a model or provider limit rather than a ParaDoc defect.
- Copilot CLI 1.0.103 does not dispatch extension slash commands in prompt mode: `copilot -p "/paradoc ..."` reaches the model as chat and never writes the config. The Copilot host in `e2e-commands.mjs` therefore prints `SKIP copilot command dispatch: <reason>`, and the hermetic installed-shim test is the proof.
- Restart semantics: a changed setting is applied to the host's next session; the running session keeps the values it started with. Environment variables always win over the project file, which wins over the global file.

Related: the S02 [Thresholds](#thresholds) and [Limitations](#limitations) above; `npm run value` and `npm run value:failure` check them. The counters `/paradoc status` reports mirror the counters those thresholds use.

## Verification

```bash
npm run build && npm test && npm run value && npm run value:failure
```

passes with `thresholds: PASS` and `failure-profile checks: PASS`, and `docs/m006-value-validation.md` contains the Thresholds and
Limitations sections above. The threshold values quoted here are the values in
`src/value/thresholds.ts`; the measured values quoted here are the values the harness printed.
