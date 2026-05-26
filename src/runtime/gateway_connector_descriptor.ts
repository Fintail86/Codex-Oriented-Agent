import type { GatewayActor, GatewayRole } from "./gateway_auth_types.js";
import type { GatewayCommandSafety } from "./gateway_command_registry.js";

export type GatewayCallbackActionDefinition = {
  minRole: GatewayRole;
  safety: GatewayCommandSafety;
  description: string;
};

export type GatewayCallbackNamespaceDefinition = {
  actions: Record<string, GatewayCallbackActionDefinition>;
};

export type GatewayConnectorDescriptor = {
  id: string;
  displayName: string;
  normalizeAddressedCommand(text: string): string;
  formatBootstrapHints(actor: GatewayActor): string[];
  callbackNamespaces: Record<string, GatewayCallbackNamespaceDefinition>;
  messageDefaults: {
    messageChunkChars: number;
    sendPacingMs: number;
    typingRefreshMs: number;
  };
  telegram?: {
    longPolling: true;
    webhookConflictPolicy: "fail_until_cleared";
    allowedUpdates: string[];
    retryAfterHandling: "retry_once";
  };
};

export type ParsedGatewayCallback = {
  namespace: string;
  action: string;
  value?: string;
  definition: GatewayCallbackActionDefinition;
};

export const telegramGatewayConnectorDescriptor: GatewayConnectorDescriptor = {
  id: "telegram",
  displayName: "Telegram",
  normalizeAddressedCommand(text: string): string {
    const trimmed = text.trim();
    const addressedSlash = trimmed.match(/^@[A-Za-z0-9_]{5,32}\s+([/#].*)$/);
    if (addressedSlash) {
      return addressedSlash[1].trim();
    }
    return trimmed.replace(/^(\/[A-Za-z0-9_]+)@[A-Za-z0-9_]{5,32}\b/, "$1");
  },
  formatBootstrapHints(actor: GatewayActor): string[] {
    const chatId = actor.chatId ?? "<chat-id>";
    const userId = actor.userId ?? "<user-id>";
    return [
      `  cosia gateway auth allow-chat telegram ${chatId}`,
      `  cosia gateway auth set-master telegram ${userId}`,
      actor.userId && actor.chatId
        ? `  cosia gateway auth set-role telegram ${actor.userId} guest --chat-id ${actor.chatId}`
        : "  cosia gateway auth set-role telegram <user-id> guest --chat-id <chat-id>"
    ];
  },
  callbackNamespaces: {
    review: {
      actions: {
        refresh: { minRole: "admin", safety: "read_only", description: "Refresh review inbox." },
        next: { minRole: "admin", safety: "read_only", description: "Show next review item." },
        show: { minRole: "admin", safety: "read_only", description: "Show review item detail." },
        conflicts: { minRole: "admin", safety: "read_only", description: "Show review item conflicts." },
        discard: { minRole: "master", safety: "preview_mutation", description: "Preview review item discard." },
        promote: { minRole: "master", safety: "preview_mutation", description: "Preview review item promotion." }
      }
    }
  },
  messageDefaults: {
    messageChunkChars: 3500,
    sendPacingMs: 1100,
    typingRefreshMs: 4000
  },
  telegram: {
    longPolling: true,
    webhookConflictPolicy: "fail_until_cleared",
    allowedUpdates: ["message", "callback_query"],
    retryAfterHandling: "retry_once"
  }
};

export const TELEGRAM_ALLOWED_UPDATES = telegramGatewayConnectorDescriptor.telegram?.allowedUpdates ?? ["message", "callback_query"];

export function gatewayConnectorDescriptorFor(connector: string | undefined): GatewayConnectorDescriptor {
  if (connector === "telegram" || !connector) {
    return telegramGatewayConnectorDescriptor;
  }
  return {
    id: connector,
    displayName: connector,
    normalizeAddressedCommand: (text) => text.trim(),
    formatBootstrapHints: (actor) => [
      actor.chatId ? `  cosia gateway auth allow-chat ${actor.connector} ${actor.chatId}` : `  cosia gateway auth allow-chat ${actor.connector} <chat-id>`,
      actor.userId ? `  cosia gateway auth set-master ${actor.connector} ${actor.userId}` : `  cosia gateway auth set-master ${actor.connector} <user-id>`,
      actor.userId && actor.chatId
        ? `  cosia gateway auth set-role ${actor.connector} ${actor.userId} guest --chat-id ${actor.chatId}`
        : `  cosia gateway auth set-role ${actor.connector} <user-id> guest --chat-id <chat-id>`
    ],
    callbackNamespaces: {},
    messageDefaults: telegramGatewayConnectorDescriptor.messageDefaults
  };
}

export function parseGatewayCallbackData(descriptor: GatewayConnectorDescriptor, data: string): ParsedGatewayCallback | undefined {
  const [namespace, action, value] = data.split(":");
  if (!namespace || !action) {
    return undefined;
  }
  const definition = descriptor.callbackNamespaces[namespace]?.actions[action];
  if (!definition) {
    return undefined;
  }
  return {
    namespace,
    action,
    value,
    definition
  };
}

export function buildGatewayCallbackData(namespace: string, action: string, value?: string): string {
  return [namespace, action, value].filter((part) => part !== undefined && part !== "").join(":");
}
