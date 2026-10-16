// Copilot CLI PreToolUse hook handler
// Intercepts read_file tool calls before they execute

import { interceptRead } from "../core/index.js";
import type { ReadRequest } from "../core/index.js";

export interface PreToolUseHookContext {
  toolName: string;
  toolInput: Record<string, unknown>;
  agentGoal?: string;
  agentInstructions?: string;
}

export interface HookResponse {
  modified: boolean;
  toolName: string;
  toolInput: Record<string, unknown>;
  // If we intercept: return the interception result directly
  interceptedResult?: {
    type: "intercepted";
    filePath: string;
    excerpts: Array<{
      startLine: number;
      endLine: number;
      content: string;
    }>;
    summary: string;
    contextSaved: number;
  };
}

/**
 * PreToolUse hook: intercepts tool calls before execution
 */
export async function handlePreToolUseHook(
  context: PreToolUseHookContext
): Promise<HookResponse> {
  // Only intercept read_file tool calls
  if (context.toolName !== "read_file") {
    return {
      modified: false,
      toolName: context.toolName,
      toolInput: context.toolInput,
    };
  }

  const filePath = context.toolInput.path as string | undefined;
  if (!filePath) {
    return {
      modified: false,
      toolName: context.toolName,
      toolInput: context.toolInput,
    };
  }

  try {
    const request: ReadRequest = {
      filePath,
      agentContext: {
        goal: context.agentGoal,
        instructions: context.agentInstructions,
      },
    };

    const result = await interceptRead(request);

    // If no interception was needed, let the original tool call proceed
    if (!result.wasIntercepted) {
      return {
        modified: false,
        toolName: context.toolName,
        toolInput: context.toolInput,
      };
    }

    // Return interception result without calling the original tool
    return {
      modified: true,
      toolName: context.toolName,
      toolInput: context.toolInput,
      interceptedResult: {
        type: "intercepted",
        filePath: result.filePath,
        excerpts: result.excerpts,
        summary: result.summary,
        contextSaved: result.contextSaved,
      },
    };
  } catch (error) {
    // On error, let the original tool call proceed
    console.error("Hook error:", error);
    return {
      modified: false,
      toolName: context.toolName,
      toolInput: context.toolInput,
    };
  }
}
