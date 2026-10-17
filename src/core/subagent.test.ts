import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  SubagentRequest,
  SubagentResult,
  SubagentRunner,
  ConcurrencyLimitedRunner,
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

describe("ConcurrencyLimitedRunner", () => {
  it("limits eight concurrent calls to three active inner runs", async () => {
    const tracking = new TrackingRunner();
    const runner = new ConcurrencyLimitedRunner(tracking, 3);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => runner.run(request(`call-${index}`)))
    );

    strictEqual(tracking.maxActive, 3);
    deepStrictEqual(results.map((result) => result.text), [
      "call-0", "call-1", "call-2", "call-3", "call-4", "call-5", "call-6", "call-7",
    ]);
  });

  it("starts limit-one calls in submission order", async () => {
    const tracking = new TrackingRunner();
    const runner = new ConcurrencyLimitedRunner(tracking, 1);
    await Promise.all([runner.run(request("one")), runner.run(request("two")), runner.run(request("three"))]);

    strictEqual(tracking.maxActive, 1);
    deepStrictEqual(tracking.calls, ["one", "two", "three"]);
  });

  it("releases a queued slot after a rejection", async () => {
    const tracking = new TrackingRunner();
    const runner = new ConcurrencyLimitedRunner(tracking, 1);
    const failed = runner.run(request("reject"));
    const next = runner.run(request("after"));

    await rejects(failed, /expected failure/);
    strictEqual((await next).text, "after");
    deepStrictEqual(tracking.calls, ["reject", "after"]);
  });

  it("releases a queued slot after a synchronous throw", async () => {
    const calls: string[] = [];
    const inner: SubagentRunner = {
      run(input) {
        calls.push(input.prompt);
        if (input.prompt === "throw") throw new Error("synchronous failure");
        return Promise.resolve({ text: input.prompt });
      },
    };
    const runner = new ConcurrencyLimitedRunner(inner, 1);
    const failed = runner.run(request("throw"));
    const next = runner.run(request("after"));

    await rejects(failed, /synchronous failure/);
    strictEqual((await next).text, "after");
    deepStrictEqual(calls, ["throw", "after"]);
  });

  it("clamps invalid and fractional limits", () => {
    const inner = new TrackingRunner();
    deepStrictEqual(
      [0, -2, Number.NaN, 2.7].map((limit) => new ConcurrencyLimitedRunner(inner, limit).limit),
      [1, 1, 1, 2]
    );
  });
});

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

  it("is a limit-one ConcurrencyLimitedRunner", () => {
    const runner = new SerialRunner(new TrackingRunner());
    strictEqual(runner instanceof ConcurrencyLimitedRunner, true);
    strictEqual(runner.limit, 1);
  });
});
