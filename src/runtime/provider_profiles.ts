import {
  defaultProviderConfigForId,
  loadRuntimeConfig,
  providerConfigSchema,
  providerTypeForId,
  type ProviderProfile,
  type RuntimeConfig
} from "./runtime_config.js";
import {
  getProviderApiKeySecret,
  loadPrivateRuntimeConfig,
  savePrivateRuntimeConfig,
  setProviderApiKeySecret,
  unsetProviderSecrets,
  updatePrivateRuntimeConfig
} from "./private_config.js";
import {
  missingProviderProfileHint as providerOnboardingMissingProviderProfileHint,
  validateProviderProfileAddOptions
} from "./provider_onboarding.js";
import type { PolicyConfig } from "./policy_manager.js";

export type ProviderProfileAddOptions = {
  providerId: string;
  oauth?: boolean;
  apiKey?: string;
  apiKeyEnv?: string;
  model?: string;
  baseUrl?: string;
};

export type ProviderProfileSummary = {
  name: string;
  providerId: string;
  active: boolean;
  authMode: string;
  model?: string;
  baseUrl?: string;
  secretStatus: "configured via env" | "configured via private secret" | "missing" | "not required";
};

export async function addProviderProfile(
  workspaceRoot: string,
  name: string,
  options: ProviderProfileAddOptions
): Promise<ProviderProfile> {
  assertProfileName(name);
  const normalizedOptions = validateProviderProfileAddOptions(name, options);
  const now = new Date().toISOString();
  const existing = (await loadRuntimeConfig(workspaceRoot)).config.model.providerProfiles[name];
  const auth = normalizedOptions.oauth
    ? { mode: "oauth" as const }
    : normalizedOptions.apiKeyEnv
      ? { mode: "env" as const, envName: normalizedOptions.apiKeyEnv }
      : { mode: "secret" as const, secretRef: `providers.${name}.apiKey` };
  const profile: ProviderProfile = {
    name,
    providerId: normalizedOptions.providerId,
    ...(normalizedOptions.model ? { model: normalizedOptions.model } : {}),
    ...(normalizedOptions.baseUrl ? { baseUrl: normalizedOptions.baseUrl } : {}),
    auth,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  await updatePrivateRuntimeConfig(workspaceRoot, {
    model: {
      providerProfiles: {
        [name]: profile
      }
    }
  });
  if (normalizedOptions.apiKey !== undefined) {
    await setProviderApiKeySecret(workspaceRoot, name, normalizedOptions.apiKey);
  }
  return profile;
}

export async function useProviderProfile(workspaceRoot: string, name: string): Promise<ProviderProfile> {
  const profile = await requireProviderProfile(workspaceRoot, name);
  await updatePrivateRuntimeConfig(workspaceRoot, {
    model: {
      activeProviderProfile: name
    }
  });
  return profile;
}

export async function removeProviderProfile(workspaceRoot: string, name: string): Promise<boolean> {
  const runtime = (await loadRuntimeConfig(workspaceRoot)).config;
  if (!runtime.model.providerProfiles[name]) {
    return false;
  }
  const providerProfiles = { ...runtime.model.providerProfiles };
  delete providerProfiles[name];
  const privateConfig = await loadPrivateRuntimeConfig(workspaceRoot);
  const { activeProviderProfile: _activeProviderProfile, ...privateModelWithoutActive } = privateConfig.model ?? {};
  await savePrivateRuntimeConfig(workspaceRoot, {
    ...privateConfig,
    model: {
      ...privateModelWithoutActive,
      ...(runtime.model.activeProviderProfile === name ? {} : { activeProviderProfile: runtime.model.activeProviderProfile }),
      providerProfiles
    }
  });
  await unsetProviderSecrets(workspaceRoot, name);
  return true;
}

export async function requireProviderProfile(workspaceRoot: string, name: string): Promise<ProviderProfile> {
  const runtime = (await loadRuntimeConfig(workspaceRoot)).config;
  const profile = runtime.model.providerProfiles[name];
  if (!profile) {
    throw new Error(`Provider profile not found: ${name}`);
  }
  return profile;
}

export async function listProviderProfileSummaries(workspaceRoot: string): Promise<ProviderProfileSummary[]> {
  const runtime = (await loadRuntimeConfig(workspaceRoot)).config;
  return Object.values(runtime.model.providerProfiles)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((profile) => summarizeProviderProfile(workspaceRoot, runtime, profile));
}

export function providerConfigForProfile(
  workspaceRoot: string,
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

export function providerApiKeyForProfile(workspaceRoot: string, profile: ProviderProfile): string | undefined {
  if (profile.auth.mode !== "secret") {
    return undefined;
  }
  return getProviderApiKeySecret(workspaceRoot, profile.name);
}

export function formatProviderProfileList(items: ProviderProfileSummary[]): string {
  if (!items.length) {
    return [
      "Provider profiles: none",
      "",
      "Guided setup:",
      "  cosia provider setup",
      "",
      "Scriptable setup:",
      "  cosia provider profile add codex --provider codex-cli --oauth",
      "  cosia provider profile add openrouter --provider openrouter --api-key --model <model-id>"
    ].join("\n");
  }
  return [
    "Provider profiles",
    "Name                 Provider             Active  Auth    Secret",
    ...items.map((item) => [
      item.name.padEnd(20),
      item.providerId.padEnd(20),
      String(item.active).padEnd(7),
      item.authMode.padEnd(7),
      item.secretStatus
    ].join("  "))
  ].join("\n");
}

export function formatProviderProfileShow(item: ProviderProfileSummary): string {
  return [
    `Provider profile: ${item.name}`,
    `Provider: ${item.providerId}`,
    `Active: ${item.active}`,
    `Auth: ${item.authMode}`,
    `Secret: ${item.secretStatus}`,
    item.model ? `Model: ${item.model}` : undefined,
    item.baseUrl ? `Base URL: ${item.baseUrl}` : undefined
  ].filter(Boolean).join("\n");
}

export function formatProviderProfileAdded(profile: ProviderProfile): string {
  return [
    `Provider profile added: ${profile.name}`,
    `Provider: ${profile.providerId}`,
    `Auth: ${profile.auth.mode}`,
    "Secret values were not printed."
  ].join("\n");
}

export function formatProviderProfileUsed(profile: ProviderProfile): string {
  return [
    `Active provider profile: ${profile.name}`,
    `Provider: ${profile.providerId}`
  ].join("\n");
}

export function missingProviderProfileHint(): string {
  return providerOnboardingMissingProviderProfileHint();
}

function summarizeProviderProfile(workspaceRoot: string, runtime: RuntimeConfig, profile: ProviderProfile): ProviderProfileSummary {
  return {
    name: profile.name,
    providerId: profile.providerId,
    active: runtime.model.activeProviderProfile === profile.name,
    authMode: profile.auth.mode,
    model: profile.model,
    baseUrl: profile.baseUrl,
    secretStatus: providerSecretStatus(workspaceRoot, profile)
  };
}

function providerSecretStatus(workspaceRoot: string, profile: ProviderProfile): ProviderProfileSummary["secretStatus"] {
  if (profile.auth.mode === "oauth") {
    return "not required";
  }
  if (profile.auth.mode === "env") {
    return process.env[profile.auth.envName] ? "configured via env" : "missing";
  }
  return getProviderApiKeySecret(workspaceRoot, profile.name) ? "configured via private secret" : "missing";
}

function assertProfileName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
    throw new Error("Provider profile name must use letters, numbers, dot, underscore, or dash.");
  }
}
