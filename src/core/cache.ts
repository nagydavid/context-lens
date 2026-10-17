import { createHash } from "node:crypto";
import type { InterceptionResult } from "./models.js";

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_MAX_BYTES = 4_000_000;

export interface ResultCache {
  get(key: string): InterceptionResult | undefined;
  set(key: string, result: InterceptionResult): void;
}

/** Bump when subagent/judge prompts change so stale cached answers are invalidated. */
export const PROMPT_VERSION = "v1";

export interface CacheKeyInput {
  contentSha256: string;
  question: string;
  model?: { providerID: string; modelID: string };
  promptVersion?: string;
  chunkLines?: number;
  chunkOverlapLines?: number;
  judgeMode?: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** agentContext is deliberately excluded (D012); only the resolved question is keyed. */
export function cacheKey(input: CacheKeyInput): string {
  return sha256(JSON.stringify([
    input.contentSha256,
    input.question,
    input.model ? `${input.model.providerID}/${input.model.modelID}` : "",
    input.promptVersion ?? PROMPT_VERSION,
    input.chunkLines ?? 0,
    input.chunkOverlapLines ?? 0,
    input.judgeMode ?? "off",
  ]));
}

interface CacheEntry {
  value: InterceptionResult;
  bytes: number;
}

export class LruResultCache implements ResultCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;

  constructor(options: { maxEntries?: number; maxBytes?: number } = {}) {
    this.maxEntries = validEntries(options.maxEntries) ? options.maxEntries : DEFAULT_MAX_ENTRIES;
    this.maxBytes = validBytes(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): InterceptionResult | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.value);
  }

  set(key: string, result: InterceptionResult): void {
    const bytes = JSON.stringify(result).length;
    if (bytes > this.maxBytes) return;

    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.totalBytes -= existing.bytes;
    }

    this.entries.set(key, { value: structuredClone(result), bytes });
    this.totalBytes += bytes;
    this.evict();
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) return;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.totalBytes -= oldest?.bytes ?? 0;
    }
  }
}

function validEntries(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function validBytes(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}
