import { createContextLensHooks } from "./hooks.js";
import type { ContextLensClient } from "./hooks.js";

/** Minimal mirror of the OpenCode PluginInput fields this plugin uses. */
export type ContextLensPluginInput = {
  client: unknown;
  directory: string;
  worktree?: string;
};

// The cast is type-only: the SDK client's generated method types are structurally wider.
export const ContextLensPlugin = async (input: ContextLensPluginInput) =>
  createContextLensHooks({
    client: input.client as ContextLensClient,
    directory: input.directory,
    worktree: input.worktree,
  });
