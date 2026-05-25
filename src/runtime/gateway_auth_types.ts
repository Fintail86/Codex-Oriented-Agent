export type GatewayRole = "guest" | "admin" | "master";

export type GatewayActor = {
  connector: string;
  chatId?: string;
  chatType?: string;
  userId?: string;
  username?: string;
  displayName?: string;
};

export type GatewayAccessPolicy = {
  minRole: GatewayRole;
  allowedChatTypes: string[];
  requiresPreview?: boolean;
};
