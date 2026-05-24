import type { ModelProvider } from "../types.js";
import type { PolicyConfig } from "../policy_manager.js";
import {
  missingProviderProfileHint,
  providerApiKeyForProfile,
  providerConfigForProfile
} from "../provider_profiles.js";
import { providerTypeForId } from "../runtime_config.js";
import { ProviderError, providerErrorFromUnknown, providerFailureHint } from "./provider_errors.js";
import { CodexCliProvider } from "./providers/codex_cli_provider.js";
import { MockProvider } from "./providers/mock_provider.js";
import { OpenAICodexProvider } from "./providers/openai_codex_provider.js";
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
  type?: string;
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
  const profile = options.policy?.model.providerProfiles[id];
  const providerId = profile ? profile.providerId : normalizeProviderId(id);
  if (providerId === "mock") {
    return new MockProvider();
  }
  const config = profile
    ? providerConfigForProfile(workspaceRoot, options.policy!, profile)
    : options.policy?.model.providers[providerId];
  if (!config) {
    throw new ProviderError("unknown_provider", `Unknown model provider: ${id}`, {
      hint: options.policy ? missingProviderProfileHint() : providerFailureHint("unknown_provider", providerId)
    });
  }
  if (!config.enabled) {
    throw new ProviderError("disabled", `Provider ${providerId} is disabled.`, {
      hint: providerFailureHint("disabled", providerId)
    });
  }
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  const providerType = config.type ?? providerTypeForId(providerId);
  if (providerType === "codex-cli") {
    return new CodexCliProvider({
      id: profile?.name ?? providerId,
      workspaceRoot,
      timeoutMs,
      sandbox: config.sandbox,
      structuredRetryCount: config.structuredRetryCount,
      maxPromptChars: config.maxPromptChars
    });
  }
  if (providerType === "openai-codex") {
    return new OpenAICodexProvider({
      id: profile?.name ?? providerId,
      workspaceRoot,
      model: profile?.model ?? config.model,
      timeoutMs,
      structuredRetryCount: config.structuredRetryCount,
      maxPromptChars: config.maxPromptChars
    });
  }
  if (providerType === "openai-compatible") {
    const secretApiKey = profile ? providerApiKeyForProfile(workspaceRoot, profile) : undefined;
    return new OpenAICompatibleProvider({
      id: profile?.name ?? providerId,
      enabled: config.enabled,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKeyEnv: config.apiKeyEnv,
      apiKey: secretApiKey,
      apiKeyLabel: profile?.auth.mode === "secret" ? `private secret for provider profile ${profile.name}` : undefined,
      endpointPath: config.endpointPath,
      timeoutMs,
      structuredRetryCount: config.structuredRetryCount,
      maxPromptChars: config.maxPromptChars,
      responseFormat: config.responseFormat,
      extraHeaders: config.extraHeaders,
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
  try {
    const provider = createProvider(id, workspaceRoot, { ...options, policy });
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
      id,
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
    type: config.type,
    enabled: config.enabled,
    isDefault: false,
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
      isDefault: policy.model.activeProviderProfile === "mock",
      builtIn: true
    }
  ];
}

export function resolveProviderSelection(policy: PolicyConfig, requested?: string): string {
  if (requested && requested !== "default") {
    return requested;
  }
  if (policy.model.activeProviderProfile) {
    return policy.model.activeProviderProfile;
  }
  throw new ProviderError("missing_config", "No active provider profile is configured.", {
    hint: missingProviderProfileHint()
  });
}

export function normalizeProviderId(id: string): string {
  return id === "codex" ? "openai-codex" : id;
}
