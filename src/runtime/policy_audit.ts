import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "./fs_utils.js";
import type { PolicyAuditEvent, PolicyAuditEventInput, SessionMetadata } from "./types.js";

export class PolicyAuditLog {
  constructor(private readonly workspaceRoot: string) {}

  async append(session: SessionMetadata, input: PolicyAuditEventInput): Promise<void> {
    const event: PolicyAuditEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      agentId: session.agentId,
      ...input
    };
    await ensureDir(this.sessionDir(session.id));
    await appendFile(this.auditPath(session.id), `${JSON.stringify(event)}\n`, "utf8");
  }

  async list(sessionId: string, limit = 20): Promise<PolicyAuditEvent[]> {
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
    return events.slice(Math.max(0, events.length - limit));
  }

  private auditPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "POLICY_AUDIT.jsonl");
  }

  private sessionDir(sessionId: string): string {
    return join(this.workspaceRoot, "sessions", sessionId);
  }
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
