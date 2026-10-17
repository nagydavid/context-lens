// ContextLens: Cheap-model read interceptor for coding agents
// Spotify Portal pattern implementation

export * from "./core/index.js";
export * from "./opencode/index.js";
export { createMcpServer, serveStdio, CONTEXT_LENS_READ_TOOL } from "./copilot-cli/index.js";
export {
  createCopilotHooks,
  CopilotCliSubagentRunner,
  registerContextLens,
  buildExtensionShim,
} from "./copilot-cli/index.js";
