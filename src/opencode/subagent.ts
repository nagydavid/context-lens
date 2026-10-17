import { ConcurrencyLimitedRunner } from "../core/subagent.js";
import type {
  SubagentRequest,
  SubagentResult,
  SubagentRunner,
} from "../core/subagent.js";

/** Minimal subset of the OpenCode SDK client used to run a child session. */
export interface OpenCodeSessionClient {
  session: {
    create(opts: {
      body: { title?: string; parentID?: string };
    }): Promise<unknown>;
    prompt(opts: {
      path: { id: string };
      body: Record<string, unknown>;
    }): Promise<unknown>;
    delete(opts: { path: { id: string } }): Promise<unknown>;
    abort?(opts: { path: { id: string } }): Promise<unknown>;
  };
}

const CLEANUP_TIMEOUT_MS = 1_000;

export interface SessionSubagentRunnerOptions {
  titlePrefix?: string;
  parentSessionID?: string;
  disableTools?: boolean;
  onSessionCreated?: (id: string) => void;
  onSessionClosed?: (id: string) => void;
}

export class SessionSubagentRunner implements SubagentRunner {
  private readonly titlePrefix: string;
  private readonly parentSessionID?: string;
  private readonly disableTools: boolean;
  private readonly onSessionCreated?: (id: string) => void;
  private readonly onSessionClosed?: (id: string) => void;

  constructor(
    private readonly client: OpenCodeSessionClient,
    opts: SessionSubagentRunnerOptions = {}
  ) {
    this.titlePrefix = opts.titlePrefix ?? "paradoc";
    this.parentSessionID = opts.parentSessionID;
    this.disableTools = opts.disableTools ?? true;
    this.onSessionCreated = opts.onSessionCreated;
    this.onSessionClosed = opts.onSessionClosed;
  }

  async run(request: SubagentRequest): Promise<SubagentResult> {
    let sessionID: string | undefined;
    try {
      let created: unknown;
      try {
        created = await this.client.session.create({
          body: {
            title: `${this.titlePrefix}: excerpt`,
            ...(this.parentSessionID ? { parentID: this.parentSessionID } : {}),
          },
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`subagent spawn failed: ${detail}`);
      }

      const createdRecord = asRecord(created);
      const envelopeID = asRecord(createdRecord?.data)?.id;
      sessionID = typeof envelopeID === "string"
        ? envelopeID
        : typeof createdRecord?.id === "string"
          ? createdRecord.id
          : undefined;
      if (!sessionID) {
        const detail = errorMessage(createdRecord?.error);
        throw new Error(`subagent spawn failed: ${detail ?? "session response contained no id"}`);
      }
      try {
        this.onSessionCreated?.(sessionID);
      } catch {
        // Lifecycle callbacks must not change runner behaviour.
      }

      // Body shape verified against @opencode-ai/sdk 1.19.3 (v2 OutputFormat); the v1 client passes it through.
      const body: Record<string, unknown> = {
        parts: [{ type: "text", text: request.prompt }],
        ...(request.model ? { model: request.model } : {}),
        ...(request.schema
          ? { format: { type: "json_schema", schema: request.schema, retryCount: 1 } }
          : {}),
        ...(this.disableTools ? { tools: { "*": false } } : {}),
      };
      const response = await this.promptWithTimeout(sessionID, body, request.timeoutMs);
      return this.extractResult(response);
    } finally {
      if (sessionID) {
        await this.deleteWithTimeout(sessionID);
        try {
          this.onSessionClosed?.(sessionID);
        } catch {
          // Lifecycle callbacks must not change runner behaviour.
        }
      }
    }
  }

  private async promptWithTimeout(
    sessionID: string,
    body: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.client.session.prompt({ path: { id: sessionID }, body }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void this.abort(sessionID);
            const error = new Error(`Subagent timed out after ${timeoutMs}ms.`);
            error.name = "TimeoutError";
            reject(error);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async abort(sessionID: string): Promise<void> {
    try {
      await this.client.session.abort?.({ path: { id: sessionID } });
    } catch {
      // Timeout remains authoritative when abort itself fails.
    }
  }

  private async deleteWithTimeout(sessionID: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.client.session.delete({ path: { id: sessionID } }),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, CLEANUP_TIMEOUT_MS); }),
      ]);
    } catch {
      // Cleanup must not replace prompt or parsing failures.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private extractResult(response: unknown): SubagentResult {
    const envelope = asRecord(response);
    const data = asRecord(envelope?.data) ?? envelope;
    const info = asRecord(data?.info) ?? data;
    if (!info) return {};

    if (envelope?.data === undefined) {
      const topError = errorMessage(envelope?.error);
      if (topError !== undefined) throw new Error(topError);
    }
    const error = asRecord(info.error);
    if (error) throw new Error(errorMessage(error) ?? "subagent prompt failed");

    const rawParts = Array.isArray(data?.parts) ? data.parts : info.parts;
    const parts = Array.isArray(rawParts) ? rawParts : [];
    const text = parts
      .filter((part) => asRecord(part)?.type === "text")
      .map((part) => asRecord(part)?.text)
      .filter((value): value is string => typeof value === "string")
      .join("");
    const structured = info.structured ?? info.structured_output ?? info.structuredOutput;
    return {
      ...(structured !== undefined ? { structured } : {}),
      ...(text ? { text } : {}),
    };
  }
}

function errorMessage(value: unknown): string | undefined {
  const error = asRecord(value);
  if (!error) return undefined;
  const message = error.message ?? asRecord(error.data)?.message ?? error.name;
  return String(message ?? "subagent prompt failed");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

export function createOpenCodeRunner(
  client: OpenCodeSessionClient,
  opts: SessionSubagentRunnerOptions & { concurrency?: number } = {}
): SubagentRunner {
  const { concurrency, ...sessionOptions } = opts;
  return new ConcurrencyLimitedRunner(
    new SessionSubagentRunner(client, sessionOptions),
    concurrency ?? 1,
  );
}
