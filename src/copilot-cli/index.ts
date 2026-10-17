export {
  createMcpServer,
  serveStdio,
  handleParaDocRead,
  toToolResult,
  PARADOC_READ_TOOL,
  type McpServerOptions,
} from "./mcp-server.js";
export { createCopilotHooks, COPILOT_HINT, type CopilotHooksOptions } from "./hooks.js";
export {
  CopilotCliSubagentRunner,
  createCopilotRunner,
  buildCopilotChildArgs,
  NO_TOOLS_ARGS,
} from "./subagent.js";
export {
  registerParaDoc,
  buildExtensionShim,
  defaultEntryUrl,
} from "./extension-entry.js";
export type {
  CopilotHooks,
  CopilotSessionLike,
  CopilotToolResult,
  JoinSession,
  PostToolUseHookInput,
  PostToolUseHookOutput,
  UserPromptSubmittedHookInput,
} from "./types.js";
