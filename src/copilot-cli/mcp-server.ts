// Copilot CLI MCP server for ContextLens
// Exposes bounded-read tools and handles file interception

import { interceptRead } from "../core/index.js";
import type { ReadRequest, InterceptionResult } from "../core/index.js";

export interface MCPBoundedReadParams {
  path: string;
  start_line?: number;
  end_line?: number;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
}

/**
 * List MCP tools exposed by ContextLens
 */
export function listTools(): MCPTool[] {
  return [
    {
      name: "bounded_read",
      description:
        "Read a source file with automatic interception for large files. Returns excerpts + line ranges + summary.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path to read",
          },
          start_line: {
            type: "number",
            description: "Optional: start line (1-indexed)",
          },
          end_line: {
            type: "number",
            description: "Optional: end line (1-indexed)",
          },
        },
        required: ["path"],
      },
    },
  ];
}

/**
 * Handle bounded_read tool call
 */
export async function handleBoundedRead(
  params: MCPBoundedReadParams
): Promise<InterceptionResult> {
  const request: ReadRequest = {
    filePath: params.path,
    startLine: params.start_line,
    endLine: params.end_line,
    agentContext: {
      goal: "Understand this file for code generation or analysis",
    },
  };

  return interceptRead(request);
}

/**
 * Format InterceptionResult for MCP response
 */
export function formatMCPResponse(result: InterceptionResult): string {
  if (result.error) {
    return `Error: ${result.error}`;
  }

  const lines = [
    `File: ${result.filePath}`,
    `Lines: ${result.fullLineCount} total${result.wasIntercepted ? ` (intercepted, returned ${result.totalLinesReturned}, ${result.contextSaved}% saved)` : ""}`,
    "",
  ];

  for (const excerpt of result.excerpts) {
    lines.push(`--- Lines ${excerpt.startLine}–${excerpt.endLine} ---`);
    lines.push(excerpt.content);
    lines.push("");
  }

  if (result.summary) {
    lines.push(`Summary: ${result.summary}`);
  }

  return lines.join("\n");
}
