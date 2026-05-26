import { loadPrivateRuntimeConfig, savePrivateRuntimeConfig } from "./private_config.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./runtime_config.js";
import type { PolicyConfig } from "./policy_manager.js";
import type { GatewayActor, GatewayRole } from "./gateway_auth_types.js";
import {
  gatewayMinimumRoleForInput as registryMinimumRoleForInput,
  isGatewayMutationCommand,
  isGatewayReadOnlyCommand
} from "./gateway_command_registry.js";
import { gatewayConnectorDescriptorFor } from "./gateway_connector_descriptor.js";

export type GatewayAuthDecision = {
  allowed: boolean;
  role?: GatewayRole;
  requiredRole?: GatewayRole;
  chatAllowed: boolean;
  reason:
    | "whoami"
    | "allowed"
    | "chat_not_allowed"
    | "missing_user_id"
    | "unknown_user"
    | "insufficient_role"
    | "mutations_disabled";
};

export type GatewayAuthSummary = {
  chatCount: number;
  masterConfigured: boolean;
  guestBindings: number;
  adminBindings: number;
  legacyWarning?: string;
};

const roleRank: Record<GatewayRole, number> = {
  guest: 1,
  admin: 2,
  master: 3
};

const blockNoticeCache = new Map<string, number>();

export function gatewayRoleAtLeast(role: GatewayRole, minimum: GatewayRole): boolean {
  return roleRank[role] >= roleRank[minimum];
}

export function gatewayAuthSummary(policyOrConfig: PolicyConfig | RuntimeConfig): GatewayAuthSummary {
  const auth = policyOrConfig.gateway.authorization;
  const telegram = policyOrConfig.connectors.telegram;
  const legacyWarning = telegram.allowedUserIds.length || telegram.mutationUserIds.length || telegram.allowedChatIds.length
    ? "Legacy Telegram auth fields are present; canonical Gateway auth is preferred."
    : undefined;
  return {
    chatCount: auth.chats.length,
    masterConfigured: Boolean(auth.masterUser),
    guestBindings: auth.roleBindings.filter((item) => item.role === "guest").length,
    adminBindings: auth.roleBindings.filter((item) => item.role === "admin").length,
    legacyWarning
  };
}

export function resolveGatewayRole(policyOrConfig: PolicyConfig | RuntimeConfig, actor: GatewayActor): GatewayAuthDecision {
  if (!isGatewayChatAllowed(policyOrConfig, actor.connector, actor.chatId)) {
    return { allowed: false, chatAllowed: false, reason: "chat_not_allowed" };
  }
  const auth = policyOrConfig.gateway.authorization;
  const legacyTelegram = policyOrConfig.connectors.telegram;
  if (!actor.userId) {
    return { allowed: false, chatAllowed: true, reason: "missing_user_id" };
  }
  const legacyMasterUser = actor.connector === "telegram" && legacyTelegram.mutationUserIds.length === 1
    ? legacyTelegram.mutationUserIds[0]
    : undefined;
  if (
    (auth.masterUser?.connector === actor.connector && auth.masterUser.userId === actor.userId)
    || legacyMasterUser === actor.userId
  ) {
    return {
      allowed: true,
      role: "master",
      chatAllowed: true,
      reason: "allowed"
    };
  }
  const binding = auth.roleBindings.find((item) =>
    item.connector === actor.connector
    && item.chatId === actor.chatId
    && item.userId === actor.userId
  );
  const legacyAdmin = actor.connector === "telegram" && legacyTelegram.allowedUserIds.includes(actor.userId);
  if (!binding) {
    if (legacyAdmin) {
      return {
        allowed: true,
        role: "admin",
        chatAllowed: true,
        reason: "allowed"
      };
    }
    return { allowed: false, chatAllowed: true, reason: "unknown_user" };
  }
  return {
    allowed: true,
    role: binding.role,
    chatAllowed: true,
    reason: "allowed"
  };
}

export function authorizeGatewayInput(policy: PolicyConfig, actor: GatewayActor, input: string): GatewayAuthDecision {
  if (isWhoamiInput(input)) {
    return { allowed: true, chatAllowed: true, reason: "whoami" };
  }
  return authorizeGatewayAccess(policy, actor, gatewayMinimumRoleForInput(input), isGatewayMutationInput(input));
}

export function authorizeGatewayAccess(
  policy: PolicyConfig,
  actor: GatewayActor,
  requiredRole: GatewayRole,
  mutation: boolean
): GatewayAuthDecision {
  const roleDecision = resolveGatewayRole(policy, actor);
  if (!roleDecision.allowed || !roleDecision.role) {
    return roleDecision;
  }
  if (!gatewayRoleAtLeast(roleDecision.role, requiredRole)) {
    return {
      allowed: false,
      role: roleDecision.role,
      requiredRole,
      chatAllowed: true,
      reason: "insufficient_role"
    };
  }
  if (mutation && !policy.connectors.telegram.allowMutations) {
    return {
      allowed: false,
      role: roleDecision.role,
      requiredRole,
      chatAllowed: true,
      reason: "mutations_disabled"
    };
  }
  return {
    allowed: true,
    role: roleDecision.role,
    requiredRole,
    chatAllowed: true,
    reason: "allowed"
  };
}

export function gatewayMinimumRoleForInput(input: string): GatewayRole {
  return registryMinimumRoleForInput(input);
}

export function isGatewayMutationInput(input: string): boolean {
  return isGatewayMutationCommand(input);
}

export function isAdminReadOnlySlashCommand(input: string): boolean {
  return isGatewayReadOnlyCommand(input) && gatewayMinimumRoleForInput(input) === "admin";
}

export function isWhoamiInput(input: string): boolean {
  return input.trim().toLowerCase() === "/whoami";
}

export function shouldSendGatewayBlockNotice(
  actor: GatewayActor,
  reason: string,
  throttleMs = 300000,
  now = Date.now()
): boolean {
  const key = [
    actor.connector,
    actor.chatId ?? "unknown-chat",
    actor.userId ?? "unknown-user",
    reason
  ].join(":");
  const last = blockNoticeCache.get(key) ?? 0;
  if (now - last < throttleMs) {
    return false;
  }
  blockNoticeCache.set(key, now);
  return true;
}

export function formatGatewayAuthBlocked(actor: GatewayActor, decision: GatewayAuthDecision): string {
  const lines = [
    "[BLOCKED] COSIA Gateway authorization gate.",
    formatGatewayAuthReason(decision),
    `Connector: ${actor.connector}`,
    `Chat id: ${actor.chatId ?? "unknown"}`,
    `Chat type: ${actor.chatType ?? "unknown"}`,
    `User id: ${actor.userId ?? "unknown"}`,
    decision.role ? `Role: ${decision.role}` : undefined,
    decision.requiredRole ? `Required role: ${decision.requiredRole}` : undefined,
    "",
    "Use /whoami to confirm chat/user ids.",
    "",
    "Ask the COSIA master to register this chat/user when access is intended.",
    "Local bootstrap commands:",
    ...gatewayConnectorDescriptorFor(actor.connector).formatBootstrapHints(actor)
  ].filter(Boolean);
  return lines.join("\n");
}

export function formatGatewayWhoami(actor: GatewayActor): string {
  const chatId = actor.chatId ?? "unknown";
  const userId = actor.userId ?? "unknown";
  return [
    "Gateway identity",
    `Connector: ${actor.connector}`,
    `Chat id: ${chatId}`,
    `Chat type: ${actor.chatType ?? "private"}`,
    `User id: ${userId}`,
    actor.username ? `Username: @${actor.username}` : undefined,
    actor.displayName ? `Name: ${actor.displayName}` : undefined,
    "",
    "Canonical local bootstrap:",
    ...gatewayConnectorDescriptorFor(actor.connector).formatBootstrapHints(actor)
  ].filter(Boolean).join("\n");
}

export async function allowGatewayChat(workspaceRoot: string, connector: string, chatId: string, label?: string): Promise<RuntimeConfig["gateway"]["authorization"]> {
  const config = (await loadRuntimeConfig(workspaceRoot)).config;
  const chats = upsertBy(config.gateway.authorization.chats, { connector, chatId, ...(label ? { label } : {}) }, (item) => `${item.connector}:${item.chatId}`);
  return saveAuthorization(workspaceRoot, { ...config.gateway.authorization, chats });
}

export async function removeGatewayChat(workspaceRoot: string, connector: string, chatId: string): Promise<RuntimeConfig["gateway"]["authorization"]> {
  const config = (await loadRuntimeConfig(workspaceRoot)).config;
  return saveAuthorization(workspaceRoot, {
    ...config.gateway.authorization,
    chats: config.gateway.authorization.chats.filter((item) => !(item.connector === connector && item.chatId === chatId)),
    roleBindings: config.gateway.authorization.roleBindings.filter((item) => !(item.connector === connector && item.chatId === chatId))
  });
}

export async function setGatewayMaster(workspaceRoot: string, connector: string, userId: string, label?: string): Promise<RuntimeConfig["gateway"]["authorization"]> {
  const config = (await loadRuntimeConfig(workspaceRoot)).config;
  return saveAuthorization(workspaceRoot, {
    ...config.gateway.authorization,
    masterUser: { connector, userId, ...(label ? { label } : {}) },
    roleBindings: config.gateway.authorization.roleBindings.filter((item) => !(item.connector === connector && item.userId === userId))
  });
}

export async function clearGatewayMaster(workspaceRoot: string): Promise<RuntimeConfig["gateway"]["authorization"]> {
  const config = (await loadRuntimeConfig(workspaceRoot)).config;
  const { masterUser: _masterUser, ...rest } = config.gateway.authorization;
  return saveAuthorization(workspaceRoot, rest);
}

export async function setGatewayRoleBinding(
  workspaceRoot: string,
  connector: string,
  userId: string,
  role: "guest" | "admin",
  chatId: string,
  label?: string
): Promise<RuntimeConfig["gateway"]["authorization"]> {
  const config = (await loadRuntimeConfig(workspaceRoot)).config;
  if (config.gateway.authorization.masterUser?.connector === connector && config.gateway.authorization.masterUser.userId === userId) {
    throw new Error("The global master user must not be duplicated in chat-scoped role bindings.");
  }
  const roleBindings = upsertBy(
    config.gateway.authorization.roleBindings,
    { connector, chatId, userId, role, ...(label ? { label } : {}) },
    (item) => `${item.connector}:${item.chatId}:${item.userId}`
  );
  return saveAuthorization(workspaceRoot, { ...config.gateway.authorization, roleBindings });
}

export async function unsetGatewayRoleBinding(workspaceRoot: string, connector: string, userId: string, chatId: string): Promise<RuntimeConfig["gateway"]["authorization"]> {
  const config = (await loadRuntimeConfig(workspaceRoot)).config;
  return saveAuthorization(workspaceRoot, {
    ...config.gateway.authorization,
    roleBindings: config.gateway.authorization.roleBindings.filter((item) => !(item.connector === connector && item.chatId === chatId && item.userId === userId))
  });
}

export async function formatGatewayAuthList(workspaceRoot: string): Promise<string> {
  const config = (await loadRuntimeConfig(workspaceRoot)).config;
  const auth = config.gateway.authorization;
  return [
    "Gateway authorization",
    `Allowed chats: ${auth.chats.length}`,
    ...auth.chats.map((item) => `  ${item.connector}:${item.chatId}${item.label ? ` (${item.label})` : ""}`),
    `Master: ${auth.masterUser ? `${auth.masterUser.connector}:${auth.masterUser.userId}${auth.masterUser.label ? ` (${auth.masterUser.label})` : ""}` : "none"}`,
    `Role bindings: ${auth.roleBindings.length}`,
    ...auth.roleBindings.map((item) => `  ${item.connector}:${item.chatId}:${item.userId} -> ${item.role}${item.label ? ` (${item.label})` : ""}`)
  ].join("\n");
}

export async function formatGatewayAuthCheck(workspaceRoot: string, actor: GatewayActor): Promise<string> {
  const config = (await loadRuntimeConfig(workspaceRoot)).config;
  const decision = resolveGatewayRole(config, actor);
  return [
    "Gateway authorization check",
    `Connector: ${actor.connector}`,
    `Chat id: ${actor.chatId ?? "unknown"}`,
    `Chat type: ${actor.chatType ?? "private"}`,
    `User id: ${actor.userId ?? "unknown"}`,
    `Allowed chat: ${decision.chatAllowed}`,
    `Role: ${decision.role ?? "unknown"}`,
    `Status: ${decision.allowed ? "allowed" : "blocked"}`,
    `Reason: ${decision.reason}`
  ].join("\n");
}

export function isGatewayChatAllowed(policyOrConfig: PolicyConfig | RuntimeConfig, connector: string, chatId: string | undefined): boolean {
  if (!chatId) return false;
  return policyOrConfig.gateway.authorization.chats.some((item) => item.connector === connector && item.chatId === chatId)
    || (connector === "telegram" && policyOrConfig.connectors.telegram.allowedChatIds.includes(chatId));
}

function formatGatewayAuthReason(decision: GatewayAuthDecision): string {
  switch (decision.reason) {
    case "chat_not_allowed":
      return "This external chat is not registered with COSIA Gateway.";
    case "missing_user_id":
      return "The connector did not provide a user id, so COSIA cannot authorize this actor.";
    case "unknown_user":
      return "This user is not registered for this chat.";
    case "insufficient_role":
      return "This user's Gateway role is too low for the requested action.";
    case "mutations_disabled":
      return "Gateway mutations are disabled by policy.";
    default:
      return "Gateway authorization blocked this request.";
  }
}

async function saveAuthorization(
  workspaceRoot: string,
  authorization: RuntimeConfig["gateway"]["authorization"]
): Promise<RuntimeConfig["gateway"]["authorization"]> {
  const cleanAuthorization = {
    chats: authorization.chats,
    ...(authorization.masterUser ? { masterUser: authorization.masterUser } : {}),
    roleBindings: authorization.roleBindings,
    unknownBlockThrottleMs: authorization.unknownBlockThrottleMs
  };
  const privateConfig = await loadPrivateRuntimeConfig(workspaceRoot);
  await savePrivateRuntimeConfig(workspaceRoot, {
    ...privateConfig,
    gateway: {
      ...privateConfig.gateway,
      authorization: cleanAuthorization
    }
  });
  return (await loadRuntimeConfig(workspaceRoot)).config.gateway.authorization;
}

function upsertBy<T>(items: T[], next: T, keyFor: (item: T) => string): T[] {
  const key = keyFor(next);
  return [
    ...items.filter((item) => keyFor(item) !== key),
    next
  ];
}
