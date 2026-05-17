import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "./fs_utils.js";
import type { PolicyAuditEvent, PolicyAuditEventInput, SessionMetadata } from "./types.js";

export type PolicyAuditListOptions = {
  limit?: number;
  runId?: string;
  latestRun?: boolean;
};

export class PolicyAuditLog {
  constructor(private readonly workspaceRoot: string) {}

  async append(session: SessionMetadata, input: PolicyAuditEventInput, runId?: string): Promise<void> {
    const event: PolicyAuditEvent = {
      id: randomUUID(),
      runId,
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      agentId: session.agentId,
      ...input
    };
    await ensureDir(this.sessionDir(session.id));
    await appendFile(this.auditPath(session.id), `${JSON.stringify(event)}\n`, "utf8");
  }

  async list(sessionId: string, limitOrOptions: number | PolicyAuditListOptions = 20): Promise<PolicyAuditEvent[]> {
    const path = this.auditPath(sessionId);
    if (!existsSync(path)) {
      return [];
    }
    const text = await readFile(path, "utf8");
    const events = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PolicyAuditEvent);
    const options = typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
    const filtered = filterAuditEvents(events, options);
    const limit = options.limit ?? 20;
    return filtered.slice(Math.max(0, filtered.length - limit));
  }

  private auditPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "POLICY_AUDIT.jsonl");
  }

  private sessionDir(sessionId: string): string {
    return join(this.workspaceRoot, "sessions", sessionId);
  }
}

export function formatPolicyAuditEvents(events: PolicyAuditEvent[]): string {
  const groups = groupEventsByRun(events);
  const lines: string[] = [];

  for (const [groupIndex, group] of groups.entries()) {
    if (groupIndex > 0) {
      lines.push("");
    }
    const runLabel = group.runId ?? "legacy/no-run-id";
    lines.push(`Run: ${runLabel}`);
    lines.push(`Session: ${group.events[0]?.sessionId ?? "unknown"}`);
    lines.push(`Agent: ${group.events[0]?.agentId ?? "unknown"}`);
    lines.push(`Events: ${group.events.length}`);
    lines.push("");

    for (const [index, event] of group.events.entries()) {
      const result = event.allowed ? "ALLOW" : "DENY";
      lines.push(`${index + 1}. ${event.timestamp}  ${result}  ${event.eventType}`);
      lines.push(`   rule: ${event.ruleId}`);
      if (event.tool) {
        const permission = event.permission ? ` (${event.permission})` : "";
        lines.push(`   tool: ${event.tool}${permission}`);
      }
      if (event.reason) {
        lines.push(`   reason: ${event.reason}`);
      }
      const args = formatArgsSummary(event.argsSummary);
      if (args) {
        lines.push(`   args: ${args}`);
      }
    }
  }

  return lines.join("\n");
}

function groupEventsByRun(events: PolicyAuditEvent[]): Array<{ runId?: string; events: PolicyAuditEvent[] }> {
  const groups: Array<{ runId?: string; events: PolicyAuditEvent[] }> = [];
  for (const event of events) {
    const last = groups.at(-1);
    if (last && last.runId === event.runId) {
      last.events.push(event);
      continue;
    }
    groups.push({ runId: event.runId, events: [event] });
  }
  return groups;
}

function formatArgsSummary(argsSummary?: Record<string, unknown>): string {
  if (!argsSummary || !Object.keys(argsSummary).length) {
    return "";
  }
  return Object.entries(argsSummary)
    .map(([key, value]) => `${key}=${formatArgValue(value)}`)
    .join(", ");
}

function formatArgValue(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (raw === undefined) {
    return "undefined";
  }
  const clipped = raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
  return JSON.stringify(clipped);
}

function filterAuditEvents(events: PolicyAuditEvent[], options: PolicyAuditListOptions): PolicyAuditEvent[] {
  if (options.runId) {
    return events.filter((event) => event.runId === options.runId);
  }
  if (options.latestRun) {
    const latestRunId = [...events].reverse().find((event) => event.runId)?.runId;
    return latestRunId ? events.filter((event) => event.runId === latestRunId) : [];
  }
  return events;
}

export function summarizePolicyArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") {
    return {};
  }
  return sanitizeRecord(args as Record<string, unknown>);
}

function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = sanitizeValue(key, value);
  }
  return result;
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (isSecretKey(key)) {
    return "[redacted]";
  }
  if (key === "content" && typeof value === "string") {
    return `[content:${value.length} chars]`;
  }
  if (typeof value === "string") {
    return maskSecretLikeStrings(value.length > 240 ? `${value.slice(0, 240)}...` : value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(key, item));
  }
  if (value && typeof value === "object") {
    return sanitizeRecord(value as Record<string, unknown>);
  }
  return value;
}

function isSecretKey(key: string): boolean {
  return /token|secret|password|credential|api[_-]?key/i.test(key);
}

function maskSecretLikeStrings(value: string): string {
  return value.replace(/\b(sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, "[redacted]");
}
