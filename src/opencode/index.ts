// OpenCode plugin adapter for ParaDoc
// Integrates with OpenCode's native plugin API

import { interceptRead } from "../core/index.js";
import type {
  InterceptOptions,
  InterceptionResult,
  ReadRequest,
} from "../core/index.js";

export interface OpenCodeReadParams {
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  question?: string;
  projectRoot?: string;
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
  params: OpenCodeReadParams,
  options?: InterceptOptions
): Promise<InterceptionResult> {
  const request: ReadRequest = {
    filePath: params.filePath,
    startLine: params.lineStart,
    endLine: params.lineEnd,
    question: params.question,
    projectRoot: params.projectRoot,
    agentContext: {
      goal: params.context?.goal,
      instructions: params.context?.instructions,
      currentTask: params.context?.currentTask,
    },
  };

  return interceptRead(request, options);
}

export { interceptRead };
export {
  ModelSelector,
  configPath,
  loadModelConfig,
  saveModelConfig,
} from "../core/index.js";
export {
  createOpenCodeModelPicker,
} from "./model-picker.js";
export { createParaDocHooks } from "./hooks.js";
export { renderInterceptionResult } from "./render.js";
export {
  SessionSubagentRunner,
  createOpenCodeRunner,
} from "./subagent.js";
export type {
  ConfigOptions,
  ConfigScope,
  ModelChoice,
  ModelPicker,
  ModelPickResult,
  ModelSelectorOptions,
  ModelSource,
  ResolvedModel,
  ResolvedModelSource,
  StoredModel,
} from "../core/index.js";
export type {
  ParaDocClient,
  ParaDocHooks,
  ParaDocHooksOptions,
  ParaDocLogLevel,
} from "./hooks.js";
export type {
  OpenCodeModelPickerOptions,
  OpenCodePickerChoice,
  OpenCodePickerUi,
} from "./model-picker.js";
export type {
  OpenCodeSessionClient,
  SessionSubagentRunnerOptions,
} from "./subagent.js";
export type { InterceptOptions, InterceptionResult, ReadRequest };
