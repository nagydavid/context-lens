import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  AgentContext,
  ReadRequest,
  InterceptionResult,
  CheapModelResponse,
} from "./models.js";
import { buildCheapModelPrompt } from "./prompts.js";

const THRESHOLD_LINES = 350;
const CHEAP_MODEL = "claude-haiku-4-5";

export class ReadInterceptor {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  async intercept(request: ReadRequest): Promise<InterceptionResult> {
    const { filePath, agentContext, projectRoot } = request;

    try {
      const resolvedPath = this.resolvePath(filePath, projectRoot);
      const fileContent = readFileSync(resolvedPath, "utf-8");
      const lines = fileContent.split("\n");
      const lineCount = lines.length;

      const result: InterceptionResult = {
        filePath,
        fullLineCount: lineCount,
        wasIntercepted: false,
        excerpts: [],
        summary: "",
        totalLinesReturned: 0,
        contextSaved: 0,
      };

      // No interception for small files
      if (lineCount <= THRESHOLD_LINES) {
        result.wasIntercepted = false;
        result.excerpts = [
          {
            startLine: 1,
            endLine: lineCount,
            content: fileContent,
          },
        ];
        result.totalLinesReturned = lineCount;
        result.contextSaved = 0;
        return result;
      }

      // Large file: call cheap model
      result.wasIntercepted = true;
      const cheapResponse = await this.callCheapModel(
        filePath,
        fileContent,
        agentContext
      );

      // Extract excerpts from cheap model response
      const excerpts = this.extractExcerpts(lines, cheapResponse);
      result.excerpts = excerpts;
      result.summary = cheapResponse.summary;
      result.totalLinesReturned = excerpts.reduce(
        (sum, e) => sum + (e.endLine - e.startLine + 1),
        0
      );
      result.contextSaved = Math.round(
        ((lineCount - result.totalLinesReturned) / lineCount) * 100
      );

      return result;
    } catch (error) {
      return {
        filePath,
        fullLineCount: 0,
        wasIntercepted: false,
        excerpts: [],
        summary: "",
        totalLinesReturned: 0,
        contextSaved: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resolvePath(filePath: string, projectRoot?: string): string {
    const base = projectRoot || process.cwd();
    return resolve(base, filePath);
  }

  private async callCheapModel(
    filePath: string,
    fileContent: string,
    agentContext: AgentContext
  ): Promise<CheapModelResponse> {
    const prompt = buildCheapModelPrompt(filePath, fileContent, agentContext);

    const message = await this.client.messages.create({
      model: CHEAP_MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const responseText =
      message.content[0].type === "text" ? message.content[0].text : "";

    // Parse JSON from response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Cheap model did not return valid JSON");
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      question: "", // Inferred implicitly, not returned by cheap model
      excerpts: parsed.excerpts || [],
      summary: parsed.summary || "",
    };
  }

  private extractExcerpts(
    lines: string[],
    response: CheapModelResponse
  ): { startLine: number; endLine: number; content: string }[] {
    return response.excerpts.map(({ startLine, endLine }) => {
      const start = Math.max(1, startLine);
      const end = Math.min(lines.length, endLine);
      const content = lines.slice(start - 1, end).join("\n");

      return { startLine: start, endLine: end, content };
    });
  }
}

export async function interceptRead(
  request: ReadRequest
): Promise<InterceptionResult> {
  const interceptor = new ReadInterceptor();
  return interceptor.intercept(request);
}
