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
  agentContext: AgentContext;
  projectRoot?: string;
}

export interface FileExcerpt {
  startLine: number;
  endLine: number;
  content: string;
}

export interface InterceptionResult {
  filePath: string;
  fullLineCount: number;
  wasIntercepted: boolean;
  excerpts: FileExcerpt[];
  summary: string;
  totalLinesReturned: number;
  contextSaved: number; // percentage
  error?: string;
}

export interface CheapModelResponse {
  question: string;
  excerpts: FileExcerpt[];
  summary: string;
}
