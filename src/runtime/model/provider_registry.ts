import type { ModelProvider } from "../types.js";
import { CodexCliProvider } from "./providers/codex_cli_provider.js";
import { MockProvider } from "./providers/mock_provider.js";

export function createProvider(id: string, workspaceRoot: string, timeoutMs?: number): ModelProvider {
  if (id === "codex" || id === "codex-cli") {
    return new CodexCliProvider({ workspaceRoot, timeoutMs });
  }
  if (id === "mock") {
    return new MockProvider();
  }
  throw new Error(`Unknown model provider: ${id}`);
}
