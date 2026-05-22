import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "./fs_utils.js";

export type GatewayLockRecord = {
  lockId: string;
  kind: "process" | "session";
  owner: string;
  pid: number;
  createdAt: string;
  expiresAt?: string;
  createdAtMs: number;
  expiresAtMs?: number;
  sessionId?: string;
};

export type SessionLockOptions = {
  owner: string;
  ttlMs?: number;
  now?: () => number;
  onReleaseError?: (error: unknown) => void;
};

export class GatewayLockError extends Error {
  readonly code = "gateway_lock_busy";

  constructor(message: string, readonly record?: GatewayLockRecord) {
    super(message);
  }
}

const defaultSessionLockTtlMs = 15 * 60 * 1000;

export function gatewayRoot(workspaceRoot: string): string {
  return join(workspaceRoot, ".cosia-gateway");
}

export function telegramGatewayDir(workspaceRoot: string): string {
  return join(gatewayRoot(workspaceRoot), "telegram");
}

export function gatewayLocksDir(workspaceRoot: string): string {
  return join(gatewayRoot(workspaceRoot), "locks");
}

export function telegramProcessLockPath(workspaceRoot: string): string {
  return join(telegramGatewayDir(workspaceRoot), "process.lock");
}

export function sessionLockPath(workspaceRoot: string, sessionId: string): string {
  return join(gatewayLocksDir(workspaceRoot), `session_${sanitizeLockName(sessionId)}.lock`);
}

export async function acquireGatewayProcessLock(
  workspaceRoot: string,
  owner = "telegram",
  now: () => number = () => Date.now()
): Promise<GatewayLockRecord> {
  await mkdir(telegramGatewayDir(workspaceRoot), { recursive: true });
  const path = telegramProcessLockPath(workspaceRoot);
  if (await pathExists(path)) {
    throw new GatewayLockError("Telegram gateway is already running for this workspace.", await readLock(path));
  }
  const createdAtMs = now();
  const record: GatewayLockRecord = {
    lockId: randomUUID(),
    kind: "process",
    owner,
    pid: process.pid,
    createdAt: new Date(createdAtMs).toISOString(),
    createdAtMs
  };
  await writeJson(path, record);
  return record;
}

export async function releaseGatewayProcessLock(workspaceRoot: string, lock: GatewayLockRecord): Promise<boolean> {
  return releaseLock(telegramProcessLockPath(workspaceRoot), lock);
}

export async function acquireSessionLock(
  workspaceRoot: string,
  sessionId: string,
  options: SessionLockOptions
): Promise<GatewayLockRecord> {
  await mkdir(gatewayLocksDir(workspaceRoot), { recursive: true });
  const now = options.now ?? (() => Date.now());
  const path = sessionLockPath(workspaceRoot, sessionId);
  if (await pathExists(path)) {
    const existing = await readLock(path);
    if (!isStale(existing, now())) {
      throw new GatewayLockError(`Session is busy: ${sessionId}`, existing);
    }
    await rm(path, { force: true });
  }
  const createdAtMs = now();
  const expiresAtMs = createdAtMs + (options.ttlMs ?? defaultSessionLockTtlMs);
  const record: GatewayLockRecord = {
    lockId: randomUUID(),
    kind: "session",
    sessionId,
    owner: options.owner,
    pid: process.pid,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    createdAtMs,
    expiresAtMs
  };
  await writeJson(path, record);
  return record;
}

export async function releaseSessionLock(workspaceRoot: string, lock: GatewayLockRecord): Promise<boolean> {
  if (!lock.sessionId) {
    return false;
  }
  return releaseLock(sessionLockPath(workspaceRoot, lock.sessionId), lock);
}

export async function withSessionLock<T>(
  workspaceRoot: string,
  sessionId: string,
  options: SessionLockOptions,
  fn: () => Promise<T>
): Promise<T> {
  const lock = await acquireSessionLock(workspaceRoot, sessionId, options);
  try {
    return await fn();
  } finally {
    try {
      await releaseSessionLock(workspaceRoot, lock);
    } catch (error) {
      options.onReleaseError?.(error);
    }
  }
}

async function releaseLock(path: string, lock: GatewayLockRecord): Promise<boolean> {
  if (!(await pathExists(path))) {
    return false;
  }
  const current = await readLock(path);
  if (current.lockId !== lock.lockId) {
    return false;
  }
  await rm(path, { force: true });
  return true;
}

async function readLock(path: string): Promise<GatewayLockRecord> {
  return JSON.parse(await readFile(path, "utf8")) as GatewayLockRecord;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isStale(record: GatewayLockRecord, nowMs: number): boolean {
  return typeof record.expiresAtMs === "number" && record.expiresAtMs <= nowMs;
}

function sanitizeLockName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
