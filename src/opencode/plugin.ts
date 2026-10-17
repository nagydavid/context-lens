import { createParaDocHooks } from "./hooks.js";
import type { ParaDocClient } from "./hooks.js";

/** Minimal mirror of the OpenCode PluginInput fields this plugin uses. */
export type ParaDocPluginInput = {
  client: unknown;
  directory: string;
  worktree?: string;
};

// The cast is type-only: the SDK client's generated method types are structurally wider.
export const ParaDocPlugin = async (input: ParaDocPluginInput) =>
  createParaDocHooks({
    client: input.client as ParaDocClient,
    directory: input.directory,
    worktree: input.worktree,
  });
