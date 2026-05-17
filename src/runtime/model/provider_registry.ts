import type { ModelProvider } from "../types.js";
import { CodexCliProvider } from "./providers/codex_cli_provider.js";
import { MockProvider } from "./providers/mock_provider.js";

export function createProvider(id: string, workspaceRoot: string): ModelProvider {
  if (id === "codex" || id === "codex-cli") {
    return new CodexCliProvider({ workspaceRoot });
  }
  if (id === "mock") {
    return new MockProvider();
  }
  throw new Error(`Unknown model provider: ${id}`);
}
