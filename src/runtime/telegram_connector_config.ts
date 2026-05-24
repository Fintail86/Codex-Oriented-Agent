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

export async function addTelegramUserId(workspaceRoot: string, userId: string): Promise<RuntimeConfig["connectors"]["telegram"]> {
  const config = (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
  const allowedUserIds = Array.from(new Set([...config.allowedUserIds, userId]));
  await updatePrivateRuntimeConfig(workspaceRoot, {
    connectors: {
      telegram: {
        allowedUserIds
      }
    }
  });
  return (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
}

export async function removeTelegramUserId(workspaceRoot: string, userId: string): Promise<RuntimeConfig["connectors"]["telegram"]> {
  const config = (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
  await updatePrivateRuntimeConfig(workspaceRoot, {
    connectors: {
      telegram: {
        allowedUserIds: config.allowedUserIds.filter((item) => item !== userId)
      }
    }
  });
  return (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
}

export async function addTelegramMutationUserId(workspaceRoot: string, userId: string): Promise<RuntimeConfig["connectors"]["telegram"]> {
  const config = (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
  const mutationUserIds = Array.from(new Set([...config.mutationUserIds, userId]));
  await updatePrivateRuntimeConfig(workspaceRoot, {
    connectors: {
      telegram: {
        mutationUserIds
      }
    }
  });
  return (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
}

export async function removeTelegramMutationUserId(workspaceRoot: string, userId: string): Promise<RuntimeConfig["connectors"]["telegram"]> {
  const config = (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
  await updatePrivateRuntimeConfig(workspaceRoot, {
    connectors: {
      telegram: {
        mutationUserIds: config.mutationUserIds.filter((item) => item !== userId)
      }
    }
  });
  return (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
}

export async function setTelegramGroupMode(workspaceRoot: string, groupMode: "read_only" | "allowed_users"): Promise<RuntimeConfig["connectors"]["telegram"]> {
  await updatePrivateRuntimeConfig(workspaceRoot, {
    connectors: {
      telegram: {
        groupMode
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
    `Allowed user ids: ${config.allowedUserIds.length}`,
    `Mutation user ids: ${config.mutationUserIds.length}`,
    `Group mode: ${config.groupMode}`,
    `Token: ${tokenStatus.status}`,
    `Token env: ${config.tokenEnv}`,
    `Allow mutations: ${config.allowMutations}`,
    `Message chunk chars: ${config.messageChunkChars}`
  ].join("\n");
}
