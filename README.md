# ContextLens

ContextLens provides harness-native, focused source context for coding agents. It prevents oversized raw-file reads from flooding an agent's context window while keeping inference entirely with the model selected by the host harness.

## Product intent

Support both:

- OpenCode, through its native plugin API
- GitHub Copilot CLI, through supported MCP and hook integration points

## Core mechanism (Spotify Portal pattern)

ContextLens uses a **cheap model (Haiku) as an intelligent read interceptor**:

- **PreToolUse hook** intercepts large file reads (>350 lines)
- **Cheap model** infers a question from the agent's task context
- **Excerpts returned** as a hybrid format: actual text + line ranges + one-line summary
- **Context savings**: ~90% reduction when intercepting large files
- **Cost trade-off**: ~10–30s per cheap-model call is acceptable for intercepted reads

The expensive agent (selected by the harness) never sees the full large file; it works with bounded excerpts and implicit context, reducing its token consumption dramatically.

## Expected behavior

- Intercept or guide oversized source reads before their full contents enter the agent context.
- Provide bounded, deterministic tools for file discovery, line-ranged reads, search, metadata, and concise source selection.
- Preserve normal small-file reads.
- Validate paths, apply project-root boundaries, and return actionable errors.
- Be observable: explain when a read was limited or redirected without exposing unrelated source.

## Architecture direction

Keep a harness-independent core for path validation, size and line limits, source discovery, bounded reads, and result formatting. Build thin adapters for each host integration API rather than attempting one portable plugin binary.

## Non-goals

- Replacing or selecting the harness's primary agent model (the cheap interceptor is supplementary, not a replacement)
- Uploading source code to a ContextLens-operated remote service
- Depending on the existing Strata file-shunt implementation

## OpenCode

Add the plugin to `opencode.json`:

```json
{ "plugin": ["context-lens/plugin"] }
```

or re-export it from `.opencode/plugin/context-lens.ts`:
`export { ContextLensPlugin } from "context-lens/plugin";`

The cheap model is chosen from `CONTEXT_LENS_MODEL="provider/model"`, else
`.context-lens/config.json` or `~/.config/context-lens/config.json`, else the host default.

Native `read` results over 350 lines are condensed into excerpts with line ranges and a
confidence score. Small files and ranged reads (`offset`/`limit`) pass through unchanged.

## Implementation status

- ✅ Phase 1: Core interceptor (cheap model + excerpt extraction)
- 🚧 Phase 2: OpenCode adapter (plugin API)
- 🚧 Phase 3: Copilot CLI adapter (MCP + hook)
