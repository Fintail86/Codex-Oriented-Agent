import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir, readText, writeText } from "./fs_utils.js";
import {
  deepMerge,
  runtimePrivatePath,
  secretsPrivatePath,
  type PartialRuntimeConfig
} from "./runtime_config.js";

type JsonObject = Record<string, unknown>;

export type PrivateSecrets = {
  version: 1;
  providers: Record<string, { apiKey?: string }>;
  connectors: {
    telegram?: {
      botToken?: string;
    };
  };
};

export async function loadPrivateRuntimeConfig(workspaceRoot: string): Promise<PartialRuntimeConfig> {
  const path = runtimePrivatePath(workspaceRoot);
  if (!existsSync(path)) {
    return {};
  }
  return JSON.parse(await readText(path)) as PartialRuntimeConfig;
}

export async function updatePrivateRuntimeConfig(workspaceRoot: string, patch: PartialRuntimeConfig): Promise<PartialRuntimeConfig> {
  const next = deepMerge(await loadPrivateRuntimeConfig(workspaceRoot), patch) as PartialRuntimeConfig;
  await savePrivateRuntimeConfig(workspaceRoot, next);
  return next;
}

export async function savePrivateRuntimeConfig(workspaceRoot: string, value: PartialRuntimeConfig): Promise<void> {
  await ensureDirFor(runtimePrivatePath(workspaceRoot));
  await writeText(runtimePrivatePath(workspaceRoot), `${JSON.stringify(value, null, 2)}\n`);
}

export async function loadPrivateSecrets(workspaceRoot: string): Promise<PrivateSecrets> {
  const path = secretsPrivatePath(workspaceRoot);
  if (!existsSync(path)) {
    return emptySecrets();
  }
  return normalizeSecrets(JSON.parse(await readText(path)) as unknown);
}

export function loadPrivateSecretsSync(workspaceRoot: string): PrivateSecrets {
  const path = secretsPrivatePath(workspaceRoot);
  if (!existsSync(path)) {
    return emptySecrets();
  }
  return normalizeSecrets(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export async function savePrivateSecrets(workspaceRoot: string, secrets: PrivateSecrets): Promise<void> {
  await ensureDirFor(secretsPrivatePath(workspaceRoot));
  await writeText(secretsPrivatePath(workspaceRoot), `${JSON.stringify(normalizeSecrets(secrets), null, 2)}\n`);
}

export async function setProviderApiKeySecret(workspaceRoot: string, profileName: string, apiKey: string): Promise<void> {
  const secrets = await loadPrivateSecrets(workspaceRoot);
  secrets.providers[profileName] = {
    ...(secrets.providers[profileName] ?? {}),
    apiKey
  };
  await savePrivateSecrets(workspaceRoot, secrets);
}

export async function unsetProviderApiKeySecret(workspaceRoot: string, profileName: string): Promise<void> {
  const secrets = await loadPrivateSecrets(workspaceRoot);
  if (secrets.providers[profileName]) {
    delete secrets.providers[profileName].apiKey;
    if (!Object.keys(secrets.providers[profileName]).length) {
      delete secrets.providers[profileName];
    }
  }
  await savePrivateSecrets(workspaceRoot, secrets);
}

export function getProviderApiKeySecret(workspaceRoot: string, profileName: string): string | undefined {
  return loadPrivateSecretsSync(workspaceRoot).providers[profileName]?.apiKey;
}

export async function setTelegramBotTokenSecret(workspaceRoot: string, token: string): Promise<void> {
  const secrets = await loadPrivateSecrets(workspaceRoot);
  secrets.connectors.telegram = {
    ...(secrets.connectors.telegram ?? {}),
    botToken: token
  };
  await savePrivateSecrets(workspaceRoot, secrets);
}

export async function unsetTelegramBotTokenSecret(workspaceRoot: string): Promise<void> {
  const secrets = await loadPrivateSecrets(workspaceRoot);
  if (secrets.connectors.telegram) {
    delete secrets.connectors.telegram.botToken;
    if (!Object.keys(secrets.connectors.telegram).length) {
      delete secrets.connectors.telegram;
    }
  }
  await savePrivateSecrets(workspaceRoot, secrets);
}

export function getTelegramBotTokenSecret(workspaceRoot: string): string | undefined {
  return loadPrivateSecretsSync(workspaceRoot).connectors.telegram?.botToken;
}

function emptySecrets(): PrivateSecrets {
  return {
    version: 1,
    providers: {},
    connectors: {}
  };
}

function normalizeSecrets(raw: unknown): PrivateSecrets {
  const data = isObject(raw) ? raw : {};
  const providers = isObject(data.providers) ? data.providers : {};
  const connectors = isObject(data.connectors) ? data.connectors : {};
  const normalizedProviders: PrivateSecrets["providers"] = {};
  for (const [profileName, value] of Object.entries(providers)) {
    if (isObject(value) && typeof value.apiKey === "string") {
      normalizedProviders[profileName] = { apiKey: value.apiKey };
    }
  }
  const telegram = isObject(connectors.telegram) && typeof connectors.telegram.botToken === "string"
    ? { botToken: connectors.telegram.botToken }
    : undefined;
  return {
    version: 1,
    providers: normalizedProviders,
    connectors: {
      ...(telegram ? { telegram } : {})
    }
  };
}

async function ensureDirFor(path: string): Promise<void> {
  await ensureDir(dirname(path));
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
