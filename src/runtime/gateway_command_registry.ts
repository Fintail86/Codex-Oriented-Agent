import type { GatewayRole } from "./gateway_auth_types.js";

export type GatewayCommandSafety = "read_only" | "preview_mutation" | "mutation" | "system_boundary" | "dangerous";

export type GatewayCommandPattern =
  | { kind: "exact"; value: string }
  | { kind: "prefix"; value: string }
  | { kind: "regex"; value: RegExp };

export type GatewayCommandDefinition = {
  id: string;
  pattern: GatewayCommandPattern;
  helpLine?: string;
  description: string;
  minRole: GatewayRole;
  safety: GatewayCommandSafety;
  showInHelp?: boolean;
  deprecatedSince?: string;
  replacementCommandId?: string;
};

export const GATEWAY_COMMAND_REGISTRY_VERSION = 1;

export const gatewayCommandDefinitions: GatewayCommandDefinition[] = [
  command("gateway.help", exact("/help"), "  /help                 Show this help.", "Show Gateway command help.", "admin", "read_only"),
  command("gateway.whoami", exact("/whoami"), "  /whoami               Show Telegram chat/user ids for local setup.", "Show connector chat/user identity for local setup.", "guest", "read_only"),
  command("gateway.status", exact("/status"), "  /status               Show compact COSIA status.", "Show compact COSIA runtime status.", "admin", "read_only"),
  command("gateway.sessions", exact("/sessions"), "  /sessions             List sessions.", "List workspace sessions.", "admin", "read_only"),
  command("gateway.session.use", prefix("/use "), "  /use <session-id>     Select active session for this chat.", "Select the active session for this external chat.", "master", "mutation"),
  command("gateway.session.new", prefix("/new "), "  /new <goal>           Create a session with the default agent.", "Create and select a new session.", "master", "mutation"),
  command("gateway.jobs.list", exact("/jobs"), "  /jobs                 Show active run jobs.", "List active Gateway run jobs for the current chat/session.", "admin", "read_only"),
  command("gateway.jobs.show", prefix("/job "), "  /job <job-id>         Show a run job.", "Show a Gateway run job.", "admin", "read_only"),
  command("gateway.jobs.cancel", prefix("/cancel "), "  /cancel <job-id>      Cancel a run job.", "Request cancellation of a Gateway run job.", "master", "mutation"),
  command("gateway.review.list", regex(/^\/review(?:\s+(memory|skill))?$/), "  /review               Show memory/skill review inbox.", "Show memory/skill review inbox.", "admin", "read_only"),
  command("gateway.review.filter", regex(/^\/review\s+(memory|skill)$/), "  /review memory|skill  Filter review inbox.", "Filter memory/skill review inbox.", "admin", "read_only"),
  command("gateway.review.stats", exact("/review stats"), undefined, "Show review inbox stats.", "admin", "read_only"),
  command("gateway.review.cleanup", exact("/review cleanup"), undefined, "Preview review inbox cleanup.", "master", "preview_mutation"),
  command("gateway.review.next", exact("/review next"), undefined, "Show next review inbox item.", "admin", "read_only"),
  command("gateway.review.show", prefix("/review show "), undefined, "Show a review inbox item.", "admin", "read_only"),
  command("gateway.review.conflicts", prefix("/review conflicts "), undefined, "Show review item conflicts.", "admin", "read_only"),
  command("gateway.review.promote", prefix("/review promote "), undefined, "Preview review item promotion.", "master", "preview_mutation"),
  command("gateway.review.discard", prefix("/review discard "), undefined, "Preview review item discard.", "master", "preview_mutation"),
  command("gateway.pending.cancel", exact("/cancel"), "  /cancel               Cancel pending mutation preview.", "Cancel pending mutation preview.", "master", "mutation"),
  command("gateway.pending.show", exact("/pending"), "  /pending              Show pending mutation preview.", "Show pending mutation preview.", "admin", "read_only"),
  command("gateway.pending.apply", exact("/apply"), "  /apply                Apply pending mutation preview.", "Apply pending mutation preview.", "master", "mutation"),
  command("gateway.tool_growth", regex(/^\/tool\s+grow(?:\s|$)/), "  /tool grow <request>  Start a guided reusable-tool routine.", "Use guided tool growth commands.", "master", "preview_mutation"),
  command("gateway.tool_growth.test", regex(/^\/tool\s+grow\s+test(?:\s|$)/), "  /tool grow test [routine-id] --yes", "Run a guided tool growth candidate test.", "master", "preview_mutation"),
  command("gateway.tool_growth.activate", regex(/^\/tool\s+grow\s+activate(?:\s|$)/), "  /tool grow activate [routine-id] --agent <agent-id> --yes", "Activate a tested guided tool growth candidate.", "master", "mutation")
];

function command(
  id: string,
  pattern: GatewayCommandPattern,
  helpLine: string | undefined,
  description: string,
  minRole: GatewayRole,
  safety: GatewayCommandSafety,
  showInHelp = true
): GatewayCommandDefinition {
  return {
    id,
    pattern,
    helpLine,
    description,
    minRole,
    safety,
    showInHelp
  };
}

function exact(value: string): GatewayCommandPattern {
  return { kind: "exact", value };
}

function prefix(value: string): GatewayCommandPattern {
  return { kind: "prefix", value };
}

function regex(value: RegExp): GatewayCommandPattern {
  return { kind: "regex", value };
}

export function findGatewayCommandDefinition(input: string): GatewayCommandDefinition | undefined {
  const normalized = input.trim();
  return gatewayCommandDefinitions.find((definition) => gatewayCommandMatches(definition, normalized));
}

export function gatewayMinimumRoleForInput(input: string): GatewayRole {
  const normalized = input.trim();
  if (!normalized.startsWith("/")) {
    return "guest";
  }
  return findGatewayCommandDefinition(normalized)?.minRole ?? "master";
}

export function isGatewayReadOnlyCommand(input: string): boolean {
  const definition = findGatewayCommandDefinition(input);
  return definition?.safety === "read_only";
}

export function isGatewayMutationCommand(input: string): boolean {
  const normalized = input.trim();
  if (!normalized.startsWith("/")) {
    return false;
  }
  const definition = findGatewayCommandDefinition(normalized);
  return definition ? definition.safety !== "read_only" : true;
}

export function formatGatewayHelp(): string {
  const helpLines = gatewayCommandDefinitions
    .filter((definition) => definition.showInHelp !== false && definition.helpLine)
    .map((definition) => {
      const line = definition.helpLine ?? "";
      return definition.deprecatedSince ? `${line} [deprecated]` : line;
    });
  return [
    "COSIA Telegram Gateway commands:",
    ...helpLines,
    "",
    "Notes:",
    "  Gateway slash commands require a registered admin or master role. Use /whoami, then set Gateway auth locally.",
    "  # command shortcuts were removed. Use slash commands or plain natural language.",
    "",
    "Plain text is sent to the active COSIA session."
  ].join("\n");
}

export function formatUnknownGatewayCommand(input: string): string {
  const definition = findGatewayCommandDefinition(input);
  if (definition?.deprecatedSince && definition.replacementCommandId) {
    const replacement = gatewayCommandDefinitions.find((item) => item.id === definition.replacementCommandId);
    return [
      `Deprecated Telegram gateway command: ${input}`,
      replacement ? `Use: ${replacement.helpLine ?? replacement.description}` : undefined,
      "",
      formatGatewayHelp()
    ].filter(Boolean).join("\n");
  }
  return `Unknown Telegram gateway command: ${input}\n\n${formatGatewayHelp()}`;
}

function gatewayCommandMatches(definition: GatewayCommandDefinition, input: string): boolean {
  switch (definition.pattern.kind) {
    case "exact":
      return input === definition.pattern.value;
    case "prefix":
      return input.startsWith(definition.pattern.value);
    case "regex":
      return definition.pattern.value.test(input);
  }
}
