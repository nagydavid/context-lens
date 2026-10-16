export interface SubagentRequest {
  prompt: string;
  schema?: Record<string, unknown>;
  timeoutMs: number;
  model?: {
    providerID: string;
    modelID: string;
  };
}

export interface SubagentResult {
  text?: string;
  structured?: unknown;
}

export interface SubagentRunner {
  run(request: SubagentRequest): Promise<SubagentResult>;
}

export const SUBAGENT_ANSWER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["excerpts", "summary", "confidence"],
  properties: {
    excerpts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["startLine", "endLine"],
        properties: {
          startLine: { type: "integer" },
          endLine: { type: "integer" },
          reason: { type: "string" },
        },
      },
    },
    summary: { type: "string" },
    confidence: { type: "integer", minimum: 1, maximum: 5 },
  },
};

/** Serializes calls to a runner without allowing a failed call to poison later work. */
export class SerialRunner implements SubagentRunner {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly runner: SubagentRunner) {}

  run(request: SubagentRequest): Promise<SubagentResult> {
    const call = this.tail.then(() => this.runner.run(request));
    this.tail = call.then(
      () => undefined,
      () => undefined
    );
    return call;
  }
}
