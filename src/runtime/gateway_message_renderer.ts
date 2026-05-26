import { formatGatewayHelp as formatGatewayRegistryHelp, formatUnknownGatewayCommand } from "./gateway_command_registry.js";

export function formatGatewayHelp(): string {
  return formatGatewayRegistryHelp();
}

export function formatGatewayUnknownCommand(input: string): string {
  return formatUnknownGatewayCommand(input);
}

export function formatHashCommandRemovedNotice(): string {
  return [
    "Hash command shortcuts were removed.",
    "Use slash commands for explicit runtime actions:",
    "  /status",
    "  /review",
    "  /sessions",
    "  /pending",
    "  /apply",
    "  /cancel",
    "  /tool grow <request>",
    "",
    "Or send plain natural language without #."
  ].join("\n");
}

export function formatUnknownCallbackNotice(): string {
  return "Unknown Telegram callback. No mutation was applied.";
}
