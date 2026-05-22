import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { commandDefinitions } from "./command_intent.js";

export type CommandTriggerIssue = {
  severity: "warning" | "info";
  commandId?: string;
  trigger?: string;
  message: string;
};

export type CommandTriggerCheckResult = {
  locale: string;
  overridePath: string;
  commandCount: number;
  issues: CommandTriggerIssue[];
};

export type CommandTriggerSyncResult = {
  locale: string;
  overridePath: string;
  created: boolean;
  updated: boolean;
  commandCount: number;
};

type TriggerPack = Record<string, string[]>;

export function checkCommandTriggers(workspaceRoot: string, locale = "ko"): CommandTriggerCheckResult {
  const overridePath = commandTriggerOverridePath(workspaceRoot, locale);
  const pack = mergedTriggerPack(workspaceRoot, locale);
  const issues: CommandTriggerIssue[] = [];
  const seen = new Map<string, string[]>();
  for (const [commandId, triggers] of Object.entries(pack)) {
    for (const trigger of triggers) {
      const normalized = normalize(trigger);
      if (!normalized) continue;
      if (normalized.length <= 2) {
        issues.push({
          severity: "warning",
          commandId,
          trigger,
          message: "Trigger is too short for automatic matching."
        });
      }
      const list = seen.get(normalized) ?? [];
      list.push(commandId);
      seen.set(normalized, list);
    }
  }
  for (const [trigger, commandIds] of seen.entries()) {
    const unique = [...new Set(commandIds)];
    if (unique.length > 1) {
      issues.push({
        severity: "warning",
        trigger,
        message: `Trigger maps to multiple commands: ${unique.join(", ")}`
      });
    }
  }
  return {
    locale,
    overridePath,
    commandCount: Object.keys(pack).length,
    issues
  };
}

export function syncCommandTriggers(workspaceRoot: string, locale = "ko"): CommandTriggerSyncResult {
  if (locale !== "ko") {
    throw new Error("Only the ko trigger pack is supported in v0.26.");
  }
  const overridePath = commandTriggerOverridePath(workspaceRoot, locale);
  const builtIn = builtInTriggerPack(locale);
  const current = readOverridePack(overridePath);
  const next: TriggerPack = { ...current };
  let updated = false;
  for (const [commandId, triggers] of Object.entries(builtIn)) {
    if (!next[commandId]) {
      next[commandId] = triggers;
      updated = true;
    }
  }
  const created = !existsSync(overridePath);
  if (created || updated) {
    mkdirSync(dirname(overridePath), { recursive: true });
    writeFileSync(overridePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }
  return {
    locale,
    overridePath,
    created,
    updated,
    commandCount: Object.keys(next).length
  };
}

export function formatCommandTriggerCheck(result: CommandTriggerCheckResult): string {
  return [
    "Command Trigger Check",
    `Locale: ${result.locale}`,
    `Override: ${result.overridePath}`,
    `Commands: ${result.commandCount}`,
    result.issues.length ? "Issues:" : "Issues: none",
    ...result.issues.map((issue) => `- [${issue.severity}] ${issue.commandId ? `${issue.commandId}: ` : ""}${issue.trigger ? `"${issue.trigger}" ` : ""}${issue.message}`)
  ].join("\n");
}

export function formatCommandTriggerSync(result: CommandTriggerSyncResult): string {
  return [
    "Command Trigger Sync",
    `Locale: ${result.locale}`,
    `Override: ${result.overridePath}`,
    `Created: ${result.created}`,
    `Updated: ${result.updated}`,
    `Commands: ${result.commandCount}`
  ].join("\n");
}

function mergedTriggerPack(workspaceRoot: string, locale: string): TriggerPack {
  return {
    ...builtInTriggerPack(locale),
    ...readOverridePack(commandTriggerOverridePath(workspaceRoot, locale))
  };
}

function builtInTriggerPack(locale: string): TriggerPack {
  if (locale !== "ko") {
    return {};
  }
  return Object.fromEntries(commandDefinitions.map((definition) => [definition.commandId, definition.triggers.ko]));
}

function readOverridePack(path: string): TriggerPack {
  if (!existsSync(path)) {
    return {};
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid command trigger override pack: ${path}`);
  }
  const pack: TriggerPack = {};
  for (const [commandId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      pack[commandId] = value.filter((item): item is string => typeof item === "string");
    }
  }
  return pack;
}

function commandTriggerOverridePath(workspaceRoot: string, locale: string): string {
  return join(workspaceRoot, "config", `command_triggers.${locale}.json`);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
