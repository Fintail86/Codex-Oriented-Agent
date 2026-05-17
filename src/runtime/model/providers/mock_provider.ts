import { parseModelOutput } from "../model_provider.js";
import type { AuthStatus, ModelInput, ModelOutput, ModelProvider } from "../../types.js";

export class MockProvider implements ModelProvider {
  readonly id = "mock";

  async checkAuth(): Promise<AuthStatus> {
    return { ok: true, message: "Mock provider does not require authentication." };
  }

  async complete(input: ModelInput): Promise<ModelOutput> {
    const match = input.prompt.match(/\[MOCK_TOOL_CALL:([a-z_]+):([^\]]+)\]/);
    if (match) {
      const raw = JSON.stringify({
        type: "tool_call",
        tool: match[1],
        args: { path: match[2] }
      });
      return parseModelOutput(raw);
    }
    return parseModelOutput(JSON.stringify({
      type: "final",
      content: `Mock response for ${input.sessionId}.`,
      memoryCandidates: []
    }));
  }
}
