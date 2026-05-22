import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { FetchLike } from "./model/providers/openai_compatible_provider.js";
import { pathExists, writeText } from "./fs_utils.js";
import {
  acquireGatewayProcessLock,
  releaseGatewayProcessLock,
  telegramGatewayDir,
  telegramProcessLockPath,
  type GatewayLockRecord
} from "./gateway_locks.js";
import { chunkTelegramMessage } from "./gateway_format.js";
import { handleGatewayMessage, type GatewayChatState } from "./gateway_runtime.js";
import { PolicyManager, type PolicyConfig } from "./policy_manager.js";

export type TelegramGatewayCheck = {
  ok: boolean;
  status: "ok" | "failed";
  reason?: "disabled" | "missing_token" | "missing_allowed_chat_ids" | "auth_failed" | "network_error" | "http_error" | "malformed_response";
  message: string;
  hint?: string;
};

export type TelegramGatewayState = {
  nextOffset?: number;
  chats: Record<string, GatewayChatState>;
  failureCount: number;
  lastFailure?: string;
  updatedAt: string;
};

export type TelegramStartOptions = {
  providerId?: string;
  once?: boolean;
  fetchImpl?: FetchLike;
  now?: () => number;
};

export type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    chat: {
      id: number | string;
    };
  };
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export type TelegramMessageSender = {
  sendMessage(chatId: string, text: string): Promise<void>;
};

class TelegramApiClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly token: string, fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async getMe(): Promise<unknown> {
    return this.call<unknown>("getMe", {});
  }

  async getUpdates(offset: number | undefined, timeoutMs: number): Promise<TelegramUpdate[]> {
    const timeoutSeconds = Math.max(1, Math.floor(timeoutMs / 1000));
    return this.call<TelegramUpdate[]>("getUpdates", {
      timeout: timeoutSeconds,
      ...(offset !== undefined ? { offset } : {})
    });
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.call("sendMessage", {
      chat_id: chatId,
      text
    });
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new TelegramApiError(`Telegram HTTP ${response.status}: ${await safeResponsePreview(response)}`, response.status);
    }
    const parsed = await response.json() as TelegramApiResponse<T>;
    if (!parsed.ok) {
      throw new TelegramApiError(parsed.description ?? `Telegram ${method} failed.`);
    }
    if (parsed.result === undefined) {
      throw new TelegramApiError(`Telegram ${method} returned malformed response.`);
    }
    return parsed.result;
  }
}

export async function checkTelegramGateway(
  workspaceRoot: string,
  options: { fetchImpl?: FetchLike } = {}
): Promise<TelegramGatewayCheck> {
  const policy = await new PolicyManager(workspaceRoot).loadPolicy();
  const config = policy.connectors.telegram;
  if (!config.enabled) {
    return {
      ok: false,
      status: "failed",
      reason: "disabled",
      message: "Telegram connector is disabled.",
      hint: "Set connectors.telegram.enabled=true in codex/POLICY.json."
    };
  }
  if (!config.allowedChatIds.length) {
    return {
      ok: false,
      status: "failed",
      reason: "missing_allowed_chat_ids",
      message: "Telegram connector has no allowed chat ids.",
      hint: "Add your Telegram chat id to connectors.telegram.allowedChatIds."
    };
  }
  const token = process.env[config.tokenEnv];
  if (!token) {
    return {
      ok: false,
      status: "failed",
      reason: "missing_token",
      message: `Telegram token env ${config.tokenEnv} is not set.`,
      hint: `Set ${config.tokenEnv} before starting the gateway.`
    };
  }
  try {
    await new TelegramApiClient(token, options.fetchImpl).getMe();
    return {
      ok: true,
      status: "ok",
      message: "Telegram connector is configured and getMe succeeded."
    };
  } catch (error) {
    const classified = classifyTelegramCheckError(error);
    return {
      ok: false,
      status: "failed",
      reason: classified.reason,
      message: (error as Error).message,
      hint: classified.hint
    };
  }
}

function classifyTelegramCheckError(error: unknown): {
  reason: NonNullable<TelegramGatewayCheck["reason"]>;
  hint: string;
} {
  if (error instanceof TelegramApiError) {
    if (error.status === 401 || error.status === 403 || error.status === 404) {
      return {
        reason: "auth_failed",
        hint: "Check that TELEGRAM_BOT_TOKEN is the real BotFather token, e.g. 1234567890:AA..., not the bot username, chat id, or placeholder text."
      };
    }
    return {
      reason: "http_error",
      hint: "Telegram Bot API returned an HTTP error. Check Telegram API availability and gateway policy settings."
    };
  }
  return {
    reason: "network_error",
    hint: "Check network connectivity and Telegram Bot API availability."
  };
}

export async function startTelegramGateway(workspaceRoot: string, options: TelegramStartOptions = {}): Promise<void> {
  const policyManager = new PolicyManager(workspaceRoot);
  const policy = await policyManager.loadPolicy();
  const config = policy.connectors.telegram;
  const check = await checkTelegramGateway(workspaceRoot, { fetchImpl: options.fetchImpl });
  if (!check.ok) {
    throw new Error(`${check.message}${check.hint ? `\nHint: ${check.hint}` : ""}`);
  }
  const token = process.env[config.tokenEnv];
  if (!token) throw new Error(`Telegram token env ${config.tokenEnv} is not set.`);

  await mkdir(telegramGatewayDir(workspaceRoot), { recursive: true });
  const client = new TelegramApiClient(token, options.fetchImpl);
  const lock = await acquireGatewayProcessLock(workspaceRoot, "telegram-gateway", options.now);
  let cleanupStarted = false;
  let shutdownRequested = false;
  const unregister = registerGatewaySignals(() => {
    shutdownRequested = true;
  });
  const cleanup = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    unregister();
    await releaseGatewayProcessLock(workspaceRoot, lock);
    await writeTelegramStatus(workspaceRoot, {
      running: false,
      stoppedAt: new Date().toISOString()
    });
  };

  try {
    await writeTelegramStatus(workspaceRoot, {
      running: true,
      pid: process.pid,
      startedAt: new Date().toISOString()
    });
    let state = await loadTelegramGatewayState(workspaceRoot);
    let consecutiveFailures = 0;
    while (!shutdownRequested) {
      try {
        const updates = await client.getUpdates(state.nextOffset, config.pollTimeoutMs);
        consecutiveFailures = 0;
        for (const update of updates) {
          if (shutdownRequested) break;
          state = await processTelegramUpdate(workspaceRoot, policy, client, state, update, {
            providerId: options.providerId ?? config.defaultProvider,
            owner: `telegram:${update.message?.chat.id ?? "unknown"}`,
            now: options.now
          });
          state.nextOffset = update.update_id + 1;
          state.failureCount = 0;
          state.lastFailure = undefined;
          state.updatedAt = new Date().toISOString();
          await saveTelegramGatewayState(workspaceRoot, state);
        }
        if (options.once) break;
      } catch (error) {
        consecutiveFailures += 1;
        state.failureCount = consecutiveFailures;
        state.lastFailure = (error as Error).message;
        state.updatedAt = new Date().toISOString();
        await saveTelegramGatewayState(workspaceRoot, state);
        await writeTelegramStatus(workspaceRoot, {
          running: true,
          failureCount: consecutiveFailures,
          lastFailure: state.lastFailure
        });
        if (consecutiveFailures >= config.maxConsecutiveFailures || options.once) {
          break;
        }
        const backoff = Math.min(
          config.backoffMaxMs,
          config.backoffInitialMs * (2 ** Math.max(0, consecutiveFailures - 1))
        );
        await delay(backoff);
      }
    }
  } finally {
    await cleanup();
  }
}

export async function processTelegramUpdate(
  workspaceRoot: string,
  policy: PolicyConfig,
  client: TelegramMessageSender,
  state: TelegramGatewayState,
  update: TelegramUpdate,
  options: { providerId: string; owner: string; now?: () => number }
): Promise<TelegramGatewayState> {
  const message = update.message;
  if (!message?.text) {
    return state;
  }
  const chatId = String(message.chat.id);
  if (!policy.connectors.telegram.allowedChatIds.includes(chatId)) {
    await client.sendMessage(chatId, "Unauthorized COSIA Telegram chat.");
    return state;
  }
  let chatState = state.chats[chatId] ?? {
    providerId: options.providerId
  };
  for (const input of splitTelegramInputs(message.text)) {
    const result = await handleGatewayMessage({
      workspaceRoot,
      input,
      state: chatState,
      policy,
      providerId: chatState.providerId ?? options.providerId,
      owner: options.owner,
      now: options.now
    });
    chatState = result.state;
    for (const chunk of chunkTelegramMessage(result.output, policy.connectors.telegram.messageChunkChars)) {
      await client.sendMessage(chatId, chunk);
    }
  }
  return {
    ...state,
    chats: {
      ...state.chats,
      [chatId]: chatState
    },
    updatedAt: new Date().toISOString()
  };
}

export async function loadTelegramGatewayState(workspaceRoot: string): Promise<TelegramGatewayState> {
  const path = telegramStatePath(workspaceRoot);
  if (!(await pathExists(path))) {
    return {
      chats: {},
      failureCount: 0,
      updatedAt: new Date().toISOString()
    };
  }
  const parsed = JSON.parse(await readFile(path, "utf8")) as TelegramGatewayState;
  return {
    chats: parsed.chats ?? {},
    nextOffset: parsed.nextOffset,
    failureCount: parsed.failureCount ?? 0,
    lastFailure: parsed.lastFailure,
    updatedAt: parsed.updatedAt ?? new Date().toISOString()
  };
}

export async function saveTelegramGatewayState(workspaceRoot: string, state: TelegramGatewayState): Promise<void> {
  await mkdir(telegramGatewayDir(workspaceRoot), { recursive: true });
  await writeFile(telegramStatePath(workspaceRoot), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function formatGatewayStatus(workspaceRoot: string): Promise<string> {
  const state = await loadTelegramGatewayState(workspaceRoot);
  const processLocked = await pathExists(telegramProcessLockPath(workspaceRoot));
  const policy = await new PolicyManager(workspaceRoot).loadPolicy();
  return [
    "COSIA Gateway Status",
    "",
    "Telegram",
    `  Enabled: ${policy.connectors.telegram.enabled}`,
    `  Process lock: ${processLocked ? "present" : "none"}`,
    `  Allowed chat ids: ${policy.connectors.telegram.allowedChatIds.length}`,
    `  Active chats: ${Object.keys(state.chats).length}`,
    `  Next offset: ${state.nextOffset ?? "none"}`,
    `  Failure count: ${state.failureCount}`,
    state.lastFailure ? `  Last failure: ${state.lastFailure}` : undefined
  ].filter(Boolean).join("\n");
}

export function formatTelegramCheck(result: TelegramGatewayCheck): string {
  return [
    "Telegram Gateway",
    `Status: ${result.status}`,
    `Message: ${result.message}`,
    result.reason ? `Reason: ${result.reason}` : undefined,
    result.hint ? `Hint: ${result.hint}` : undefined
  ].filter(Boolean).join("\n");
}

function telegramStatePath(workspaceRoot: string): string {
  return join(telegramGatewayDir(workspaceRoot), "state.json");
}

function splitTelegramInputs(text: string): string[] {
  const trimmed = text.trim();
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) {
    return [trimmed];
  }
  if (lines[0].startsWith("/") || lines[0].startsWith("#")) {
    return lines;
  }
  return [trimmed];
}

async function writeTelegramStatus(workspaceRoot: string, status: Record<string, unknown>): Promise<void> {
  await writeText(join(telegramGatewayDir(workspaceRoot), "status.json"), `${JSON.stringify(status, null, 2)}\n`);
}

async function safeResponsePreview(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function registerGatewaySignals(onSignal: () => void): () => void {
  let registered = true;
  const handler = () => {
    if (!registered) return;
    onSignal();
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return () => {
    if (!registered) return;
    registered = false;
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}
