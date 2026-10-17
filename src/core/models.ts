// Type definitions for ContextLens

export interface AgentContext {
  goal?: string;
  instructions?: string;
  currentTask?: string;
  systemPrompt?: string;
}

export interface ReadRequest {
  filePath: string;
  startLine?: number;
  endLine?: number;
  question?: string;
  agentContext: AgentContext;
  projectRoot?: string;
}

export interface FileExcerpt {
  startLine: number;
  endLine: number;
  content: string;
  reason?: string;
}

export type FallbackReason =
  | "no-runner"
  | "subagent-error"
  | "timeout"
  | "invalid-response"
  | "invalid-confidence"
  | "no-valid-excerpts"
  | "file-not-found"
  | "file-too-large"
  | "binary-file"
  | "unreadable"
  | "network-error";

export interface InterceptionResult {
  filePath: string;
  fullLineCount: number;
  wasIntercepted: boolean;
  excerpts: FileExcerpt[];
  summary: string;
  totalLinesReturned: number;
  contextSaved: number;
  error?: string;
  confidence?: number;
  question?: string;
  questionSource?: "explicit" | "inferred";
  elapsedMs?: number;
  attempts?: number;
  chunks?: number;
  fallback?: { reason: FallbackReason; detail?: string };
}

export interface SubagentAnswer {
  excerpts: {
    startLine: number;
    endLine: number;
    reason?: string;
  }[];
  summary: string;
  confidence: number;
}

/** @deprecated Use SubagentAnswer. */
export type CheapModelResponse = SubagentAnswer;
