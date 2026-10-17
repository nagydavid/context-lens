import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  cacheKey,
  LruResultCache,
  PROMPT_VERSION,
  sha256,
} from "./cache.js";
import type { InterceptionResult } from "./models.js";

function result(summary = "summary"): InterceptionResult {
  return {
    filePath: "/tmp/example.ts",
    fullLineCount: 10,
    wasIntercepted: true,
    excerpts: [{ startLine: 1, endLine: 2, content: "const answer = 42;" }],
    summary,
    totalLinesReturned: 2,
    contextSaved: 8,
    confidence: 4,
  };
}

const baseKey = {
  contentSha256: sha256("content"),
  question: "What matters?",
  model: { providerID: "openai", modelID: "gpt-test" },
  promptVersion: PROMPT_VERSION,
  chunkLines: 1000,
  chunkOverlapLines: 50,
  judgeMode: "always",
};

describe("LruResultCache", () => {
  it("returns an equal result after set", () => {
    const cache = new LruResultCache();
    const value = result();
    cache.set("one", value);
    deepStrictEqual(cache.get("one"), value);
  });

  it("evicts the least-recently-used entry by maxEntries", () => {
    const cache = new LruResultCache({ maxEntries: 2 });
    cache.set("one", result("one"));
    cache.set("two", result("two"));
    cache.set("three", result("three"));
    strictEqual(cache.get("one"), undefined);
    strictEqual(cache.get("two")?.summary, "two");
    strictEqual(cache.get("three")?.summary, "three");
  });

  it("refreshes an entry when read", () => {
    const cache = new LruResultCache({ maxEntries: 2 });
    cache.set("one", result("one"));
    cache.set("two", result("two"));
    cache.get("one");
    cache.set("three", result("three"));
    strictEqual(cache.get("one")?.summary, "one");
    strictEqual(cache.get("two"), undefined);
  });

  it("evicts by maxBytes and skips oversize values", () => {
    const first = result("first");
    const second = result("second");
    const cache = new LruResultCache({ maxBytes: JSON.stringify(second).length });
    cache.set("one", first);
    cache.set("two", second);
    strictEqual(cache.get("one"), undefined);
    strictEqual(cache.get("two")?.summary, "second");

    const tiny = new LruResultCache({ maxBytes: 1 });
    tiny.set("oversize", first);
    strictEqual(tiny.size, 0);
  });

  it("falls back to defaults for invalid bounds", () => {
    for (const maxEntries of [0, -1, Number.NaN, 1.5]) {
      const cache = new LruResultCache({ maxEntries });
      cache.set("value", result());
      strictEqual(cache.get("value")?.summary, "summary");
    }
    for (const maxBytes of [0, -1, Number.NaN]) {
      const cache = new LruResultCache({ maxBytes });
      cache.set("value", result());
      strictEqual(cache.get("value")?.summary, "summary");
    }
  });

  it("isolates values passed to set and returned from get", () => {
    const cache = new LruResultCache();
    const value = result();
    cache.set("value", value);
    value.excerpts.push({ startLine: 3, endLine: 3, content: "mutated input" });
    strictEqual(cache.get("value")?.excerpts.length, 1);

    const cached = cache.get("value");
    cached?.excerpts.push({ startLine: 4, endLine: 4, content: "mutated output" });
    strictEqual(cache.get("value")?.excerpts.length, 1);
  });
});

describe("cacheKey", () => {
  it("is stable and SHA-256 shaped", () => {
    const first = cacheKey(baseKey);
    strictEqual(first, cacheKey(baseKey));
    strictEqual(first.length, 64);
    strictEqual(/^[a-f0-9]{64}$/.test(first), true);
  });

  it("changes with every keyed dimension", () => {
    const original = cacheKey(baseKey);
    notStrictEqual(cacheKey({ ...baseKey, contentSha256: sha256("changed") }), original);
    notStrictEqual(cacheKey({ ...baseKey, question: "Changed question" }), original);
    notStrictEqual(cacheKey({ ...baseKey, model: { providerID: "other", modelID: "gpt-test" } }), original);
    notStrictEqual(cacheKey({ ...baseKey, promptVersion: "v2" }), original);
    notStrictEqual(cacheKey({ ...baseKey, chunkLines: 500 }), original);
    notStrictEqual(cacheKey({ ...baseKey, chunkOverlapLines: 0 }), original);
    notStrictEqual(cacheKey({ ...baseKey, judgeMode: "off" }), original);
  });

  it("normalizes omitted optional dimensions", () => {
    strictEqual(
      cacheKey({ contentSha256: "content", question: "question" }),
      cacheKey({
        contentSha256: "content",
        question: "question",
        model: undefined,
        chunkLines: 0,
        chunkOverlapLines: 0,
        judgeMode: "off",
      })
    );
  });

  it("keeps separator-like field values distinct", () => {
    const quotedQuestion = cacheKey({ contentSha256: "content", question: 'a","b' });
    const splitFields = cacheKey({
      contentSha256: "content",
      question: "a",
      model: { providerID: "b", modelID: "" },
    });
    notStrictEqual(quotedQuestion, splitFields);
  });
});
