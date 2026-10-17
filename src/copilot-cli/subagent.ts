import { spawn as childProcessSpawn } from "node:child_process";
import { tmpdir } from "node:os";
import { ConcurrencyLimitedRunner } from "../core/subagent.js";
import type { SubagentRequest, SubagentResult, SubagentRunner } from "../core/subagent.js";

export const NO_TOOLS_ARGS = ["--available-tools="] as const;

export interface ReadableLike {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export interface ChildLike {
  stdout: ReadableLike;
  stderr: ReadableLike;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal: NodeJS.Signals): unknown;
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; stdio: "pipe" },
) => ChildLike;

export interface CopilotCliSubagentRunnerOptions {
  command?: string;
  spawn?: SpawnLike;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  extraArgs?: string[];
}

export function buildCopilotChildArgs(
  request: SubagentRequest,
  extraArgs: readonly string[] = [],
): string[] {
  return [
    "-p",
    request.prompt,
    "-s",
    "--no-custom-instructions",
    "--disable-builtin-mcps",
    "--no-ask-user",
    ...NO_TOOLS_ARGS,
    ...(request.model ? ["--model", request.model.modelID] : []),
    ...extraArgs,
  ];
}

export function buildCopilotChildEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  delete env.GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS;
  env.PARADOC_CHILD = "1";
  return env;
}

export class CopilotCliSubagentRunner implements SubagentRunner {
  private readonly command: string;
  private readonly spawn: SpawnLike;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly extraArgs: readonly string[];

  constructor(options: CopilotCliSubagentRunnerOptions = {}) {
    this.command = options.command ?? process.env.PARADOC_COPILOT_BIN ?? "copilot";
    this.spawn = options.spawn ?? (childProcessSpawn as unknown as SpawnLike);
    this.cwd = options.cwd ?? tmpdir();
    this.env = options.env ?? process.env;
    this.extraArgs = options.extraArgs ?? [];
  }

  run(request: SubagentRequest): Promise<SubagentResult> {
    return new Promise((resolve, reject) => {
      let child: ChildLike;
      try {
        child = this.spawn(this.command, buildCopilotChildArgs(request, this.extraArgs), {
          env: buildCopilotChildEnv(this.env),
          cwd: this.cwd,
          stdio: "pipe",
        });
      } catch (error) {
        reject(error);
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        const error = new Error(`copilot timed out after ${request.timeoutMs}ms`);
        error.name = "TimeoutError";
        settle(() => reject(error));
      }, request.timeoutMs);

      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          settle(() => reject(new Error(`copilot binary not found (ENOENT): ${this.command}`)));
          return;
        }
        settle(() => reject(error));
      });
      child.on("close", (code) => {
        if (code !== 0) {
          const tail = stderr.slice(-500);
          settle(() => reject(new Error(`copilot exited with code ${code}: ${tail}`)));
          return;
        }
        settle(() => resolve({ text: stdout.trim() }));
      });
    });
  }
}

export function createCopilotRunner(
  options: CopilotCliSubagentRunnerOptions & { concurrency?: number } = {},
): SubagentRunner {
  const { concurrency, ...runnerOptions } = options;
  return new ConcurrencyLimitedRunner(
    new CopilotCliSubagentRunner(runnerOptions),
    concurrency ?? 1,
  );
}
