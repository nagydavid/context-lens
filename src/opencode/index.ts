// OpenCode plugin adapter for ParaDoc
// Integrates with OpenCode's native plugin API

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
export type { InterceptOptions, InterceptionResult, ReadRequest } from "../core/index.js";
