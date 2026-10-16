import {
  SubagentRequest,
  SubagentResult,
  SubagentRunner,
} from "./subagent.js";

export type FakeSubagentHandler = (
  request: SubagentRequest
) => SubagentResult | Promise<SubagentResult>;

/** Deterministic runner for fixtures and integration tests. */
export class FakeSubagentRunner implements SubagentRunner {
  readonly calls: SubagentRequest[] = [];

  constructor(
    private readonly response: FakeSubagentHandler | SubagentResult,
    private readonly delayMs = 0
  ) {}

  async run(request: SubagentRequest): Promise<SubagentResult> {
    this.calls.push(request);
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    }
    return typeof this.response === "function"
      ? this.response(request)
      : this.response;
  }
}
