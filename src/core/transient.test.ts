import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { isTransientError } from "./transient.js";

const withCode = (message: string, code: string) =>
  Object.assign(new Error(message), { code });

describe("isTransientError", () => {
  const positives: Array<[string, unknown]> = [
    ["ECONNREFUSED code", withCode("x", "ECONNREFUSED")],
    ["ECONNRESET code", withCode("x", "ECONNRESET")],
    ["UND_ERR_SOCKET code", withCode("x", "UND_ERR_SOCKET")],
    ["cause-wrapped code", Object.assign(new Error("wrapped"), { cause: withCode("x", "ETIMEDOUT") })],
    ["fetch failed", new Error("fetch failed")],
    ["socket hang up", new Error("socket hang up")],
    ["Network error", new Error("Network error while calling model")],
    ["503 text", new Error("503 Service Unavailable")],
    ["bad gateway", new Error("Bad Gateway")],
    ["string input", "gateway timeout"],
  ];
  const negatives: Array<[string, unknown]> = [
    ["plain boom", new Error("boom")],
    ["TimeoutError name", Object.assign(new Error("fetch failed"), { name: "TimeoutError" })],
    ["spawn failed", new Error("subagent spawn failed: network down")],
    ["unknown code", withCode("x", "EACCES")],
    ["undefined", undefined],
    ["null", null],
  ];
  for (const [name, value] of positives) {
    it(`transient: ${name}`, () => strictEqual(isTransientError(value), true));
  }
  for (const [name, value] of negatives) {
    it(`not transient: ${name}`, () => strictEqual(isTransientError(value), false));
  }
});
