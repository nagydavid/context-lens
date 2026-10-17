#!/usr/bin/env node
import { createMcpServer, serveStdio } from "./mcp-server.js";
import { createCopilotRunner } from "./subagent.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportError(error: unknown): void {
  try { process.stderr.write(`[context-lens] error: ${errorMessage(error)}\n`); }
  catch { /* stderr is best effort */ }
}

process.on("unhandledRejection", reportError);
process.on("uncaughtException", reportError);
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") reportError(error);
});

const stop = (): void => {
  process.exitCode = 0;
  process.stdin.destroy();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

async function main(): Promise<void> {
  const server = createMcpServer({
    runner: createCopilotRunner(),
    cwd: process.cwd(),
    env: process.env,
  });
  process.stderr.write("[context-lens] info: mcp server ready\n");
  await serveStdio(server, { input: process.stdin, output: process.stdout, onError: reportError });
  process.exitCode = 0;
}

void main().catch((error) => {
  reportError(error);
  process.exitCode = 1;
});
