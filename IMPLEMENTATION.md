# ParaDoc Implementation Plan

## Overview

Build a cheap-model (Haiku) read interceptor using the Spotify Portal pattern:
- PreToolUse hook intercepts large reads (>350 lines)
- Cheap model infers a question from agent's task context
- Returns excerpts + line ranges + summary
- Expensive agent gets bounded context in one round-trip

**Recommendation stack (approved):**
1. Question generation: Task context (implicit from agent's goal)
2. Return shape: Hybrid (excerpts + line ranges + one-line summary)
3. Threshold: Fixed 350 lines

## Integrations

- **OpenCode**: Plugin API (native integration point)
- **Copilot CLI**: MCP + PreToolUse hook

## Phases

### Phase 1: Core Interceptor
**Goal:** Build the cheap-model interrogation logic, decoupled from host integrations.

- `src/core/interceptor.ts`: Main routing logic
  - Detects large reads (>350 lines)
  - Extracts implicit question from context
  - Calls cheap model with bounded prompt
  - Parses and formats hybrid return (excerpts + ranges + summary)

- `src/core/models.ts`: Type definitions
  - `ReadRequest` (file, range, context)
  - `InterceptionResult` (excerpts, line_ranges, summary)
  - `AgentContext` (goal, instructions, current task)

- `src/core/prompts.ts`: Cheap-model prompt templates
  - Question extraction from agent context
  - Bounded-read instructions
  - Return format specification

### Phase 2: OpenCode Adapter
**Goal:** Integrate into OpenCode's plugin API.

- `src/opencode/plugin.ts`: Plugin entry point
  - Hook into file-read interception
  - Delegate to core interceptor
  - Return results in OpenCode format

### Phase 3: Copilot CLI Adapter
**Goal:** Integrate into Copilot CLI via MCP + hook.

- `src/copilot-cli/mcp-server.ts`: MCP server definition
  - Expose bounded-read tools
  - Tool use with context integration

- `src/copilot-cli/hook.ts`: PreToolUse hook handler
  - Intercept `read_file` tool calls
  - Route through core interceptor
  - Return modified call or results

## Constraints

- Preserve normal small-file reads (≤350 lines) — no interception
- No source upload to external service
- No new dependencies if avoidable
- Cheap model inference cost: ~10–30s, acceptable for >90% context savings
- Error handling: graceful fallback to full read on cheap-model failure

## Success Criteria

- [x] Approve design recommendations
- [ ] Core interceptor working (cheap model → excerpts)
- [ ] OpenCode integration (read interception via plugin API)
- [ ] Copilot CLI integration (MCP + hook)
- [ ] End-to-end test with both harnesses
- [ ] Observability: logs show interception + context savings
