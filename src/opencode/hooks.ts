import {
  createHostRuntime,
  displayPathFor,
  explicitFromOptions,
  isRecord,
} from "../core/host-runtime.js";
import { renderInterceptionResult } from "../core/render.js";
import type { JudgeOptions, PdfExtractor, ResultCache, SubagentRunner } from "../core/index.js";
import { createOpenCodeModelPicker } from "./model-picker.js";
import type { OpenCodeModelPickerOptions, OpenCodePickerUi } from "./model-picker.js";
import { createOpenCodeRunner } from "./subagent.js";
import type { OpenCodeSessionClient } from "./subagent.js";

export type ParaDocLogLevel = "debug" | "info" | "warn" | "error";

export interface ParaDocClient extends OpenCodeSessionClient {
  app?: {
    log(opts: {
      body: {
        service: string;
        level: ParaDocLogLevel;
        message: string;
        extra?: Record<string, unknown>;
      };
    }): Promise<unknown>;
  };
}

export interface ParaDocHooksOptions {
  client: ParaDocClient;
  directory: string;
  worktree?: string;
  ui?: OpenCodePickerUi;
  pickerOptions?: OpenCodeModelPickerOptions;
  /** Test seam: replaces the OpenCode child-session runner. */
  runner?: SubagentRunner;
  /** Result cache shared by this host process; defaults to a bounded in-memory LRU. */
  cache?: ResultCache;
  thresholdLines?: number;
  chunkLines?: number;
  chunkOverlapLines?: number;
  concurrency?: number;
  timeoutMs?: number;
  maxFileBytes?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  judge?: JudgeOptions;
  /** Test seam: replaces native pdftotext extraction. */
  pdfExtractor?: PdfExtractor;
  /** Test seam: isolates config resolution from the real user environment. */
  configOptions?: { homeDir?: string; env?: Record<string, string | undefined> };
}

export interface ParaDocHooks {
  "chat.message": (
    input: {
      sessionID: string;
      agent?: string;
      model?: { providerID: string; modelID: string };
      messageID?: string;
    },
    output: { message: unknown; parts: unknown[] }
  ) => Promise<void>;
  "tool.execute.after": (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown }
  ) => Promise<void>;
}

const MAX_CHILD_SESSIONS = 256;
const MAX_TRACKED_SESSIONS = 100;
const MAX_TASK_CHARS = 2000;

export function createParaDocHooks(options: ParaDocHooksOptions): ParaDocHooks {
  const { client, directory } = options;

  const log = (
    level: ParaDocLogLevel,
    message: string,
    extra?: Record<string, unknown>
  ): void => {
    try {
      const pending = client.app?.log({
        body: { service: "paradoc", level, message, ...(extra ? { extra } : {}) },
      });
      void Promise.resolve(pending).catch(() => {});
    } catch {
      // Logging must never affect host behaviour.
    }
  };

  const childSessions = new Set<string>();
  const runtime = createHostRuntime({
    projectRoot: directory,
    configOptions: options.configOptions,
    explicit: explicitFromOptions(options),
    log,
    runner: options.runner ?? ((settings) =>
      createOpenCodeRunner(client, {
        titlePrefix: "paradoc",
        concurrency: settings.concurrency,
        onSessionCreated: (id) => {
          childSessions.add(id);
          if (childSessions.size > MAX_CHILD_SESSIONS) {
            const oldest = childSessions.values().next().value;
            if (oldest !== undefined) childSessions.delete(oldest);
          }
        },
      })),
    cache: options.cache,
    picker: options.ui ? createOpenCodeModelPicker(options.ui, options.pickerOptions) : undefined,
    pdfExtractor: options.pdfExtractor,
    judge: options.judge,
    maxFileBytes: options.maxFileBytes,
    maxRetries: options.maxRetries,
    retryDelayMs: options.retryDelayMs,
  });
  const interceptor = runtime.interceptorFor(directory);

  const lastUserText = new Map<string, string>();

  return {
    "chat.message": async (input, output) => {
      try {
        if (childSessions.has(input.sessionID)) return;
        const text = (Array.isArray(output.parts) ? output.parts : [])
          .filter(
            (part): part is Record<string, unknown> =>
              isRecord(part) &&
              part.type === "text" &&
              typeof part.text === "string" &&
              part.synthetic !== true
          )
          .map((part) => part.text as string)
          .join("\n")
          .trim()
          .slice(0, MAX_TASK_CHARS);
        if (!text) return;
        lastUserText.delete(input.sessionID);
        lastUserText.set(input.sessionID, text);
        if (lastUserText.size > MAX_TRACKED_SESSIONS) {
          const oldest = lastUserText.keys().next().value;
          if (oldest !== undefined) lastUserText.delete(oldest);
        }
      } catch (error) {
        log("error", `chat.message capture failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    "tool.execute.after": async (input, output) => {
      try {
        if (String(input.tool).toLowerCase() !== "read") return;
        // Only ParaDoc's own child sessions are skipped. Subagents spawned by the
        // host `task` tool are NOT in `childSessions`, so their reads ARE intercepted
        // on purpose: a host subagent reading a whole file is exactly the token waste
        // ParaDoc exists to remove. ParaDoc's own children are exempt because their
        // output is already condensed by the subagent prompt.
        if (childSessions.has(input.sessionID)) return;
        const args = input.args;
        if (!isRecord(args)) return;
        // OpenCode 1.x exposed `filePath`; v2's native read tool sends `path`.
        const filePath = typeof args.filePath === "string" ? args.filePath : args.path;
        if (typeof filePath !== "string" || filePath === "") return;
        // Offset reads are explicit requests for exact content; never condense them.
        // A bare `limit` is how models ask for the top of a file, so it is still
        // condensed.
        if (args.offset !== undefined) {
          interceptor.noteBypass();
          return;
        }

        const result = await interceptor.intercept({
          filePath,
          projectRoot: directory,
          question: typeof args.question === "string" ? args.question : undefined,
          agentContext: { currentTask: lastUserText.get(input.sessionID) },
        });
        if (result.wasIntercepted && result.excerpts.length > 0) {
          output.output = renderInterceptionResult(result, {
            displayPath: displayPathFor(filePath, options.worktree ?? directory),
          });
        }
      } catch (error) {
        log(
          "error",
          `read interception failed: ${error instanceof Error ? error.message : String(error)}`,
          { tool: input.tool, sessionID: input.sessionID, callID: input.callID }
        );
      }
    },
  };
}
