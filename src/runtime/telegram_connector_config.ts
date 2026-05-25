import { loadRuntimeConfig, type RuntimeConfig } from "./runtime_config.js";
import {
  setTelegramBotTokenSecret,
  unsetTelegramBotTokenSecret,
  updatePrivateRuntimeConfig
} from "./private_config.js";
import type { TelegramTokenResolution } from "./telegram_gateway.js";
import {
  allowGatewayChat,
  clearGatewayMaster,
  gatewayAuthSummary,
  removeGatewayChat,
  setGatewayMaster,
  setGatewayRoleBinding,
  unsetGatewayRoleBinding
} from "./gateway_auth.js";

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
  await allowGatewayChat(workspaceRoot, "telegram", chatId);
  return (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
}

export async function removeTelegramChatId(workspaceRoot: string, chatId: string): Promise<RuntimeConfig["connectors"]["telegram"]> {
  await removeGatewayChat(workspaceRoot, "telegram", chatId);
  return (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
}

export async function addTelegramUserId(workspaceRoot: string, userId: string): Promise<RuntimeConfig["connectors"]["telegram"]> {
  const chatId = await singleTelegramAuthChatId(workspaceRoot);
  await setGatewayRoleBinding(workspaceRoot, "telegram", userId, "admin", chatId);
  return (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
}

export async function removeTelegramUserId(workspaceRoot: string, userId: string): Promise<RuntimeConfig["connectors"]["telegram"]> {
  const config = (await loadRuntimeConfig(workspaceRoot)).config;
  await Promise.all(config.gateway.authorization.roleBindings
    .filter((item) => item.connector === "telegram" && item.userId === userId)
    .map((item) => unsetGatewayRoleBinding(workspaceRoot, "telegram", userId, item.chatId)));
  return (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
}

export async function addTelegramMutationUserId(workspaceRoot: string, userId: string): Promise<RuntimeConfig["connectors"]["telegram"]> {
  await setGatewayMaster(workspaceRoot, "telegram", userId);
  return (await loadRuntimeConfig(workspaceRoot)).config.connectors.telegram;
}

export async function removeTelegramMutationUserId(workspaceRoot: string, userId: string): Promise<RuntimeConfig["connectors"]["telegram"]> {
  const config = (await loadRuntimeConfig(workspaceRoot)).config;
  if (config.gateway.authorization.masterUser?.connector === "telegram" && config.gateway.authorization.masterUser.userId === userId) {
    await clearGatewayMaster(workspaceRoot);
  }
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

export function formatTelegramConnectorList(
  config: RuntimeConfig["connectors"]["telegram"],
  tokenStatus: TelegramTokenResolution,
  auth?: ReturnType<typeof gatewayAuthSummary>
): string {
  return [
    "Telegram connector",
    `Enabled: ${config.enabled}`,
    auth ? `Authorized chats: ${auth.chatCount}` : `Allowed chat ids: ${config.allowedChatIds.length}`,
    auth ? `Master configured: ${auth.masterConfigured}` : `Mutation user ids: ${config.mutationUserIds.length}`,
    auth ? `Guest bindings: ${auth.guestBindings}` : undefined,
    auth ? `Admin bindings: ${auth.adminBindings}` : `Allowed user ids: ${config.allowedUserIds.length}`,
    auth?.legacyWarning ? `Warning: ${auth.legacyWarning}` : undefined,
    `Group mode: ${config.groupMode}`,
    `Token: ${tokenStatus.status}`,
    `Token env: ${config.tokenEnv}`,
    `Allow mutations: ${config.allowMutations}`,
    `Message chunk chars: ${config.messageChunkChars}`
  ].join("\n");
}

async function singleTelegramAuthChatId(workspaceRoot: string): Promise<string> {
  const config = (await loadRuntimeConfig(workspaceRoot)).config;
  const chats = config.gateway.authorization.chats.filter((item) => item.connector === "telegram");
  if (chats.length === 1) {
    return chats[0].chatId;
  }
  if (!chats.length) {
    throw new Error("No Telegram Gateway chat is authorized. Run `cosia gateway auth allow-chat telegram <chat-id>` first.");
  }
  throw new Error("Multiple Telegram chats are authorized. Use `cosia gateway auth set-role telegram <user-id> admin --chat-id <chat-id>`.");
}
