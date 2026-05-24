import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathExists } from "./fs_utils.js";
import {
  gatewayRoot,
  isGatewayProcessLockStale,
  readGatewayProcessLock,
  readLegacyTelegramProcessLock,
  removeGatewayProcessLock,
  removeLegacyTelegramProcessLock,
  type GatewayLockRecord
} from "./gateway_locks.js";
import type { FetchLike } from "./model/providers/openai_compatible_provider.js";
import { resolveProviderSelection } from "./model/provider_registry.js";
import { PolicyManager, type PolicyConfig } from "./policy_manager.js";
import {
  checkTelegramGateway,
  inspectTelegramGatewayState,
  loadTelegramGatewayState,
  resolveTelegramToken,
  startTelegramGateway,
  type TelegramGatewayCheck
} from "./telegram_gateway.js";

export type GatewayConnectorId = "telegram";

export type GatewayStopRequest = {
  requestId: string;
  requestedAt: string;
  reason: "user_stop" | "restart";
};

export type GatewayStartOptions = {
  connector?: GatewayConnectorId;
  modelProvider?: string;
  providerProfile?: string;
  once?: boolean;
  fetchImpl?: FetchLike;
  now?: () => number;
};

export type GatewayStopResult = {
  requested: boolean;
  stopped: boolean;
  alreadyStopped: boolean;
  timedOut: boolean;
  staleLock: boolean;
  message: string;
  hint?: string;
};

export type GatewayUnlockResult = {
  removed: boolean;
  reason: string;
  lock?: GatewayLockRecord;
};

const defaultStopTimeoutMs = 10000;

export async function startGateway(workspaceRoot: string, options: GatewayStartOptions = {}): Promise<void> {
  const policy = await new PolicyManager(workspaceRoot).loadPolicy();
  const connectors = enabledConnectors(policy, options.connector);
  if (!connectors.length) {
    throw new Error(options.connector
      ? `Gateway connector '${options.connector}' is disabled. Run \`cosia gateway ${options.connector} enable\` before starting.`
      : "No enabled gateway connectors. Run `cosia gateway telegram enable` before starting.");
  }
  if (connectors.length > 1) {
    throw new Error("Multiple gateway connectors are not supported in v0.26.1.");
  }
  await clearOldStopRequestIfNotRunning(workspaceRoot, options.now);
  const existingLock = await readGatewayProcessLock(workspaceRoot);
  if (existingLock) {
    const stale = isGatewayProcessLockStale(existingLock, workspaceRoot, (options.now ?? (() => Date.now()))());
    throw new Error(stale
      ? "Stale gateway process lock found. Run `cosia gateway unlock --stale-only` before starting."
      : "Gateway is already running for this workspace.");
  }
  if (connectors[0] === "telegram") {
    const check = await checkTelegramGateway(workspaceRoot, { fetchImpl: options.fetchImpl });
    if (!check.ok) {
      throw new Error(formatGatewayConnectorFailure("telegram", check));
    }
    await startTelegramGateway(workspaceRoot, {
      providerId: resolveProviderSelection(policy, options.providerProfile ?? options.modelProvider),
      once: options.once,
      fetchImpl: options.fetchImpl,
      now: options.now,
      command: options.connector ? "cosia gateway start --connector telegram" : "cosia gateway start",
      stopRequested: async () => Boolean(await readGatewayStopRequest(workspaceRoot))
    });
  }
}

export async function stopGateway(
  workspaceRoot: string,
  options: { timeoutMs?: number; reason?: GatewayStopRequest["reason"]; now?: () => number } = {}
): Promise<GatewayStopResult> {
  const now = options.now ?? (() => Date.now());
  const lock = await readGatewayProcessLock(workspaceRoot);
  if (!lock) {
    await removeGatewayStopRequest(workspaceRoot);
    return {
      requested: false,
      stopped: true,
      alreadyStopped: true,
      timedOut: false,
      staleLock: false,
      message: "Gateway is not running. No stop request needed."
    };
  }
  if (isGatewayProcessLockStale(lock, workspaceRoot, now())) {
    return {
      requested: false,
      stopped: false,
      alreadyStopped: false,
      timedOut: false,
      staleLock: true,
      message: "Gateway is not running cleanly, but a stale process lock may exist.",
      hint: "Run: cosia gateway unlock --stale-only"
    };
  }

  await writeGatewayStopRequest(workspaceRoot, options.reason ?? "user_stop");
  const timeoutMs = options.timeoutMs ?? defaultStopTimeoutMs;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (!(await readGatewayProcessLock(workspaceRoot))) {
      await removeGatewayStopRequest(workspaceRoot);
      return {
        requested: true,
        stopped: true,
        alreadyStopped: false,
        timedOut: false,
        staleLock: false,
        message: "Gateway stopped."
      };
    }
    await delay(250);
  }
  return {
    requested: true,
    stopped: false,
    alreadyStopped: false,
    timedOut: true,
    staleLock: false,
    message: `Gateway did not stop within ${timeoutMs}ms.`,
    hint: [
      "COSIA did not force-kill the process.",
      "Check: cosia gateway status",
      "If the lock is stale: cosia gateway unlock --stale-only"
    ].join("\n")
  };
}

export async function restartGateway(
  workspaceRoot: string,
  options: GatewayStartOptions & { timeoutMs?: number } = {}
): Promise<void> {
  const stop = await stopGateway(workspaceRoot, {
    timeoutMs: options.timeoutMs,
    reason: "restart",
    now: options.now
  });
  if (stop.timedOut || stop.staleLock) {
    throw new Error(formatGatewayStopResult(stop));
  }
  await waitForNoGatewayLock(workspaceRoot, options.timeoutMs ?? defaultStopTimeoutMs, options.now);
  await startGateway(workspaceRoot, options);
}

export async function unlockStaleGateway(workspaceRoot: string, options: { staleOnly?: boolean; now?: () => number } = {}): Promise<GatewayUnlockResult> {
  const now = options.now ?? (() => Date.now());
  const lock = await readGatewayProcessLock(workspaceRoot);
  if (!lock) {
    return { removed: false, reason: "no process lock" };
  }
  const stale = isGatewayProcessLockStale(lock, workspaceRoot, now());
  if (options.staleOnly && !stale) {
    return { removed: false, reason: "lock is not stale", lock };
  }
  const removed = await removeGatewayProcessLock(workspaceRoot);
  return { removed, reason: stale ? "stale lock removed" : "lock removed", lock };
}

export async function formatGatewayStatus(workspaceRoot: string, options: { json?: boolean } = {}): Promise<string> {
  const policy = await new PolicyManager(workspaceRoot).loadPolicy();
  const state = await loadTelegramGatewayState(workspaceRoot);
  const telegramStateInspection = await inspectTelegramGatewayState(workspaceRoot);
  const lock = await readGatewayProcessLock(workspaceRoot);
  const legacyTelegramLock = await readLegacyTelegramProcessLock(workspaceRoot);
  const stopRequest = await readGatewayStopRequest(workspaceRoot);
  const now = Date.now();
  const lockStale = isGatewayProcessLockStale(lock, workspaceRoot, now);
  const legacyLockStale = isGatewayProcessLockStale(legacyTelegramLock, workspaceRoot, now, 120000, "telegram");
  const tokenStatus = resolveTelegramToken(workspaceRoot, policy.connectors.telegram);
  const report = {
    supervisor: {
      running: Boolean(lock && !lockStale),
      processLock: Boolean(lock),
      lockStale,
      lock,
      stopRequest
    },
    connectors: {
      telegram: {
        enabled: policy.connectors.telegram.enabled,
        configured: policy.connectors.telegram.enabled
          && policy.connectors.telegram.allowedChatIds.length > 0
          && Boolean(tokenStatus.token),
        tokenStatus: tokenStatus.status,
        allowedChatIds: policy.connectors.telegram.allowedChatIds.length,
        allowedUserIds: policy.connectors.telegram.allowedUserIds.length,
        mutationUserIds: policy.connectors.telegram.mutationUserIds.length,
        groupMode: policy.connectors.telegram.groupMode,
        activeChats: Object.keys(state.chats).length,
        staleActiveSessions: telegramStateInspection.staleSessions.length,
        nextOffset: state.nextOffset,
        failureCount: state.failureCount,
        lastFailure: state.lastFailure,
        legacyProcessLock: Boolean(legacyTelegramLock),
        legacyLockStale,
        legacyLock: legacyTelegramLock
      }
    }
  };
  if (options.json) {
    return JSON.stringify(report, null, 2);
  }
  return [
    "COSIA Gateway Status",
    "",
    `Gateway: ${report.supervisor.running ? "running" : "stopped"}`,
    `Process lock: ${report.supervisor.processLock ? "present" : "none"}`,
    `Lock stale: ${report.supervisor.lockStale}`,
    lock?.pid ? `PID: ${lock.pid}` : undefined,
    lock?.heartbeatAt ? `Heartbeat: ${lock.heartbeatAt}` : undefined,
    stopRequest ? `Stop request: ${stopRequest.reason} at ${stopRequest.requestedAt}` : "Stop request: none",
    "",
    "Connectors",
    "  telegram:",
    `    Enabled: ${policy.connectors.telegram.enabled}`,
    `    Configured: ${report.connectors.telegram.configured}`,
    `    Token: ${report.connectors.telegram.tokenStatus}`,
    `    Allowed chat ids: ${policy.connectors.telegram.allowedChatIds.length}`,
    `    Allowed user ids: ${policy.connectors.telegram.allowedUserIds.length}`,
    `    Mutation user ids: ${policy.connectors.telegram.mutationUserIds.length}`,
    `    Group mode: ${policy.connectors.telegram.groupMode}`,
    `    Active chats: ${Object.keys(state.chats).length}`,
    `    Stale active sessions: ${telegramStateInspection.staleSessions.length}`,
    telegramStateInspection.staleSessions.length ? "    Repair: cosia gateway telegram repair --stale-sessions" : undefined,
    `    Next offset: ${state.nextOffset ?? "none"}`,
    `    Failure count: ${state.failureCount}`,
    state.lastFailure ? `    Last failure: ${state.lastFailure}` : undefined,
    legacyTelegramLock ? `    Legacy lock: present${legacyLockStale ? " stale" : ""}` : undefined
  ].filter(Boolean).join("\n");
}

export function formatGatewayStopResult(result: GatewayStopResult): string {
  return [
    result.message,
    `Requested: ${result.requested}`,
    `Stopped: ${result.stopped}`,
    `Already stopped: ${result.alreadyStopped}`,
    `Timed out: ${result.timedOut}`,
    `Stale lock: ${result.staleLock}`,
    result.hint ? `Hint:\n${result.hint}` : undefined
  ].filter(Boolean).join("\n");
}

export function formatGatewayUnlockResult(result: GatewayUnlockResult): string {
  return [
    "Gateway unlock",
    `Removed: ${result.removed}`,
    `Reason: ${result.reason}`,
    result.lock?.pid ? `PID: ${result.lock.pid}` : undefined
  ].filter(Boolean).join("\n");
}

export async function readGatewayStopRequest(workspaceRoot: string): Promise<GatewayStopRequest | undefined> {
  const path = gatewayStopRequestPath(workspaceRoot);
  if (!(await pathExists(path))) {
    return undefined;
  }
  return JSON.parse(await readFile(path, "utf8")) as GatewayStopRequest;
}

export async function writeGatewayStopRequest(workspaceRoot: string, reason: GatewayStopRequest["reason"]): Promise<GatewayStopRequest> {
  await mkdir(gatewayControlDir(workspaceRoot), { recursive: true });
  const request: GatewayStopRequest = {
    requestId: randomUUID(),
    requestedAt: new Date().toISOString(),
    reason
  };
  await writeFile(gatewayStopRequestPath(workspaceRoot), `${JSON.stringify(request, null, 2)}\n`, "utf8");
  return request;
}

export async function removeGatewayStopRequest(workspaceRoot: string): Promise<boolean> {
  const path = gatewayStopRequestPath(workspaceRoot);
  if (!(await pathExists(path))) {
    return false;
  }
  await rm(path, { force: true });
  return true;
}

export function gatewayControlDir(workspaceRoot: string): string {
  return join(gatewayRoot(workspaceRoot), "control");
}

export function gatewayStopRequestPath(workspaceRoot: string): string {
  return join(gatewayControlDir(workspaceRoot), "stop.json");
}

function enabledConnectors(policy: PolicyConfig, requested?: GatewayConnectorId): GatewayConnectorId[] {
  if (requested) {
    return policy.connectors[requested].enabled ? [requested] : [];
  }
  return policy.connectors.telegram.enabled ? ["telegram"] : [];
}

async function clearOldStopRequestIfNotRunning(workspaceRoot: string, now: (() => number) | undefined): Promise<void> {
  const lock = await readGatewayProcessLock(workspaceRoot);
  const running = Boolean(lock && !isGatewayProcessLockStale(lock, workspaceRoot, (now ?? (() => Date.now()))()));
  if (!running) {
    await removeGatewayStopRequest(workspaceRoot);
  }
}

async function waitForNoGatewayLock(workspaceRoot: string, timeoutMs: number, now: (() => number) | undefined): Promise<void> {
  const clock = now ?? (() => Date.now());
  const deadline = clock() + timeoutMs;
  while (clock() < deadline) {
    if (!(await readGatewayProcessLock(workspaceRoot))) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Gateway process lock still exists after ${timeoutMs}ms.`);
}

function formatGatewayConnectorFailure(connector: GatewayConnectorId, check: TelegramGatewayCheck): string {
  return [
    `Gateway connector '${connector}' is not ready.`,
    `Reason: ${check.reason ?? "unknown"}`,
    `Message: ${check.message}`,
    check.hint ? `Hint: ${check.hint}` : undefined
  ].filter(Boolean).join("\n");
}
