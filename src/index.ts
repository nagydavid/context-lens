// ParaDoc: Cheap-model read interceptor for coding agents
// Spotify Portal pattern implementation

export * from "./core/index.js";
export * from "./opencode/index.js";
export { createMcpServer, serveStdio, PARADOC_READ_TOOL } from "./copilot-cli/index.js";
export {
  createCopilotHooks,
  CopilotCliSubagentRunner,
  registerParaDoc,
  buildExtensionShim,
} from "./copilot-cli/index.js";
