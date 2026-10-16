# ContextLens

ContextLens provides harness-native, focused source context for coding agents. It prevents oversized raw-file reads from flooding an agent's context window while keeping inference entirely with the model selected by the host harness.

## Product intent

Support both:

- OpenCode, through its native plugin API
- GitHub Copilot CLI, through supported MCP and hook integration points

## Core constraint

ContextLens must not call a separate model, local inference endpoint, or configure an independent `STRATA_MODEL`. The active model selected in OpenCode or Copilot remains responsible for deciding which ContextLens tools to call and how to use their returned context.

## Expected behavior

- Intercept or guide oversized source reads before their full contents enter the agent context.
- Provide bounded, deterministic tools for file discovery, line-ranged reads, search, metadata, and concise source selection.
- Preserve normal small-file reads.
- Validate paths, apply project-root boundaries, and return actionable errors.
- Be observable: explain when a read was limited or redirected without exposing unrelated source.

## Architecture direction

Keep a harness-independent core for path validation, size and line limits, source discovery, bounded reads, and result formatting. Build thin adapters for each host integration API rather than attempting one portable plugin binary.

## Non-goals

- Replacing or selecting the harness's primary agent model
- Calling a separate summarization or routing model
- Uploading source code to a ContextLens-operated remote service
- Depending on the existing Strata file-shunt implementation
