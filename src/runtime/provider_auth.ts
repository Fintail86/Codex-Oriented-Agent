import {
  getProviderApiKeySecret,
  getProviderOAuthSecret
} from "./private_config.js";
import type { ProviderProfile } from "./runtime_config.js";
import type { ProviderProfileSummary } from "./provider_profiles.js";

export type ProviderSecretStatus = ProviderProfileSummary["secretStatus"];

export function providerApiKeyForProfile(workspaceRoot: string, profile: ProviderProfile): string | undefined {
  if (profile.auth.mode !== "secret") {
    return undefined;
  }
  return getProviderApiKeySecret(workspaceRoot, profile.name);
}

export function providerSecretStatus(workspaceRoot: string, profile: ProviderProfile): ProviderSecretStatus {
  if (profile.auth.mode === "oauth") {
    if (profile.providerId === "openai-codex") {
      return getProviderOAuthSecret(workspaceRoot, profile.name)?.accessToken
        ? "configured via private secret"
        : "missing";
    }
    return "not required";
  }
  if (profile.auth.mode === "env") {
    return process.env[profile.auth.envName] ? "configured via env" : "missing";
  }
  return getProviderApiKeySecret(workspaceRoot, profile.name) ? "configured via private secret" : "missing";
}

export function redactProviderAuthText(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_API_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/\b\d{8,10}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TELEGRAM_TOKEN]")
    .replace(/\b(access|refresh)_token=[^&\s]+/gi, "$1_token=[REDACTED]")
    .replace(/\b(code|auth_code)=([^&\s]+)/gi, "$1=[REDACTED]");
}
