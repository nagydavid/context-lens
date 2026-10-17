import { isAbsolute, relative, resolve } from "path";
import { LruResultCache, ModelSelector, ReadInterceptor, eventLogLevel, type ResultCache } from "../core/index.js";
import type { InterceptionEvent, JudgeOptions, SubagentRunner } from "../core/index.js";
import { createOpenCodeModelPicker } from "./model-picker.js";
import type { OpenCodeModelPickerOptions, OpenCodePickerUi } from "./model-picker.js";
import { renderInterceptionResult } from "./render.js";
import { createOpenCodeRunner } from "./subagent.js";
import type { OpenCodeSessionClient } from "./subagent.js";

export type ContextLensLogLevel = "debug" | "info" | "warn" | "error";

export interface ContextLensClient extends OpenCodeSessionClient {
  app?: {
    log(opts: {
      body: {
        service: string;
        level: ContextLensLogLevel;
        message: string;
        extra?: Record<string, unknown>;
      };
    }): Promise<unknown>;
  };
}

export interface ContextLensHooksOptions {
  client: ContextLensClient;
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
  /** Test seam: isolates config resolution from the real user environment. */
  configOptions?: { homeDir?: string; env?: Record<string, string | undefined> };
}

export interface ContextLensHooks {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeEvent(event: InterceptionEvent): string {
  const judge = event.judge ? `, judge=${event.judge.verdict ?? "error"}` : "";
  const judgeError = event.judge?.error ? ` judge error: ${event.judge.error}` : "";
  if (event.intercepted) {
    return `intercepted ${event.filePath} (${event.lineCount} lines, confidence ${event.confidence ?? "?"}${event.chunks !== undefined ? `, chunks=${event.chunks}` : ""}${event.cacheHit ? ", cacheHit=true" : ""}${judge}, ${Math.round(event.elapsedMs ?? 0)}ms)${judgeError}`;
  }
  if (event.fallbackReason) {
    return `fallback ${event.fallbackReason} for ${event.filePath}${event.detail ? `: ${event.detail}` : ""}${judge}`;
  }
  return `passthrough ${event.filePath} (${event.lineCount} lines)`;
}

function displayPathFor(filePath: string, root: string): string {
  const rel = relative(root, resolve(root, filePath));
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? filePath : rel;
}

export function createContextLensHooks(options: ContextLensHooksOptions): ContextLensHooks {
  const { client, directory } = options;

  const log = (
    level: ContextLensLogLevel,
    message: string,
    extra?: Record<string, unknown>
  ): void => {
    try {
      const pending = client.app?.log({
        body: { service: "context-lens", level, message, ...(extra ? { extra } : {}) },
      });
      void Promise.resolve(pending).catch(() => {});
    } catch {
      // Logging must never affect host behaviour.
    }
  };

  const cache = options.cache ?? new LruResultCache();
  const childSessions = new Set<string>();
  const runner =
    options.runner ??
    createOpenCodeRunner(client, {
      titlePrefix: "context-lens",
      concurrency: options.concurrency,
      onSessionCreated: (id) => {
        childSessions.add(id);
        if (childSessions.size > MAX_CHILD_SESSIONS) {
          const oldest = childSessions.values().next().value;
          if (oldest !== undefined) childSessions.delete(oldest);
        }
      },
    });

  const selector = new ModelSelector({
    ...options.configOptions,
    projectRoot: directory,
    picker: options.ui ? createOpenCodeModelPicker(options.ui, options.pickerOptions) : undefined,
    onWarning: (m) => log("warn", m),
  });

  const interceptor = new ReadInterceptor({
    runner,
    cache,
    modelResolver: selector.resolve,
    thresholdLines: options.thresholdLines,
    chunkLines: options.chunkLines,
    chunkOverlapLines: options.chunkOverlapLines,
    timeoutMs: options.timeoutMs,
    maxFileBytes: options.maxFileBytes,
    maxRetries: options.maxRetries,
    retryDelayMs: options.retryDelayMs,
    judge: options.judge,
    logger: (event) =>
      log(
        eventLogLevel(event),
        describeEvent(event),
        { ...event }
      ),
  });

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
        if (childSessions.has(input.sessionID)) return;
        const args = input.args;
        if (!isRecord(args)) return;
        // OpenCode 1.x exposed `filePath`; v2's native read tool sends `path`.
        const filePath = typeof args.filePath === "string" ? args.filePath : args.path;
        if (typeof filePath !== "string" || filePath === "") return;
        if (args.offset !== undefined || args.limit !== undefined) return;

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
