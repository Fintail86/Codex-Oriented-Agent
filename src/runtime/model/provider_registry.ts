import type { ModelProvider } from "../types.js";
import type { PolicyConfig } from "../policy_manager.js";
import { ProviderError, providerErrorFromUnknown, providerFailureHint } from "./provider_errors.js";
import { CodexCliProvider } from "./providers/codex_cli_provider.js";
import { MockProvider } from "./providers/mock_provider.js";
import { OpenAICompatibleProvider, type FetchLike } from "./providers/openai_compatible_provider.js";

export type ProviderCreateOptions = {
  policy?: PolicyConfig;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
};

export type ProviderCheckResult = {
  id: string;
  ok: boolean;
  message: string;
  reason?: string;
  hint?: string;
};

export type ProviderListItem = {
  id: string;
  enabled: boolean;
  isDefault: boolean;
  timeoutMs?: number;
  structuredRetryCount?: number;
  maxPromptChars?: number;
  modelConfigured?: boolean;
  baseUrlConfigured?: boolean;
  apiKeyEnv?: string;
  builtIn?: boolean;
};

export function createProvider(id: string, workspaceRoot: string, options: ProviderCreateOptions = {}): ModelProvider {
  const providerId = normalizeProviderId(id);
  if (providerId === "mock") {
    return new MockProvider();
  }
  const config = options.policy?.model.providers[providerId];
  if (!config) {
    if (!options.policy && providerId === "codex-cli") {
      return new CodexCliProvider({ workspaceRoot, timeoutMs: options.timeoutMs });
    }
    throw new ProviderError("unknown_provider", `Unknown model provider: ${id}`, {
      hint: providerFailureHint("unknown_provider", providerId)
    });
  }
  if (!config.enabled) {
    throw new ProviderError("disabled", `Provider ${providerId} is disabled.`, {
      hint: providerFailureHint("disabled", providerId)
    });
  }
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  if (providerId === "codex-cli") {
    return new CodexCliProvider({
      workspaceRoot,
      timeoutMs,
      sandbox: config.sandbox,
      structuredRetryCount: config.structuredRetryCount,
      maxPromptChars: config.maxPromptChars
    });
  }
  if (providerId === "openai-compatible") {
    return new OpenAICompatibleProvider({
      enabled: config.enabled,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKeyEnv: config.apiKeyEnv,
      endpointPath: config.endpointPath,
      timeoutMs,
      structuredRetryCount: config.structuredRetryCount,
      maxPromptChars: config.maxPromptChars,
      fetchImpl: options.fetchImpl
    });
  }
  throw new ProviderError("unknown_provider", `Unknown model provider: ${id}`, {
    hint: providerFailureHint("unknown_provider", providerId)
  });
}

export async function checkProvider(
  id: string,
  workspaceRoot: string,
  policy: PolicyConfig,
  options: Omit<ProviderCreateOptions, "policy"> = {}
): Promise<ProviderCheckResult> {
  const providerId = normalizeProviderId(id);
  try {
    const provider = createProvider(providerId, workspaceRoot, { ...options, policy });
    const status = await provider.checkAuth();
    return {
      id: provider.id,
      ok: status.ok,
      message: status.message,
      reason: status.reason,
      hint: status.hint
    };
  } catch (error) {
    const providerError = providerErrorFromUnknown(error, "unknown_provider");
    return {
      id: providerId,
      ok: false,
      message: providerError.message,
      reason: providerError.reason,
      hint: providerError.hint
    };
  }
}

export function listProviders(policy: PolicyConfig): ProviderListItem[] {
  const configured = Object.entries(policy.model.providers).map(([id, config]) => ({
    id,
    enabled: config.enabled,
    isDefault: id === policy.model.defaultProvider,
    timeoutMs: config.timeoutMs,
    structuredRetryCount: config.structuredRetryCount,
    maxPromptChars: config.maxPromptChars,
    modelConfigured: Boolean(config.model),
    baseUrlConfigured: Boolean(config.baseUrl),
    apiKeyEnv: config.apiKeyEnv
  }));
  return [
    ...configured,
    {
      id: "mock",
      enabled: true,
      isDefault: policy.model.defaultProvider === "mock",
      builtIn: true
    }
  ];
}

export function normalizeProviderId(id: string): string {
  return id === "codex" ? "codex-cli" : id;
}
