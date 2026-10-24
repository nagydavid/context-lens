import { TimeoutError } from "../core/fanout.js";
import type { SubagentRequest, SubagentResult, SubagentRunner } from "../core/subagent.js";

/**
 * A content-derived stand-in for the cheap model.
 *
 * It is deliberately NOT a canned answer: it reads the numbered file content out of the prompt it
 * actually receives, finds the gold needle inside that content, and reports the line numbers where
 * it found it. That makes the harness's answer-quality proxies non-circular — a wrong gold range in
 * the manifest would produce a wrong-looking measurement instead of a silently passing one.
 */
export type AccuracyProfile = "correct" | "partial" | "wrong" | "invalid-json" | "timeout";

export const ACCURACY_PROFILES: readonly AccuracyProfile[] = ["correct", "partial", "wrong", "invalid-json", "timeout"];

/** Confidence the simulated model reports per profile (1-5, the schema's range). */
export const PROFILE_CONFIDENCE: Record<Exclude<AccuracyProfile, "invalid-json" | "timeout">, number> = {
  correct: 5,
  partial: 3,
  wrong: 4,
};

export interface SimulatedCheapModelOptions {
  profile: AccuracyProfile;
  /** Substrings that mark the answer. The runner locates them in the prompt; it never trusts a range. */
  needles: readonly string[];
  /** Simulated model latency applied to every call. */
  latencyMs?: number;
  /** How far past the caller's deadline the 'timeout' profile sleeps. */
  timeoutSlackMs?: number;
}

interface NumberedLine {
  line: number;
  text: string;
}

interface ExcerptRange {
  startLine: number;
  endLine: number;
}

const NUMBERED_LINE = /^(\d+)\| (.*)$/;
const QUESTION_LINE = /^QUESTION: (.*)$/;
const JUDGE_HEADER = "Decide whether the supplied excerpts clearly answer the question.";

/** Pull the `NNNNN| text` content block out of a prompt built by buildSubagentPrompt. */
export function parseNumberedLines(prompt: string): NumberedLine[] {
  const lines: NumberedLine[] = [];
  for (const raw of prompt.split("\n")) {
    const match = NUMBERED_LINE.exec(raw);
    if (match) lines.push({ line: Number(match[1]), text: match[2] });
  }
  return lines;
}

/** The question the interceptor asked, when the prompt carries one. */
export function parseQuestion(prompt: string): string {
  for (const raw of prompt.split("\n")) {
    const match = QUESTION_LINE.exec(raw);
    if (match) return match[1];
  }
  return "";
}

/** Judge prompts are the other prompt this runner is asked to answer. */
export function isJudgePrompt(prompt: string): boolean {
  return prompt.startsWith(JUDGE_HEADER);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function merge(ranges: ExcerptRange[]): ExcerptRange[] {
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const merged: ExcerptRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, range.endLine);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

export class SimulatedCheapModel implements SubagentRunner {
  readonly calls: SubagentRequest[] = [];
  readonly results: SubagentResult[] = [];
  readonly profile: AccuracyProfile;
  private readonly needles: readonly string[];
  private readonly latencyMs: number;
  private readonly timeoutSlackMs: number;

  constructor(options: SimulatedCheapModelOptions) {
    this.profile = options.profile;
    this.needles = options.needles;
    this.latencyMs = options.latencyMs ?? 0;
    this.timeoutSlackMs = options.timeoutSlackMs ?? 25;
  }

  async run(request: SubagentRequest): Promise<SubagentResult> {
    this.calls.push(request);
    const prompt = request.prompt;

    if (this.profile === "timeout") {
      // Sleep past the caller's deadline so the caller's own timeout path produces the fallback.
      await sleep(Math.max(request.timeoutMs + this.timeoutSlackMs, this.latencyMs));
      const error = new TimeoutError(request.timeoutMs);
      this.results.push({ text: error.message });
      throw error;
    }

    if (this.latencyMs > 0) await sleep(this.latencyMs);

    const result = isJudgePrompt(prompt) ? this.judge(prompt) : this.answer(prompt);
    this.results.push(result);
    return result;
  }

  /** Answer the excerpt-selection prompt from the content it actually sees. */
  private answer(prompt: string): SubagentResult {
    if (this.profile === "invalid-json") {
      return { text: `I found the answer somewhere in this file, it is about ${this.needles[0] ?? "the question"}. Trust me.` };
    }

    const lines = parseNumberedLines(prompt);
    const matched = lines.filter((entry) => this.needles.some((needle) => entry.text.includes(needle)));
    const question = parseQuestion(prompt);

    if (matched.length === 0) {
      // The needle is not in this window (chunked read, or a manifest mismatch): say so honestly.
      return {
        structured: {
          excerpts: [],
          summary: `No line in this window matches the question${question ? ` "${question}"` : ""}.`,
          confidence: 1,
        },
      };
    }

    const ranges = this.rangesFor(lines, matched);
    const confidence = PROFILE_CONFIDENCE[this.profile as keyof typeof PROFILE_CONFIDENCE] ?? 3;
    return {
      structured: {
        excerpts: ranges.map((range) => ({
          startLine: range.startLine,
          endLine: range.endLine,
          reason: `${this.profile} answer: matched ${range.endLine - range.startLine + 1} line(s) near "${this.needles[0] ?? ""}"`,
        })),
        summary: `${this.profile}: ${matched.length} matching line(s) at ${matched.map((m) => m.line).join(", ")}.`,
        confidence,
      },
    };
  }

  /** Judge the excerpts the interceptor already selected, by the same needle rule. */
  private judge(prompt: string): SubagentResult {
    if (this.profile === "invalid-json") return { text: "the excerpts look fine to me, no JSON needed" };
    const present = this.needles.some((needle) => prompt.includes(needle));
    return {
      structured: {
        verdict: present ? "sufficient" : "insufficient",
        reason: present ? "A gold needle appears in the supplied excerpts." : "No gold needle appears in the supplied excerpts.",
      },
    };
  }

  /**
   * Ranges the profile reports, always derived from the lines present in the prompt:
   * correct = the matched line plus its context, partial = half of that window,
   * wrong = a plausible window that deliberately excludes the matched line.
   */
  private rangesFor(lines: NumberedLine[], matched: NumberedLine[]): ExcerptRange[] {
    const first = lines[0]?.line ?? 1;
    const last = lines[lines.length - 1]?.line ?? 1;

    if (this.profile === "wrong") {
      const needleLines = new Set(matched.map((entry) => entry.line));
      const head: ExcerptRange = { startLine: first, endLine: Math.min(last, first + 2) };
      if (!overlaps(head, needleLines)) return [head];
      const tail: ExcerptRange = { startLine: Math.max(first, last - 2), endLine: last };
      if (!overlaps(tail, needleLines)) return [tail];
      const spare = lines.find((entry) => !needleLines.has(entry.line));
      return spare ? [{ startLine: spare.line, endLine: spare.line }] : [];
    }

    const ranges = matched.map((entry) =>
      this.profile === "partial"
        ? { startLine: entry.line, endLine: Math.min(last, entry.line + 1) }
        : { startLine: Math.max(first, entry.line - 1), endLine: Math.min(last, entry.line + 1) },
    );
    return merge(ranges);
  }
}

function overlaps(range: ExcerptRange, lines: Set<number>): boolean {
  for (let line = range.startLine; line <= range.endLine; line++) {
    if (lines.has(line)) return true;
  }
  return false;
}
