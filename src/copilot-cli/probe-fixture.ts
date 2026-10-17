import type { PostToolUseHookInput } from "./types.js";

export { buildE2eFixture, E2E_FIXTURE_LINES, E2E_FIXTURE_SYMBOL, E2E_FIXTURE_SYMBOL_RANGE } from "../opencode/e2e-fixture.js";

export interface BuildViewInputOptions {
  path: string;
  workingDirectory: string;
  text: string;
  sessionId?: string;
  toolArgs?: unknown;
  resultType?: string;
  viewType?: string;
}

/** Builds the observed shape delivered to the post-tool-use hook for a file view. */
export function buildViewInput(options: BuildViewInputOptions): PostToolUseHookInput {
  return {
    sessionId: options.sessionId ?? "copilot-probe-session",
    timestamp: new Date().toISOString(),
    workingDirectory: options.workingDirectory,
    toolName: "view",
    toolArgs: options.toolArgs ?? { path: options.path },
    toolResult: {
      resultType: options.resultType ?? "success",
      textResultForLlm: options.text,
      toolTelemetry: {
        properties: { viewType: options.viewType ?? "file" },
        metrics: {},
      },
      sessionLog: "view file completed",
    },
  };
}
