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

export class ConcurrencyLimitedRunner implements SubagentRunner {
  readonly limit: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly runner: SubagentRunner, limit: number) {
    this.limit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  }

  async run(request: SubagentRequest): Promise<SubagentResult> {
    await this.acquire();
    try {
      return await Promise.resolve().then(() => this.runner.run(request));
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.active -= 1;
    }
  }
}

/** Serializes calls to a runner without allowing a failed call to poison later work. */
export class SerialRunner extends ConcurrencyLimitedRunner {
  constructor(runner: SubagentRunner) {
    super(runner, 1);
  }
}
