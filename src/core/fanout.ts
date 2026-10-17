import { mergeChunkAnswers, type ChunkWindow } from "./chunking.js";
import type { FallbackReason } from "./models.js";
import { parseSubagentResult } from "./parse.js";
import type { SubagentResult } from "./subagent.js";

export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Subagent timed out after ${timeoutMs}ms.`);
    this.name = "TimeoutError";
  }
}

export class NetworkError extends Error {
  constructor(readonly retries: number, cause: unknown) {
    super(`network error after ${retries} retries: ${errorMessage(cause)}`);
    this.name = "NetworkError";
  }
}

export type ChunkedOutcome =
  | { ok: true; attempts: number; merged: ReturnType<typeof mergeChunkAnswers> }
  | { ok: false; attempts: number; reason: FallbackReason; detail: string };

class ChunkFailure extends Error {
  constructor(
    readonly index: number,
    readonly reason: FallbackReason,
    readonly detail: string,
  ) {
    super(detail);
  }
}

export async function runChunkedRead({
  lines,
  windows,
  buildPrompt,
  run,
}: {
  lines: string[];
  windows: ChunkWindow[];
  buildPrompt: (window: ChunkWindow) => string;
  run: (prompt: string, state: { attempts: number }, isAborted: () => boolean) => Promise<SubagentResult>;
}): Promise<ChunkedOutcome> {
  let aborted = false;
  const states = windows.map(() => ({ attempts: 0 }));
  const tasks = windows.map((window, index) => (async () => {
    try {
      const response = await run(buildPrompt(window), states[index], () => aborted);
      const parsed = parseSubagentResult(response);
      if (!parsed.ok) throw new ChunkFailure(index, parsed.reason, parsed.detail);
      return { window, answer: parsed.answer };
    } catch (error) {
      aborted = true;
      if (error instanceof ChunkFailure) throw error;
      const reason: FallbackReason = error instanceof TimeoutError
        ? "timeout"
        : error instanceof NetworkError
          ? "network-error"
          : "subagent-error";
      throw new ChunkFailure(index, reason, errorMessage(error));
    }
  })());
  for (const task of tasks) task.catch(() => undefined);

  try {
    const answers = await Promise.all(tasks);
    const merged = mergeChunkAnswers(answers, lines.length);
    if (merged.contributing === 0) {
      return { ok: false, reason: "no-valid-excerpts", detail: "No valid excerpts returned.", attempts: maxAttempts(states) };
    }
    return { ok: true, merged, attempts: maxAttempts(states) };
  } catch (error) {
    const failure = error as ChunkFailure;
    const detail = `chunk ${failure.index + 1}/${windows.length}: ${failure.detail || "no detail"}`;
    return { ok: false, reason: failure.reason, detail, attempts: maxAttempts(states) };
  }
}

function maxAttempts(states: Array<{ attempts: number }>): number {
  return Math.max(0, ...states.map((state) => state.attempts));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
