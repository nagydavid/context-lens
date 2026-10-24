# ParaDoc M006: implementation map (branch `milestone/M006`, slice S01)

Purpose: the inspectable implementation map the roadmap asks for. One shared host runtime in `src/core`, one diagnostics record shape, one tuning write seam, dead legacy surfaces removed. Behavior, config file shape, `PARADOC_*` env names and the interception pipeline are unchanged from M005.

## Idea

ParaDoc intercepts a host tool's large output and replaces it with focused excerpts produced by a cheap-model subagent. M006 removed the triplicated adapter bootstrap: tuning resolution, cache construction, model selection, diagnostics, and per-root interceptor construction now live once in `src/core/host-runtime.ts`, and each host adapter only translates its own event shapes.

## Module map (line counts from `wc -l`, final tree)

### Shared core — `src/core` (3,838 lines non-test; 4,853 lines tests)

| File | Lines | Owns |
|---|---|---|
| `interceptor.ts` | 479 | `ReadInterceptor` pipeline (frozen), `InterceptOptions`, stats counters. Private defaults now imported from `DEFAULT_TUNING` (D024). |
| `host-runtime.ts` | 258 | `createHostRuntime` (tuning, cache, `ModelSelector`, per-root `interceptorFor`, `getStatus`), `createDiagnostics`, shared helpers (`isRecord`, `errorMessage`, `validLine`, `describeEvent`, `displayPathFor`, `explicitFromOptions`). |
| `status.ts` | 49 | `ParadocStatus` snapshot type, `buildStatus`, `statusConfigPaths`. |
| `tuning.ts` | 214 | `DEFAULT_TUNING` (single default source), `loadTuning` with per-key provenance, `TUNING_KEYS`, validation rules. |
| `tuning-write.ts` | 183 | `saveTuning` / `clearTuning`: the canonical validated write seam (D025). |
| `config.ts` | 235 | `configPath`, model config load/save, `readConfigObject`, spec parsing. |
| `model-selector.ts` | 116 | `ModelSelector` (stored config → picker → none), no prompting inside status. |
| `cache.ts` | 103 | `LruResultCache`, `cacheKey`, `PROMPT_VERSION`. |
| `render.ts` | 43 | `renderInterceptionResult` + `HINT` (moved from `src/opencode/render.ts`, which is now a 2-line re-export shim). |
| `web-html.ts` / `web-fetch.ts` / `url-guard.ts` / `web-document.ts` | 386 / 309 / 150 / 130 | Web source path (unchanged from M005). |
| `pdf.ts` | 134 | `pdftotext` extraction, `DEFAULT_PDF_TIMEOUT_MS`, `DEFAULT_PDF_MAX_CHARS` (imported by `tuning.ts`; no cycle — `pdf.ts` never imports `tuning.ts`). |
| `document.ts` | 19 | `classifyDocument`. |
| `parse.ts` / `prompts.ts` / `judge.ts` / `chunking.ts` / `fanout.ts` | 162 / 134 / 96 / 89 / 86 | Response parsing, prompts, judge gate, chunk planning, concurrent fan-out. |
| `subagent.ts` | 84 | `SubagentRunner` contract, `ConcurrencyLimitedRunner`, `SerialRunner`. |
| `file-guard.ts` / `transient.ts` / `question.ts` / `fake-runner.ts` / `models.ts` | 69 / 38 / 32 / 29 / 88 | Size/binary guards, retry classification, question resolution, test runner, shared types. |
| `index.ts` | 123 | Barrel for `@davidnagy/paradoc/core`. |

### Host adapters

| File | Lines | Owns |
|---|---|---|
| `src/opencode/hooks.ts` | 185 | OpenCode event translation only: `ParaDocClient`, `chat.message` task capture, `tool.execute.after` rewrite, child-session set, offset/limit bypass. |
| `src/opencode/plugin-v2.ts` | 130 | OpenCode v2.0.30 `{ id, setup(ctx) }` definition, `createV2Client` session adapter. |
| `src/opencode/subagent.ts` | 202 | `SessionSubagentRunner` / `createOpenCodeRunner` child-session runner. |
| `src/opencode/model-picker.ts` | 106 | OpenCode model picker UI adapter. |
| `src/opencode/index.ts` | 46 | Public `./opencode` barrel (re-exports only). |
| `src/opencode/plugin.ts` | 17 | Published `./plugin` export (kept — D021; removing it would break the published surface). |
| `src/opencode/render.ts` | 2 | Re-export shim onto `../core/render.js`. |
| `src/copilot-cli/hooks.ts` | 167 | Copilot `onPostToolUse` translation: range-arg skip, directory-view skip, `PARADOC_CHILD` skip, statSync guard, `{ modifiedResult }` shape. |
| `src/copilot-cli/mcp-server.ts` | 318 | JSON-RPC server, data-driven `TOOLS` registry over `ToolContext`, `paradoc_read` + `paradoc_web_read` handlers. |
| `src/copilot-cli/subagent.ts` | 132 | `CopilotCliSubagentRunner` (child `gh` CLI process). |
| `src/copilot-cli/extension-entry.ts` / `mcp-entry.ts` / `index.ts` | 46 / 36 / 29 | Entry shims and barrel. |
| `src/cli/main.ts` / `install.ts` | 26 / 216 | `paradoc` bin: install/uninstall wiring. |

## Host table — what each host still owns

| Host | Entry | Runtime seam | Host-specific logic remaining |
|---|---|---|---|
| OpenCode (1.x + v2) | `plugin.ts`, `plugin-v2.ts` → `createParaDocHooks` | `createHostRuntime` + per-directory `interceptorFor(directory)` | Event shapes (`tool.execute.after`, `chat.message`), output rewrite onto `output.output`, offset/limit bypass, child-session tracking, model picker via `ModelSelector` options |
| Copilot hooks | `extension-entry.ts` → `createCopilotHooks` | `createHostRuntime` + per-workingDirectory `interceptorFor` | `onPostToolUse` translation, `{ modifiedResult: { textResultForLlm } }`, range/dir/child skips, statSync guard |
| Copilot MCP server | `mcp-entry.ts` → `createMcpServer` | `createHostRuntime` (single cwd root, lazy `interceptorFor` — not built at startup) | JSON-RPC framing, `TOOLS` registry, tool result rendering, stderr/logFile delivery |

All three hosts share one `HostRuntime` (`settings`, `sources`, `cache`, `tuningFor`, `modelSelectorFor`, `interceptorFor`, `getStatus`) and one `createDiagnostics` logger.

## Configuration precedence chain

Per tuning key (resolved by `loadTuning`, provenance recorded per key in `sources`):

```
explicit (host code)  >  PARADOC_* env  >  project .paradoc/config.json  >  global config  >  DEFAULT_TUNING
```

Writes go through `saveTuning(partial, scope, options)` / `clearTuning(scope, options, keys?)` (`src/core/tuning-write.ts`): validated with the same `check` rules used on load, merged into the existing config object (preserving `model`, `version`, unknown keys), written atomically (tmp + rename), and a corrupt existing file is refused with an error naming the path rather than silently replaced.

## Diagnostics record shape (unified, S02-ready)

- In-memory record: `{ ts, level, message, ...extra }` — `ts` is an ISO timestamp; the MCP server's old `time` key is gone.
- `PARADOC_LOG_FILE` append: one JSONL record per line, same shape on every host.
- Text line to host log sinks: `[paradoc] <level>: <message> <JSON extra>` — byte-identical to M005 because `scripts/e2e-opencode.mjs` regex-parses it.
- Delivery is injected per host (`sink`, `stderr`, `logFile`); every delivery failure is swallowed (logging must never break a read).

## Control contract exposed for S03

| Surface | Location | Notes |
|---|---|---|
| `runtime.getStatus(root?)` | `host-runtime.ts` → `status.ts` | `ParadocStatus { settings, sources, model: { choice?, source }, configPaths: { project, global }, stats?, warnings }`. Never throws on malformed config — surfaces a warning instead. Model resolution never prompts. |
| `controls.ts` | `src/core/controls.ts` | The host-agnostic parser, validation, write wrappers, status/change renderers, usage and restart hint. Every control surface uses this contract. |
| `saveTuning` / `clearTuning` | `tuning-write.ts` | The only sanctioned config write path; `set`/`reset` commands are thin bindings over these. |
| CLI controls | `src/cli/controls-cli.ts` + `main.ts` | `paradoc status`, `set`, and `reset` map the shared contract to stdout/stderr and conventional exit codes. |
| MCP `TOOLS` registry | `mcp-server.ts` | Registers `paradoc_read`, `paradoc_web_read`, `paradoc_status`, `paradoc_set`, and `paradoc_reset`; controls use the shared contract without JSON-RPC dispatch changes. |
| Copilot `/paradoc` | `extension-entry.ts` | Native command registration logs successful shared-contract output and throws errors for the SDK; it tracks the latest hook `workingDirectory`. |
| OpenCode `/paradoc` | `install.ts` | Installer writes a marked `commands/paradoc.md` prompt template that calls the MCP status/set/reset tools. Unmarked user-owned command files are never replaced. |

## Removed surfaces (this slice)

- `readFanoutEnv` (`src/opencode/plugin-v2.ts`) — superseded by `loadTuning`; plus its private `positiveInteger` helper and its two tests.
- `handleOpenCodeRead` + `OpenCodeReadParams` (`src/opencode/index.ts`) — dead pre-hooks entry point; the subagent test now drives `ReadInterceptor.intercept` with `createOpenCodeRunner` directly.
- `interceptRead` (`src/core/interceptor.ts`) and its re-exports from `src/core/index.ts` and `src/opencode/index.ts` — every caller now uses `new ReadInterceptor(options).intercept(request)`; `src/core/interceptor.test.ts` drives the class through a local `readWith` helper.
- Local helper duplicates: `errorMessage` in `src/copilot-cli/mcp-entry.ts` now imports from `core/host-runtime`. Remaining local helpers are intentional non-duplicates: `asRecord`/`errorMessage` in `src/opencode/subagent.ts` and `src/opencode/plugin-v2.ts` parse host response envelopes (different semantics, `string | undefined` returns), and core-internal helpers in `parse.ts`/`config.ts`/`fanout.ts`/`model-selector.ts`/`interceptor.ts` are kept private to avoid import cycles with `host-runtime.ts`.

## Compatibility boundaries

- **Package exports** (`package.json`): `.`, `./core`, `./opencode`, `./opencode/plugin-v2`, `./plugin`, `./copilot-cli` — unchanged. `./plugin` (`src/opencode/plugin.ts`) is published and README-documented, so it stays (D021).
- **Config file shape**: `.paradoc/config.json` with `version`, `model`, `tuning` and tolerated unknown keys — unchanged.
- **Env names**: all `PARADOC_*` names unchanged (`PARADOC_THRESHOLD`, `PARADOC_TIMEOUT`, `PARADOC_CONCURRENCY`, `PARADOC_CHUNK_LINES`, `PARADOC_CHUNK_OVERLAP`, `PARADOC_CACHE`, `PARADOC_JUDGE`, `PARADOC_MIN_TOKENS`, `PARADOC_THRESHOLD_TOKENS`, `PARADOC_PDF_TIMEOUT_MS`, `PARADOC_PDF_MAX_CHARS`, `PARADOC_LOG_FILE`, `PARADOC_CHILD`).
- **Interceptor pipeline**: `ReadInterceptor` logic is frozen; only its private defaults were replaced by `DEFAULT_TUNING` imports (D024).
- **Log text line**: `[paradoc] <level>: <message> <JSON extra>` is byte-stable for `scripts/e2e-opencode.mjs`; JSONL consumers (`scripts/e2e-copilot.mjs`) read `ts`.

## Size and tests

- `src/core` non-test: 3,838 lines; core tests: 4,853 lines; opencode adapters: 733; copilot adapters: 811.
- 573 tests pass (`npm run build && npm test`), including `package-files.test.ts` against the final tree and `host-parity.test.ts` unmodified across all three hosts.
