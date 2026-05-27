import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gatewayRoot } from "./gateway_locks.js";
import type { GatewayActivity, GatewayReplyTarget, GatewayRiskFlags } from "./gateway_runtime.js";

export type GatewayDurableTurnStatus = "queued" | "started" | "completed" | "failed" | "stale" | "resumed";

export type GatewayDurableTurnSnapshot = {
  turnId: string;
  connector: string;
  sessionId: string;
  activity: GatewayActivity;
  replyTarget: GatewayReplyTarget;
  riskFlags: GatewayRiskFlags;
  createdAt: string;
};

export type GatewayDurableTurnEvent = GatewayDurableTurnSnapshot & {
  status: GatewayDurableTurnStatus;
  recordedAt: string;
  errorSummary?: string;
};

export type GatewayDurableTurnWriteResult =
  | { stored: true }
  | { stored: false; reason: "secret_like" | "missing_risk_flags" | "write_failed"; errorSummary?: string };

const durableTurnQueueFile = "turn_queue.jsonl";
const serializedWrites = new Map<string, Promise<void>>();
const defaultQueuedTurnTtlMs = 30 * 60 * 1000;

export function gatewayTurnQueuePath(workspaceRoot: string): string {
  return join(gatewayRoot(workspaceRoot), durableTurnQueueFile);
}

export function createGatewayTurnId(): string {
  return `turn_${randomUUID().slice(0, 8)}`;
}

export async function appendGatewayDurableTurnEvent(
  workspaceRoot: string,
  event: Omit<GatewayDurableTurnEvent, "recordedAt">
): Promise<GatewayDurableTurnWriteResult> {
  if (!event.riskFlags) {
    return { stored: false, reason: "missing_risk_flags" };
  }
  if (event.riskFlags.secretLikeInput) {
    return { stored: false, reason: "secret_like" };
  }
  try {
    await serializedAppendJsonl(gatewayTurnQueuePath(workspaceRoot), {
      ...sanitizeTurnEvent(event),
      recordedAt: new Date().toISOString()
    });
    return { stored: true };
  } catch (error) {
    return {
      stored: false,
      reason: "write_failed",
      errorSummary: (error as Error).message.replace(/\s+/g, " ").slice(0, 200)
    };
  }
}

export async function loadPendingGatewayDurableTurns(
  workspaceRoot: string,
  options: { nowMs?: number; ttlMs?: number } = {}
): Promise<{ pending: GatewayDurableTurnSnapshot[]; stale: GatewayDurableTurnSnapshot[] }> {
  const path = gatewayTurnQueuePath(workspaceRoot);
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { pending: [], stale: [] };
  }
  const byId = new Map<string, GatewayDurableTurnEvent>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as GatewayDurableTurnEvent;
      if (!event.turnId) continue;
      byId.set(event.turnId, event);
    } catch {
      continue;
    }
  }
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? defaultQueuedTurnTtlMs;
  const pending: GatewayDurableTurnSnapshot[] = [];
  const stale: GatewayDurableTurnSnapshot[] = [];
  for (const event of byId.values()) {
    if (event.status !== "queued") continue;
    const createdAtMs = Date.parse(event.createdAt);
    if (Number.isFinite(createdAtMs) && nowMs - createdAtMs > ttlMs) {
      stale.push(event);
    } else {
      pending.push(event);
    }
  }
  return { pending, stale };
}

async function serializedAppendJsonl(path: string, value: unknown): Promise<void> {
  const previous = serializedWrites.get(path) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
    });
  serializedWrites.set(path, next);
  await next;
}

function sanitizeTurnEvent(event: Omit<GatewayDurableTurnEvent, "recordedAt">): Omit<GatewayDurableTurnEvent, "recordedAt"> {
  const activity = event.activity.type === "callback_action"
    ? {
      ...event.activity,
      callbackData: event.activity.callbackData?.slice(0, 200)
    }
    : {
      ...event.activity,
      text: event.activity.text.slice(0, 2000)
    };
  return {
    ...event,
    activity,
    errorSummary: event.errorSummary?.replace(/\s+/g, " ").slice(0, 200)
  };
}
