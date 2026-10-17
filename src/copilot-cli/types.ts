export interface CopilotToolResult {
  resultType: string;
  textResultForLlm: string;
  toolTelemetry?: unknown;
  sessionLog?: string;
  [key: string]: unknown;
}

export interface PostToolUseHookInput {
  sessionId: string;
  timestamp?: string | number;
  workingDirectory: string;
  toolName: string;
  toolArgs: unknown;
  toolResult: CopilotToolResult;
}

export type PostToolUseHookOutput = { modifiedResult?: CopilotToolResult } | undefined;

export interface UserPromptSubmittedHookInput {
  sessionId: string;
  prompt: string;
  workingDirectory?: string;
}

export interface CopilotHooks {
  onPostToolUse: (
    input: PostToolUseHookInput,
    invocation?: { sessionId: string },
  ) => Promise<PostToolUseHookOutput>;
  onUserPromptSubmitted: (
    input: UserPromptSubmittedHookInput,
    invocation?: { sessionId: string },
  ) => Promise<void>;
}

export interface CopilotSessionLike {
  log?: (message: string, options?: unknown) => unknown;
}

export type JoinSession = (config: { hooks: Partial<CopilotHooks> }) => Promise<CopilotSessionLike>;
