import {
  defaultProviderConfigForId,
  providerConfigSchema,
  providerTypeForId,
  type ProviderProfile
} from "./runtime_config.js";
import type { PolicyConfig } from "./policy_manager.js";

export function providerConfigForProfile(
  _workspaceRoot: string,
  policy: PolicyConfig,
  profile: ProviderProfile
): ReturnType<typeof providerConfigSchema.parse> {
  const template = policy.model.providers[profile.providerId]
    ?? defaultProviderConfigForId(profile.providerId);
  const base = providerConfigSchema.parse({
    ...template,
    type: template.type ?? providerTypeForId(profile.providerId),
    enabled: true
  });
  if (profile.providerId === "openai-codex" || base.type === "openai-codex") {
    return {
      ...base,
      enabled: true,
      type: "openai-codex",
      model: profile.model ?? base.model
    };
  }
  if (profile.providerId === "codex-cli" || base.type === "codex-cli") {
    return {
      ...base,
      enabled: true,
      type: "codex-cli"
    };
  }
  const apiKeyEnv = profile.auth.mode === "env"
    ? profile.auth.envName
    : base.apiKeyEnv;
  return {
    ...base,
    enabled: true,
    baseUrl: profile.baseUrl ?? base.baseUrl,
    model: profile.model ?? base.model,
    apiKeyEnv
  };
}
