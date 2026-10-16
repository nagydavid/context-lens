// OpenCode plugin adapter for ContextLens
// Integrates with OpenCode's native plugin API

import { interceptRead } from "../core/index.js";
import type { ReadRequest, InterceptionResult } from "../core/index.js";

export interface OpenCodeReadParams {
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  context?: {
    goal?: string;
    instructions?: string;
    currentTask?: string;
  };
}

/**
 * OpenCode plugin entry point
 * Called by OpenCode's plugin system when a large read is about to happen
 */
export async function handleOpenCodeRead(
  params: OpenCodeReadParams
): Promise<InterceptionResult> {
  const request: ReadRequest = {
    filePath: params.filePath,
    startLine: params.lineStart,
    endLine: params.lineEnd,
    agentContext: {
      goal: params.context?.goal,
      instructions: params.context?.instructions,
      currentTask: params.context?.currentTask,
    },
  };

  return interceptRead(request);
}

export { interceptRead };
export type { InterceptionResult, ReadRequest };
