import type { CliArgvToken, RuntimeCommandDefinition } from "./runtime_command_catalog.js";

export function buildCliArgv(definition: RuntimeCommandDefinition, args: Record<string, unknown> = {}): string[] {
  const argv: string[] = [];
  for (const token of definition.argvPlan) {
    switch (token.kind) {
      case "literal":
        argv.push(token.value);
        break;
      case "positional":
        appendPositional(argv, token, args);
        break;
      case "option":
        appendOption(argv, token, args);
        break;
      case "booleanFlag":
        appendBooleanFlag(argv, token, args);
        break;
    }
  }
  return argv;
}

export function argvPlanSlotNames(definition: RuntimeCommandDefinition): string[] {
  const names = new Set<string>();
  for (const token of definition.argvPlan) {
    if (token.kind !== "literal") {
      names.add(token.name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function appendPositional(argv: string[], token: Extract<CliArgvToken, { kind: "positional" }>, args: Record<string, unknown>): void {
  const value = args[token.name];
  if (isMissing(value)) {
    if (token.required) {
      throw new Error(`Missing required argv positional: ${token.name}`);
    }
    return;
  }
  argv.push(stringifyArgValue(token.name, value));
}

function appendOption(argv: string[], token: Extract<CliArgvToken, { kind: "option" }>, args: Record<string, unknown>): void {
  const value = args[token.name];
  if (isMissing(value)) {
    if (token.required) {
      throw new Error(`Missing required argv option: ${token.name}`);
    }
    return;
  }
  argv.push(token.flag, stringifyArgValue(token.name, value));
}

function appendBooleanFlag(argv: string[], token: Extract<CliArgvToken, { kind: "booleanFlag" }>, args: Record<string, unknown>): void {
  const value = args[token.name];
  if (isMissing(value) || value === false) {
    return;
  }
  if (value !== true) {
    throw new Error(`Boolean argv flag ${token.name} must be true or false.`);
  }
  argv.push(token.flag);
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function stringifyArgValue(name: string, value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error(`Unsupported argv value type for ${name}.`);
  }
  return String(value);
}
