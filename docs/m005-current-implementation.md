# ParaDoc M005: current implementation (branch `milestone/M005`)

Purpose: hand-off for a second opinion. Question under review: should the web path be a hook on the host's own web-fetch tool instead of ParaDoc's own fetcher plus MCP tool?

## Idea

ParaDoc intercepts a host tool's large output and replaces it with focused excerpts (line ranges) produced by a cheap-model subagent. Small content, ranged reads and child-process reads pass through unchanged.

## Shared core: `src/core/interceptor.ts` (`ReadInterceptor`)

- `interceptShared()` is the one pipeline for every source: load content, split lines, skip if small, cache lookup, cheap-model call (single or fanned out in chunks), optional judge, then excerpts or a full-content fallback.
- `intercept(request)` is for files: classify the path, load the content, call `interceptShared`. PDFs go through `readPdfDocument` first.
- `interceptContent({label, content, documentKind, question, agentContext})` is for content already in memory. Only the web path uses it.
- `documentKind` selects the prompt wording and is part of the cache key.

## Local files (md, txt, PDF)

- `src/core/document.ts` (19 lines): `classifyDocument(path)` returns `source | text-document | pdf-text | web-page`. `text-document` covers `.md .markdown .mdx .txt .text .rst .adoc`; `.pdf` is `pdf-text`.
- Text documents use the same file read as source code. Only the prompt differs.
- `src/core/pdf.ts` (134 lines):
  - Checks file size and the `%PDF` header.
  - Rejects encrypted files (`/Encrypt` dictionary).
  - Runs `pdftotext` (15s timeout, 1,000,000 char cap).
  - Treats output under 16 chars per page as scanned.
  - Any failure returns a typed result, and `interceptShared` falls back to full content and logs it.
  - `pdftotext` must be on PATH. There is no OCR.

## Host hooks (both only act on the native file-read tool)

| Host | File | Trigger | Bypass |
|---|---|---|---|
| OpenCode | `src/opencode/hooks.ts:206` | `tool.execute.after` when `tool === "read"` | `offset`/`limit` args, child sessions |
| Copilot | `src/copilot-cli/hooks.ts:194` | `onPostToolUse` when `toolName === "view"` | range args, directory views, `PARADOC_CHILD=1` |

- Both call `interceptor.intercept()` and overwrite the tool output with `renderInterceptionResult(...)`. OpenCode sets `output.output`. Copilot returns `{ modifiedResult }` with `textResultForLlm`.
- Both pass `pdfExtractor` through. The hooks do not distinguish md, txt, pdf or source. `intercept()` decides.
- Neither hook touches any web tool.

## Web: explicit MCP tool (not a hook)

- Tool `paradoc_web_read` in `src/copilot-cli/mcp-server.ts` (`handleParaDocWebRead`, around line 229). The agent must call it on purpose. It is registered only in the Copilot MCP server. The README mentions an "OpenCode MCP" path that I have not verified.
- `readWebDocument()` in `src/core/web-document.ts` (130 lines), never throws:
  1. `parseWebUrl()` in `url-guard.ts` (150 lines): URL max 2048 chars, SSRF guard that blocks private/loopback addresses (`isBlockedAddress`), `allowPrivateNetwork` opt-in, `maskUrl` redacts the query for logs.
  2. `fetchWebDocument()` in `web-fetch.ts` (309 lines): 15s timeout, 2 MiB cap, 5 redirects, gzip-bomb handling, injectable `WebTransport`.
  3. `htmlToText()` in `web-html.ts` (386 lines): hand-written zero-dependency HTML to text converter with title extraction. Non-HTML bodies are used as is.
  4. Prepend a `# title` and `Source:` header. Truncate at 20,000 lines or 400,000 chars.
  5. If `startLine` or `endLine` is given, return that raw range and skip condensation.
  6. Otherwise call `interceptor.interceptContent({documentKind: "web-page"})`.
  7. If not condensed, cap the fallback at 400 lines.
- Failures come back as a result with `fallback.reason`, for example `invalid-url`, `fetch-failed` or `unreadable`.

## Size

| Area | Lines |
|---|---|
| md/txt classification | 19 |
| PDF | 134 |
| Web: `web-html` 386, `web-fetch` 309, `url-guard` 150, `web-document` 130 | ~975 |
| MCP server (read tool plus web tool) | 349 |
| `src/core` total | 7,232 |
| `src/core` tests | 11,286 |

The rest of `src/core` (judge, fanout, chunking, tuning, model-selector, cache) is from M001 to M004.

## Tests

- 510 tests pass (`npm run build && npm test`).
- Transports, runner and PDF extractor are faked. There is no real network failure testing.
- `src/copilot-cli/host-parity.test.ts` checks the same behaviour across OpenCode hooks, Copilot hooks and the MCP server.
- Opt-in live E2E scenarios exist and were not run.

## Open question for the reviewer

Proposal: drop the ParaDoc web fetcher and add web-tool handling to the existing hooks.

- OpenCode: handle `tool === "webfetch"` (`args.url`) in `tool.execute.after`. Its output is `output.output: string`.
- Copilot: handle `toolName === "web_fetch"` in `onPostToolUse`.
- The condensing call would be `interceptContent({documentKind: "web-page"})` on the host's already-converted text.
- This would delete `web-fetch.ts`, `web-html.ts`, `url-guard.ts`, the MCP web tool and their tests (about 975 lines plus tests). `web-document.ts` would shrink to a thin wrapper.

Unconfirmed:
- The Copilot `web_fetch` argument names and result shape. It is listed as a built-in tool, but no real call was seen in session logs, which only show `view`, `glob` and `bash`.
- Whether the host pre-truncates pages or returns binary results for PDF URLs. The hook would have to pass those through.

Trade-offs:
- Lose: the explicit "answer this question from this URL" path. The question would come from the last user prompt, as it does for `read`.
- Lose: opt-in. Every large web-fetch result would be condensed. Small pages pass through unchanged.
- Gain: no SSRF guard, fetcher or HTML converter for ParaDoc to own.
- Roadmap note: "replacing host native web tools" is out of scope. Condensing their output is not replacing them.
- Process note: the M005 validation result is `needs-attention`, caused by the browser-evidence gate on S01 and S03, not by code.
