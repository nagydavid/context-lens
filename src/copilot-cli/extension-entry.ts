import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createCopilotHooks, type CopilotHooksOptions } from "./hooks.js";
import type { JoinSession } from "./types.js";

export async function registerParaDoc(
  joinSession: JoinSession,
  options: CopilotHooksOptions = {},
) {
  const hooks = createCopilotHooks(options);
  const session = await joinSession({
    hooks: {
      onPostToolUse: hooks.onPostToolUse,
      onUserPromptSubmitted: hooks.onUserPromptSubmitted,
    },
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
