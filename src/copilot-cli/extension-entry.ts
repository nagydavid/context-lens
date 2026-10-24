import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyReset,
  applySet,
  parseControlArgs,
  renderChange,
  renderStatus,
} from "../core/controls.js";
import { createCopilotHooks, type CopilotHooksOptions } from "./hooks.js";
import type { CopilotSessionLike, JoinSession } from "./types.js";

const PARADOC_COMMAND_DESCRIPTION =
  "Show or change ParaDoc settings: status | set <key> <value> | reset [key] [--global]";

export async function registerParaDoc(
  joinSession: JoinSession,
  options: CopilotHooksOptions = {},
) {
  const hooks = createCopilotHooks(options);
  let session: CopilotSessionLike | undefined;
  let workingDirectory: string | undefined;
  const rememberWorkingDirectory = (input: { workingDirectory?: string }) => {
    if (input.workingDirectory) workingDirectory = input.workingDirectory;
  };
  const configOptionsFor = (projectRoot: string) => ({
    ...options.configOptions,
    env: options.configOptions?.env ?? options.env,
    projectRoot,
  });
  const command = {
    name: "paradoc",
    description: PARADOC_COMMAND_DESCRIPTION,
    async handler(context: { args: string }) {
      const action = parseControlArgs(context.args);
      if (action.action === "error") throw new Error(action.message);

      const projectRoot = workingDirectory ?? process.cwd();
      let text: string;
      if (action.action === "status") {
        text = renderStatus(await hooks.getStatus(projectRoot));
      } else if (action.action === "set") {
        const result = applySet({ [action.key]: action.value }, action.scope, configOptionsFor(projectRoot));
        if (!result.ok) throw new Error(result.message);
        text = renderChange("set", result);
      } else {
        const result = applyReset(action.scope, configOptionsFor(projectRoot), action.key ? [action.key] : undefined);
        if (!result.ok) throw new Error(result.message);
        text = renderChange("reset", result);
      }

      try {
        const pending = session?.log?.(text, { level: "info" });
        void Promise.resolve(pending).catch(() => undefined);
      } catch {
        // Host logging is best-effort; a successful control operation stays successful.
      }
    },
  };
  session = await joinSession({
    hooks: {
      onPostToolUse: async (input, invocation) => {
        rememberWorkingDirectory(input);
        return hooks.onPostToolUse(input, invocation);
      },
      onUserPromptSubmitted: async (input, invocation) => {
        rememberWorkingDirectory(input);
        return hooks.onUserPromptSubmitted(input, invocation);
      },
    },
    commands: [command],
  });
  hooks.setSession(session);
  try {
    const pending = session.log?.("[paradoc] info: Copilot CLI hooks registered");
    void Promise.resolve(pending).catch(() => undefined);
  } catch {
    // Host logging is best-effort and must not prevent registration.
  }
  return { session, hooks };
}

export function buildExtensionShim(entryUrl: string): string {
  const url = entryUrl.startsWith("file:")
    ? new URL(entryUrl)
    : isAbsolute(entryUrl)
      ? pathToFileURL(entryUrl)
      : (() => { throw new TypeError("extension entry must be a file:// URL or absolute path"); })();
  if (url.protocol !== "file:") {
    throw new TypeError("extension entry must be a file:// URL");
  }
  return [
    'import { joinSession } from "@github/copilot-sdk/extension";',
    `import { registerParaDoc } from ${JSON.stringify(url.href)};`,
    "await registerParaDoc(joinSession);",
    "",
  ].join("\n");
}

export function defaultEntryUrl(): string {
  return import.meta.url;
}
