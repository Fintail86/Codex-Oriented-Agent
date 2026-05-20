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

    if (input.prompt.match(/Tool: (read_file|search_files|git_status|git_diff|git_log|npm_test|npm_typecheck)/)) {
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

    const match = input.prompt.match(/\[MOCK_TOOL_CALL:([a-z_]+)(?::([^\]]+))?\]/);
    if (match && !input.prompt.includes("# TOOL RESULTS")) {
      const tool = match[1];
      const value = match[2] ?? "";
      const raw = JSON.stringify({
        type: "tool_call",
        tool,
        args: mockToolArgs(tool, value)
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

function mockToolArgs(tool: string, value: string): Record<string, unknown> {
  if (tool === "search_files") {
    return { query: value };
  }
  if (tool === "git_log") {
    return value ? { maxCount: Number.parseInt(value, 10) } : {};
  }
  if (tool === "git_diff") {
    return value ? { path: value } : {};
  }
  if (tool === "git_status" || tool === "npm_test" || tool === "npm_typecheck") {
    return {};
  }
  return { path: value };
}
