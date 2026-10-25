import { statSync } from "node:fs";
import { resolve } from "node:path";
import {
  createDiagnostics,
  createHostRuntime,
  displayPathFor,
  errorMessage,
  explicitFromOptions,
  isRecord,
} from "../core/host-runtime.js";
import { renderInterceptionResult } from "../core/render.js";
import type { ParadocStatus } from "../core/status.js";
import type {
  ConfigOptions,
  JudgeOptions,
  PdfExtractor,
  ResultCache,
  SubagentRunner,
} from "../core/index.js";
import { createCopilotRunner } from "./subagent.js";
import type {
  CopilotHooks,
  CopilotSessionLike,
  CopilotToolResult,
  PostToolUseHookInput,
} from "./types.js";

export const COPILOT_HINT =
  "Note: this view was condensed by paradoc. Re-run view with an explicit view_range to see exact or full content; ranged views are never condensed.";

export interface CopilotHooksOptions {
  runner?: SubagentRunner;
  /** Result cache shared across all per-directory interceptors. */
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
  configOptions?: Pick<ConfigOptions, "homeDir" | "env" | "projectRoot">;
  env?: NodeJS.ProcessEnv;
  logSink?: (line: string, record: object) => void;
}

const MAX_TRACKED_SESSIONS = 100;
const MAX_TASK_CHARS = 2000;

function hasRangeArgument(args: Record<string, unknown>): boolean {
  // Offset reads are explicit requests for exact content; never condense them.
  // A bare `limit` is how models ask for the top of a file, so it is still
  // condensed. `view_range` / `start_line` / `end_line` are unambiguous ranges.
  return Object.keys(args).some((key) =>
    /range/i.test(key) || ["start_line", "startLine", "end_line", "endLine"].includes(key),
  );
}

/** Creates probe-shaped Copilot hooks which never replace a host view on failure. */
export function createCopilotHooks(
  options: CopilotHooksOptions = {},
): CopilotHooks & {
  setSession(session: CopilotSessionLike): void;
  getStatus(projectRoot: string): Promise<ParadocStatus>;
} {
  const env = options.env ?? process.env;
  let session: CopilotSessionLike | undefined;
  const lastPrompt = new Map<string, string>();

  // Host delivery is injected; session.log stays independent of the caller's sink.
  const diagnostics = createDiagnostics({
    logFile: env.PARADOC_LOG_FILE,
    sink: (line, record) => {
      try {
        if (options.logSink) options.logSink(line, record);
        else process.stderr.write(`${line}\n`);
      } catch {
        // Logging must never alter host behaviour.
      }
      try {
        const pending = session?.log?.(line, record);
        void Promise.resolve(pending).catch(() => undefined);
      } catch {
        // Host session logging is best-effort.
      }
    },
  });
  const log = diagnostics.log;

  // configOptions.projectRoot only picks the project for process-scoped knobs; per-view tuning uses the view workingDirectory.
  const runtime = createHostRuntime({
    projectRoot: options.configOptions?.projectRoot ?? process.cwd(),
    configOptions: options.configOptions,
    env,
    explicit: explicitFromOptions(options),
    log,
    runner: options.runner ?? ((settings) => createCopilotRunner({ concurrency: settings.concurrency })),
    cache: options.cache,
    pdfExtractor: options.pdfExtractor,
    judge: options.judge,
    maxFileBytes: options.maxFileBytes,
    maxRetries: options.maxRetries,
    retryDelayMs: options.retryDelayMs,
  });

  return {
    setSession(nextSession) {
      session = nextSession;
    },

    getStatus(projectRoot) {
      return runtime.getStatus(projectRoot);
    },

    async onUserPromptSubmitted(input) {
      try {
        const prompt = input.prompt.trim().slice(0, MAX_TASK_CHARS);
        if (!prompt) return;
        lastPrompt.delete(input.sessionId);
        lastPrompt.set(input.sessionId, prompt);
        if (lastPrompt.size > MAX_TRACKED_SESSIONS) {
          const oldest = lastPrompt.keys().next().value;
          if (oldest !== undefined) lastPrompt.delete(oldest);
        }
      } catch (error) {
        log("error", `prompt capture failed: ${errorMessage(error)}`);
      }
    },

    async onPostToolUse(input: PostToolUseHookInput) {
      try {
        // Only ParaDoc's own child processes are skipped (PARADOC_CHILD=1). Subagents
        // spawned by the host are NOT marked, so their views ARE intercepted on purpose:
        // a host subagent reading a whole file is exactly the token waste ParaDoc exists
        // to remove.
        if (env.PARADOC_CHILD === "1") return undefined;
        if (input.toolName !== "view") return undefined;
        if (!isRecord(input.toolArgs)) return undefined;
        const path = input.toolArgs.path;
        if (typeof path !== "string" || path.trim() === "") return undefined;
        if (input.toolResult?.resultType !== "success") return undefined;
        if (hasRangeArgument(input.toolArgs)) {
          runtime.interceptorFor(input.workingDirectory).noteBypass();
          return undefined;
        }
        if ((input.toolResult.toolTelemetry as { properties?: { viewType?: string } } | undefined)?.properties?.viewType === "directory") return undefined;

        const resolved = resolve(input.workingDirectory, path);
        try {
          if (statSync(resolved).isDirectory()) return undefined;
        } catch {
          // The interceptor will classify unreadable or missing files as a fallback.
        }

        const result = await runtime.interceptorFor(input.workingDirectory).intercept({
          filePath: resolved,
          projectRoot: input.workingDirectory,
          agentContext: { currentTask: lastPrompt.get(input.sessionId) },
        });
        if (!result.wasIntercepted || result.excerpts.length === 0) return undefined;
        const modifiedResult: CopilotToolResult = {
          ...input.toolResult,
          textResultForLlm: renderInterceptionResult(result, {
            displayPath: displayPathFor(path, input.workingDirectory),
            hint: COPILOT_HINT,
          }),
        };
        return { modifiedResult };
      } catch (error) {
        log("error", `view interception failed: ${errorMessage(error)}`, {
          tool: input.toolName,
          sessionId: input.sessionId,
        });
        return undefined;
      }
    },
  };
}
