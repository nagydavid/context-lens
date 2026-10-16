import { rejects, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  SubagentRequest,
  SubagentResult,
  SubagentRunner,
  SerialRunner,
} from "./subagent.js";

const request = (prompt: string): SubagentRequest => ({ prompt, timeoutMs: 50 });

class TrackingRunner implements SubagentRunner {
  active = 0;
  maxActive = 0;
  calls: string[] = [];

  async run(input: SubagentRequest): Promise<SubagentResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.calls.push(input.prompt);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    this.active -= 1;
    if (input.prompt === "reject") throw new Error("expected failure");
    return { text: input.prompt };
  }
}

describe("SerialRunner", () => {
  it("never overlaps concurrent calls", async () => {
    const tracking = new TrackingRunner();
    const runner = new SerialRunner(tracking);
    const results = await Promise.all([runner.run(request("one")), runner.run(request("two"))]);

    strictEqual(tracking.maxActive, 1);
    strictEqual(results[0].text, "one");
    strictEqual(results[1].text, "two");
  });

  it("continues after a rejected call", async () => {
    const tracking = new TrackingRunner();
    const runner = new SerialRunner(tracking);
    const failed = runner.run(request("reject"));
    const next = runner.run(request("after"));

    await rejects(failed, /expected failure/);
    strictEqual((await next).text, "after");
    strictEqual(tracking.maxActive, 1);
  });
});
