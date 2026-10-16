import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { resolveQuestion } from "./question.js";

describe("resolveQuestion", () => {
  it("keeps an explicit question after trimming it", () => {
    const resolved = resolveQuestion("  Which export starts the server?  ", {});
    strictEqual(resolved.question, "Which export starts the server?");
    strictEqual(resolved.source, "explicit");
  });

  it("infers from current task before goal and instructions", () => {
    const resolved = resolveQuestion("   ", {
      currentTask: "  implement retries ",
      goal: "build a server",
      instructions: "inspect exports",
    });
    strictEqual(
      resolved.question,
      "What in this file is relevant to: implement retries"
    );
    strictEqual(resolved.source, "inferred");
  });

  it("uses goal and then the default for missing question and context", () => {
    strictEqual(
      resolveQuestion(undefined, { goal: "  understand parsing " }).question,
      "What in this file is relevant to: understand parsing"
    );
    strictEqual(
      resolveQuestion(undefined, {}).question,
      "What is the main purpose of this file and what are its key exports, types and entry points?"
    );
  });
});
