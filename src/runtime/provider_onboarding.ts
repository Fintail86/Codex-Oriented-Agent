import type { ProviderProfileAddOptions } from "./provider_profiles.js";

export type ProviderAuthMode = "oauth" | "secret" | "env";

export type OAuthSetupKind = "cosia_owned_token_sink" | "external_cli_delegation" | "cosia_owned_unimplemented";

export type ProviderOnboardingDescriptor = {
  providerId: string;
  displayName: string;
  defaultProfileName: string;
  authModes: ProviderAuthMode[];
  requiresModel: boolean;
  requiresBaseUrl: boolean;
  defaultApiKeyEnv?: string;
  defaultBaseUrl?: string;
  oauthSetupKind?: OAuthSetupKind;
  notes: string[];
};

export type ProviderOAuthStatus = {
  ok: boolean;
  mode: OAuthSetupKind;
  message: string;
  hint?: string;
};

export type ProviderOAuthHandler = {
  providerId: string;
  beginOAuthSetup(): ProviderOAuthStatus;
  checkOAuthStatus(): ProviderOAuthStatus;
  refreshOAuthIfSupported(): ProviderOAuthStatus;
  revokeOAuthIfSupported(): ProviderOAuthStatus;
};

export const supportedProviderDescriptors: ProviderOnboardingDescriptor[] = [
  {
    providerId: "openai-codex",
    displayName: "OpenAI Codex",
    defaultProfileName: "codex",
    authModes: ["oauth"],
    requiresModel: false,
    requiresBaseUrl: false,
    oauthSetupKind: "cosia_owned_token_sink",
    notes: [
      "First-class OpenAI Codex OAuth provider path for COSIA.",
      "Uses COSIA-owned OAuth token storage and direct provider calls instead of per-turn Codex app-server sessions.",
      "No OAuth token values are printed by COSIA."
    ]
  },
  {
    providerId: "codex-cli",
    displayName: "Codex CLI compatibility",
    defaultProfileName: "codex-cli",
    authModes: ["oauth"],
    requiresModel: false,
    requiresBaseUrl: false,
    oauthSetupKind: "external_cli_delegation",
    notes: [
      "Compatibility-only provider path.",
      "OAuth status is delegated to the installed Codex CLI compatibility path.",
      "COSIA does not read or store Codex CLI tokens."
    ]
  },
  {
    providerId: "openrouter",
    displayName: "OpenRouter",
    defaultProfileName: "openrouter",
    authModes: ["secret", "env"],
    requiresModel: true,
    requiresBaseUrl: false,
    defaultApiKeyEnv: "OPENROUTER_API_KEY",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    notes: [
      "Uses OpenAI-compatible chat completions.",
      "Requires a model id.",
      "API keys are stored only in private secrets or read from an explicit env var."
    ]
  },
  {
    providerId: "openai-compatible",
    displayName: "OpenAI-compatible endpoint",
    defaultProfileName: "openai",
    authModes: ["secret", "env"],
    requiresModel: true,
    requiresBaseUrl: true,
    defaultApiKeyEnv: "OPENAI_API_KEY",
    notes: [
      "Uses a user-provided OpenAI-compatible base URL.",
      "Requires a model id and base URL.",
      "API keys are stored only in private secrets or read from an explicit env var."
    ]
  }
];

export function listSupportedProviderDescriptors(): ProviderOnboardingDescriptor[] {
  return [...supportedProviderDescriptors];
}

export function requireProviderDescriptor(providerId: string): ProviderOnboardingDescriptor {
  const descriptor = supportedProviderDescriptors.find((item) => item.providerId === normalizeProviderId(providerId));
  if (!descriptor) {
    throw new Error([
      `Unsupported provider: ${providerId}`,
      "Run `cosia provider list-supported` to see supported provider setup paths."
    ].join("\n"));
  }
  return descriptor;
}

export function validateProviderProfileAddOptions(
  _name: string,
  options: ProviderProfileAddOptions
): ProviderProfileAddOptions {
  const descriptor = requireProviderDescriptor(options.providerId);
  const authMode = authModeFromOptions(options);
  if (!authMode) {
    throw new Error(`Choose one auth mode for ${descriptor.providerId}: ${formatAuthModes(descriptor.authModes)}.`);
  }
  if (!descriptor.authModes.includes(authMode)) {
    throw new Error(`${descriptor.providerId} does not support ${authMode} auth. Supported auth modes: ${formatAuthModes(descriptor.authModes)}.`);
  }
  if (descriptor.requiresModel && !options.model) {
    throw new Error(`${descriptor.providerId} provider setup requires --model <model-id>.`);
  }
  if (descriptor.requiresBaseUrl && !options.baseUrl) {
    throw new Error(`${descriptor.providerId} provider setup requires --base-url <url>.`);
  }
  if (authMode === "env") {
    if (!options.apiKeyEnv) {
      throw new Error(`${descriptor.providerId} env auth requires --api-key-env <ENV_NAME>.`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.apiKeyEnv)) {
      throw new Error("Environment variable name must start with a letter or underscore and contain only letters, numbers, or underscores.");
    }
  }
  if (authMode === "secret" && (options.apiKey === undefined || options.apiKey.trim() === "")) {
    throw new Error(`${descriptor.providerId} API key setup requires a non-empty API key.`);
  }
  if (authMode === "oauth" && descriptor.oauthSetupKind === "cosia_owned_unimplemented") {
    throw new Error(`${descriptor.providerId} COSIA-owned OAuth is not implemented yet.`);
  }
  if (descriptor.providerId === "openai-codex" && (options.baseUrl || options.apiKeyEnv || options.apiKey)) {
    throw new Error("openai-codex OAuth profiles do not accept base URL, API key, or env auth fields.");
  }
  if (descriptor.providerId === "codex-cli" && (options.model || options.baseUrl || options.apiKeyEnv || options.apiKey)) {
    throw new Error("codex-cli OAuth profiles do not accept model, base URL, API key, or env auth fields.");
  }
  return {
    ...options,
    providerId: descriptor.providerId
  };
}

export function authModeFromOptions(options: ProviderProfileAddOptions): ProviderAuthMode | undefined {
  const modes: ProviderAuthMode[] = [];
  if (options.oauth) modes.push("oauth");
  if (options.apiKey !== undefined) modes.push("secret");
  if (options.apiKeyEnv) modes.push("env");
  if (modes.length > 1) {
    throw new Error("Choose exactly one auth mode: --oauth, --api-key, or --api-key-env <ENV_NAME>.");
  }
  return modes[0];
}

export function formatSupportedProviders(descriptors: ProviderOnboardingDescriptor[] = supportedProviderDescriptors): string {
  return [
    "Supported provider setup paths",
    "Provider             Display name                  Auth modes       Required fields",
    ...descriptors.map((descriptor) => [
      descriptor.providerId.padEnd(20),
      descriptor.displayName.padEnd(29),
      descriptor.authModes.join(",").padEnd(16),
      requiredFields(descriptor)
    ].join("  ")),
    "",
    "No provider is selected by default.",
    "Guided setup:",
    "  cosia provider setup",
    "Scriptable setup:",
    "  cosia provider profile add <name> --provider <provider-id> ..."
  ].join("\n");
}

export function formatProviderSetupResult(args: {
  profileName: string;
  providerId: string;
  authMode: ProviderAuthMode;
  used: boolean;
}): string {
  return [
    `Provider profile configured: ${args.profileName}`,
    `Provider: ${args.providerId}`,
    `Auth: ${args.authMode}`,
    `Active: ${args.used}`,
    "Secret values were not printed.",
    args.used ? undefined : "Next: cosia provider profile use <name>"
  ].filter(Boolean).join("\n");
}

export function missingProviderProfileHint(): string {
  return [
    "Run guided setup:",
    "  cosia provider setup",
    "",
    "Or use a scriptable setup path:",
    "  cosia provider profile add codex --provider openai-codex --oauth",
    "  cosia provider oauth login codex",
    "  cosia provider profile add openrouter --provider openrouter --api-key --model <model-id>",
    "",
    "Then select it:",
    "  cosia provider profile use <name>"
  ].join("\n");
}

export function oauthHandlerForProvider(providerId: string): ProviderOAuthHandler | undefined {
  const descriptor = requireProviderDescriptor(providerId);
  if (!descriptor.authModes.includes("oauth")) {
    return undefined;
  }
  if (descriptor.oauthSetupKind === "cosia_owned_token_sink") {
    return {
      providerId: descriptor.providerId,
      beginOAuthSetup: () => ({
        ok: true,
        mode: "cosia_owned_token_sink",
        message: "OpenAI Codex OAuth is handled through COSIA-owned private token storage.",
        hint: "Run `cosia provider oauth login <profile>`."
      }),
      checkOAuthStatus: () => ({
        ok: true,
        mode: "cosia_owned_token_sink",
        message: "OAuth status is checked from COSIA private provider secrets."
      }),
      refreshOAuthIfSupported: () => ({
        ok: true,
        mode: "cosia_owned_token_sink",
        message: "Token refresh is handled by the openai-codex provider token sink."
      }),
      revokeOAuthIfSupported: () => ({
        ok: false,
        mode: "cosia_owned_token_sink",
        message: "OAuth revocation is not implemented yet. Remove the provider profile or secret to disconnect locally."
      })
    };
  }
  if (descriptor.oauthSetupKind === "external_cli_delegation") {
    return {
      providerId: descriptor.providerId,
      beginOAuthSetup: () => ({
        ok: true,
        mode: "external_cli_delegation",
        message: "OAuth setup is delegated to the provider's external CLI compatibility path.",
        hint: "For codex-cli, run `codex login` and then `cosia provider profile check <name>`."
      }),
      checkOAuthStatus: () => ({
        ok: true,
        mode: "external_cli_delegation",
        message: "OAuth status is checked by the provider implementation."
      }),
      refreshOAuthIfSupported: () => ({
        ok: false,
        mode: "external_cli_delegation",
        message: "OAuth refresh is not owned by COSIA for this provider."
      }),
      revokeOAuthIfSupported: () => ({
        ok: false,
        mode: "external_cli_delegation",
        message: "OAuth revocation is not owned by COSIA for this provider."
      })
    };
  }
  return {
    providerId: descriptor.providerId,
    beginOAuthSetup: () => ({
      ok: false,
      mode: "cosia_owned_unimplemented",
      message: "COSIA-owned OAuth setup is not implemented for this provider yet."
    }),
    checkOAuthStatus: () => ({
      ok: false,
      mode: "cosia_owned_unimplemented",
      message: "COSIA-owned OAuth status is not implemented for this provider yet."
    }),
    refreshOAuthIfSupported: () => ({
      ok: false,
      mode: "cosia_owned_unimplemented",
      message: "COSIA-owned OAuth refresh is not implemented for this provider yet."
    }),
    revokeOAuthIfSupported: () => ({
      ok: false,
      mode: "cosia_owned_unimplemented",
      message: "COSIA-owned OAuth revocation is not implemented for this provider yet."
    })
  };
}

function normalizeProviderId(providerId: string): string {
  return providerId === "codex" ? "openai-codex" : providerId;
}

function formatAuthModes(modes: ProviderAuthMode[]): string {
  return modes.map((mode) => mode === "secret" ? "api-key" : mode).join(", ");
}

function requiredFields(descriptor: ProviderOnboardingDescriptor): string {
  const fields = [];
  if (descriptor.requiresModel) fields.push("model");
  if (descriptor.requiresBaseUrl) fields.push("base-url");
  if (!fields.length) return "-";
  return fields.join(", ");
}
