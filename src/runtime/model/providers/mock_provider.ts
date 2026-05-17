import { parseModelOutput } from "../model_provider.js";
import type { AuthStatus, ModelInput, ModelOutput, ModelProvider } from "../../types.js";

export class MockProvider implements ModelProvider {
  readonly id = "mock";

  async checkAuth(): Promise<AuthStatus> {
    return { ok: true, message: "Mock provider does not require authentication." };
  }

  async complete(input: ModelInput): Promise<ModelOutput> {
    const normalizedPrompt = input.prompt.toLowerCase();
    if (normalizedPrompt.includes("call read_file on a relevant path before returning final") && !input.prompt.includes("Tool: read_file")) {
      return parseModelOutput(JSON.stringify({
        type: "tool_call",
        tool: "read_file",
        args: { path: "codex/RULES.md" }
      }));
    }

    if (input.prompt.includes("Tool: read_file") || input.prompt.includes("Tool: search_files")) {
      return parseModelOutput(JSON.stringify({
        type: "final",
        content: `Mock response for ${input.sessionId}.`,
        memoryCandidates: input.prompt.includes("[MOCK_CANDIDATE]")
          ? [{
              scope: "project",
              kind: "note",
              content: "Mock candidate memory",
              importance: 3,
              confidence: 0.8
            }]
          : []
      }));
    }

    if (input.prompt.includes("# TOOL RESULTS") && !input.prompt.includes("Runtime rejection")) {
      return parseModelOutput(JSON.stringify({
        type: "final",
        content: `Mock response for ${input.sessionId}.`,
        memoryCandidates: input.prompt.includes("[MOCK_CANDIDATE]")
          ? [{
              scope: "project",
              kind: "note",
              content: "Mock candidate memory",
              importance: 3,
              confidence: 0.8
            }]
          : []
      }));
    }

    const writeOnly = input.prompt.match(/\[MOCK_WRITE_ONLY:([^\]]+)\]/);
    if (writeOnly && !input.prompt.includes("Runtime rejection")) {
      return parseModelOutput(JSON.stringify({
        type: "tool_call",
        tool: "write_file",
        args: { path: writeOnly[1], content: "mock write" }
      }));
    }

    const match = input.prompt.match(/\[MOCK_TOOL_CALL:([a-z_]+):([^\]]+)\]/);
    if (match && !input.prompt.includes("# TOOL RESULTS")) {
      const tool = match[1];
      const value = match[2];
      const raw = JSON.stringify({
        type: "tool_call",
        tool,
        args: tool === "search_files" ? { query: value } : { path: value }
      });
      return parseModelOutput(raw);
    }

    if (input.prompt.includes("require-tools mode") || input.prompt.includes("Runtime rejection")) {
      return parseModelOutput(JSON.stringify({
        type: "tool_call",
        tool: "search_files",
        args: { query: "COSIA" }
      }));
    }

    return parseModelOutput(JSON.stringify({
      type: "final",
      content: `Mock response for ${input.sessionId}.`,
      memoryCandidates: input.prompt.includes("[MOCK_CANDIDATE]")
        ? [{
            scope: "project",
            kind: "note",
            content: "Mock candidate memory",
            importance: 3,
            confidence: 0.8
          }]
        : []
    }));
  }
}
