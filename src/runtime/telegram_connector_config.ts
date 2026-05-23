import { loadRuntimeConfig, type RuntimeConfig } from "./runtime_config.js";
import {
  setTelegramBotTokenSecret,
  unsetTelegramBotTokenSecret,
  updatePrivateRuntimeConfig
} from "./private_config.js";
import type { TelegramTokenResolution } from "./telegram_gateway.js";

export async function enableTelegramConnector(workspaceRoot: string, enabled: boolean): Promise<RuntimeConfig["connectors"]["telegram"]> {
  await updatePrivateRuntimeConfig(workspaceRoot, {
    connectors: {
      telegram: {
        enabled
      }
    }
  });
  return (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
}

export async function addTelegramChatId(workspaceRoot: string, chatId: string): Promise<RuntimeConfig["connectors"]["telegram"]> {
  const config = (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
  const allowedChatIds = Array.from(new Set([...config.allowedChatIds, chatId]));
  await updatePrivateRuntimeConfig(workspaceRoot, {
    connectors: {
      telegram: {
        allowedChatIds
      }
    }
  });
  return (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
}

export async function removeTelegramChatId(workspaceRoot: string, chatId: string): Promise<RuntimeConfig["connectors"]["telegram"]> {
  const config = (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
  await updatePrivateRuntimeConfig(workspaceRoot, {
    connectors: {
      telegram: {
        allowedChatIds: config.allowedChatIds.filter((item) => item !== chatId)
      }
    }
  });
  return (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
}

export async function setTelegramToken(workspaceRoot: string, token: string): Promise<void> {
  await setTelegramBotTokenSecret(workspaceRoot, token);
}

export async function unsetTelegramToken(workspaceRoot: string): Promise<void> {
  await unsetTelegramBotTokenSecret(workspaceRoot);
}

export async function setTelegramTokenEnv(workspaceRoot: string, tokenEnv: string): Promise<RuntimeConfig["connectors"]["telegram"]> {
  await updatePrivateRuntimeConfig(workspaceRoot, {
    connectors: {
      telegram: {
        tokenEnv
      }
    }
  });
  return (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
}

export async function unsetTelegramTokenEnv(workspaceRoot: string): Promise<RuntimeConfig["connectors"]["telegram"]> {
  await updatePrivateRuntimeConfig(workspaceRoot, {
    connectors: {
      telegram: {
        tokenEnv: "TELEGRAM_BOT_TOKEN"
      }
    }
  });
  return (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
}

export function formatTelegramConnectorList(config: RuntimeConfig["connectors"]["telegram"], tokenStatus: TelegramTokenResolution): string {
  return [
    "Telegram connector",
    `Enabled: ${config.enabled}`,
    `Allowed chat ids: ${config.allowedChatIds.length}`,
    `Token: ${tokenStatus.status}`,
    `Token env: ${config.tokenEnv}`,
    `Allow mutations: ${config.allowMutations}`,
    `Message chunk chars: ${config.messageChunkChars}`
  ].join("\n");
}
