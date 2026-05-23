import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { FetchLike } from "./model/providers/openai_compatible_provider.js";
import { pathExists, writeText } from "./fs_utils.js";
import {
  acquireGatewayProcessLock,
  heartbeatGatewayProcessLock,
  isGatewayProcessLockStale,
  readLegacyTelegramProcessLock,
  readGatewayProcessLock,
  removeLegacyTelegramProcessLock,
  releaseGatewayProcessLock,
  telegramGatewayDir
} from "./gateway_locks.js";
import { chunkTelegramMessage } from "./gateway_format.js";
import { handleGatewayMessage, type GatewayChatState } from "./gateway_runtime.js";
import { PolicyManager, type PolicyConfig } from "./policy_manager.js";
import { getTelegramBotTokenSecret } from "./private_config.js";
import { resolveProviderSelection } from "./model/provider_registry.js";

export type TelegramTokenResolution = {
  token?: string;
  status: "configured via env" | "configured via private secret" | "missing";
};

export type TelegramGatewayCheck = {
  ok: boolean;
  status: "ok" | "failed";
  reason?: "disabled" | "missing_token" | "missing_allowed_chat_ids" | "auth_failed" | "network_error" | "http_error" | "malformed_response";
  message: string;
  hint?: string;
  tokenStatus?: TelegramTokenResolution["status"];
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
  command?: string;
  stopRequested?: () => boolean | Promise<boolean>;
};

export type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    chat: {
      id: number | string;
    };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      chat: {
        id: number | string;
      };
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
  sendMessage(chatId: string, text: string, options?: { replyMarkup?: unknown }): Promise<void>;
  answerCallbackQuery?(callbackQueryId: string, text?: string): Promise<void>;
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

  async sendMessage(chatId: string, text: string, options: { replyMarkup?: unknown } = {}): Promise<void> {
    await this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {})
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {})
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
      hint: "Run `cosia gateway telegram enable`."
    };
  }
  if (!config.allowedChatIds.length) {
    return {
      ok: false,
      status: "failed",
      reason: "missing_allowed_chat_ids",
      message: "Telegram connector has no allowed chat ids.",
      hint: "Run `cosia gateway telegram set chat-id <chat-id>`."
    };
  }
  const tokenResolution = resolveTelegramToken(workspaceRoot, config);
  if (!tokenResolution.token) {
    return {
      ok: false,
      status: "failed",
      reason: "missing_token",
      message: "Telegram bot token is not configured.",
      hint: "Run `cosia gateway telegram set token` or `cosia gateway telegram set token-env <ENV_NAME>`.",
      tokenStatus: tokenResolution.status
    };
  }
  try {
    await new TelegramApiClient(tokenResolution.token, options.fetchImpl).getMe();
    return {
      ok: true,
      status: "ok",
      message: "Telegram connector is configured and getMe succeeded.",
      tokenStatus: tokenResolution.status
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
        hint: "Check that the configured Telegram bot token is the real BotFather token, e.g. 1234567890:AA..., not the bot username, chat id, or placeholder text."
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
  const token = resolveTelegramToken(workspaceRoot, config).token;
  if (!token) throw new Error("Telegram bot token is not configured.");
  const providerId = resolveProviderSelection(policy, options.providerId);

  await mkdir(telegramGatewayDir(workspaceRoot), { recursive: true });
  const client = new TelegramApiClient(token, options.fetchImpl);
  const lock = await acquireGatewayProcessLock(workspaceRoot, "gateway", options.now, {
    gatewayId: "gateway",
    command: options.command ?? "cosia gateway telegram start"
  });
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
    await appendTelegramLog(workspaceRoot, "start", { pid: process.pid });
    let state = await loadTelegramGatewayState(workspaceRoot);
    let consecutiveFailures = 0;
    while (!shutdownRequested) {
      if (await shouldStop(options)) {
        shutdownRequested = true;
        break;
      }
      try {
        await heartbeatGatewayProcessLock(workspaceRoot, lock, options.now);
        const updates = await client.getUpdates(state.nextOffset, config.pollTimeoutMs);
        if (await shouldStop(options)) {
          shutdownRequested = true;
          break;
        }
        consecutiveFailures = 0;
        for (const update of updates) {
          if (shutdownRequested) break;
          if (await shouldStop(options)) {
            shutdownRequested = true;
            break;
          }
          await heartbeatGatewayProcessLock(workspaceRoot, lock, options.now);
          state = await processTelegramUpdate(workspaceRoot, policy, client, state, update, {
            providerId,
            owner: `telegram:${telegramUpdateChatId(update) ?? "unknown"}`,
            now: options.now
          });
          state.nextOffset = update.update_id + 1;
          state.failureCount = 0;
          state.lastFailure = undefined;
          state.updatedAt = new Date().toISOString();
          await saveTelegramGatewayState(workspaceRoot, state);
          await appendTelegramLog(workspaceRoot, "update", { updateId: update.update_id, nextOffset: state.nextOffset });
        }
        if (options.once) break;
      } catch (error) {
        if (await shouldStop(options)) {
          shutdownRequested = true;
          break;
        }
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
        await appendTelegramLog(workspaceRoot, "failure", { failureCount: consecutiveFailures, error: state.lastFailure });
        if (consecutiveFailures >= config.maxConsecutiveFailures || options.once) {
          break;
        }
        const backoff = Math.min(
          config.backoffMaxMs,
          config.backoffInitialMs * (2 ** Math.max(0, consecutiveFailures - 1))
        );
        if (await shouldStop(options)) {
          shutdownRequested = true;
          break;
        }
        await delay(backoff);
      }
    }
  } finally {
    await cleanup();
    await appendTelegramLog(workspaceRoot, "stop", {});
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
  const callback = update.callback_query;
  if (callback) {
    const chatId = String(callback.message?.chat.id ?? "");
    if (!chatId || !policy.connectors.telegram.allowedChatIds.includes(chatId)) {
      if (chatId) {
        await client.sendMessage(chatId, "Unauthorized COSIA Telegram chat.");
      }
      if (client.answerCallbackQuery) {
        await client.answerCallbackQuery(callback.id, "Unauthorized");
      }
      return state;
    }
    if (client.answerCallbackQuery) {
      await client.answerCallbackQuery(callback.id);
    }
    const input = telegramCallbackInput(callback.data ?? "");
    let chatState = state.chats[chatId] ?? {
      providerId: options.providerId
    };
    const result = await handleGatewayMessage({
      workspaceRoot,
      input,
      state: chatState,
      policy,
      providerId: chatState.providerId ?? options.providerId,
      owner: options.owner,
      chatId,
      now: options.now
    });
    chatState = result.state;
    for (const chunk of chunkTelegramMessage(result.output, policy.connectors.telegram.messageChunkChars)) {
      await client.sendMessage(chatId, chunk, telegramReplyOptions(input, result.output));
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
      chatId,
      now: options.now
    });
    chatState = result.state;
    for (const chunk of chunkTelegramMessage(result.output, policy.connectors.telegram.messageChunkChars)) {
      await client.sendMessage(chatId, chunk, telegramReplyOptions(input, result.output));
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

export async function formatGatewayStatus(workspaceRoot: string, options: { json?: boolean } = {}): Promise<string> {
  const state = await loadTelegramGatewayState(workspaceRoot);
  const lock = await readGatewayProcessLock(workspaceRoot);
  const legacyLock = await readLegacyTelegramProcessLock(workspaceRoot);
  const processLocked = Boolean(lock);
  const lockStale = isGatewayProcessLockStale(lock, workspaceRoot, Date.now());
  const legacyLockStale = isGatewayProcessLockStale(legacyLock, workspaceRoot, Date.now(), 120000, "telegram");
  const policy = await new PolicyManager(workspaceRoot).loadPolicy();
  const report = {
    supervisor: {
      processLock: processLocked,
      lockStale,
      lock
    },
    telegram: {
      enabled: policy.connectors.telegram.enabled,
      processLock: processLocked,
      lockStale,
      lock,
      legacyProcessLock: Boolean(legacyLock),
      legacyLockStale,
      allowedChatIds: policy.connectors.telegram.allowedChatIds.length,
      activeChats: Object.keys(state.chats).length,
      nextOffset: state.nextOffset,
      failureCount: state.failureCount,
      lastFailure: state.lastFailure
    }
  };
  if (options.json) {
    return JSON.stringify(report, null, 2);
  }
  return [
    "COSIA Gateway Status",
    "",
    "Telegram",
    `  Enabled: ${policy.connectors.telegram.enabled}`,
    `  Process lock: ${processLocked ? "present" : "none"}`,
    `  Lock stale: ${lockStale}`,
    lock?.heartbeatAt ? `  Heartbeat: ${lock.heartbeatAt}` : undefined,
    `  Allowed chat ids: ${policy.connectors.telegram.allowedChatIds.length}`,
    `  Active chats: ${Object.keys(state.chats).length}`,
    `  Next offset: ${state.nextOffset ?? "none"}`,
    `  Failure count: ${state.failureCount}`,
    state.lastFailure ? `  Last failure: ${state.lastFailure}` : undefined,
    legacyLock ? `  Legacy lock: present${legacyLockStale ? " stale" : ""}` : undefined
  ].filter(Boolean).join("\n");
}

export async function unlockStaleTelegramGateway(workspaceRoot: string, options: { staleOnly?: boolean } = {}): Promise<{ removed: boolean; reason: string }> {
  const lock = await readLegacyTelegramProcessLock(workspaceRoot);
  if (!lock) {
    return { removed: false, reason: "no process lock" };
  }
  const stale = isGatewayProcessLockStale(lock, workspaceRoot, Date.now(), 120000, "telegram");
  if (options.staleOnly && !stale) {
    return { removed: false, reason: "lock is not stale" };
  }
  const removed = await removeLegacyTelegramProcessLock(workspaceRoot);
  return { removed, reason: stale ? "stale lock removed" : "lock removed" };
}

export function formatTelegramCheck(result: TelegramGatewayCheck): string {
  return [
    "Telegram Gateway",
    `Status: ${result.status}`,
    `Message: ${result.message}`,
    result.tokenStatus ? `Token: ${result.tokenStatus}` : undefined,
    result.reason ? `Reason: ${result.reason}` : undefined,
    result.hint ? `Hint: ${result.hint}` : undefined
  ].filter(Boolean).join("\n");
}

export function resolveTelegramToken(
  workspaceRoot: string,
  config: PolicyConfig["connectors"]["telegram"]
): TelegramTokenResolution {
  if (config.tokenEnv && process.env[config.tokenEnv]) {
    return {
      token: process.env[config.tokenEnv],
      status: "configured via env"
    };
  }
  const privateToken = getTelegramBotTokenSecret(workspaceRoot);
  if (privateToken) {
    return {
      token: privateToken,
      status: "configured via private secret"
    };
  }
  return {
    status: "missing"
  };
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

function telegramUpdateChatId(update: TelegramUpdate): string | undefined {
  return update.message?.chat.id !== undefined
    ? String(update.message.chat.id)
    : update.callback_query?.message?.chat.id !== undefined
      ? String(update.callback_query.message.chat.id)
      : undefined;
}

function telegramCallbackInput(data: string): string {
  const [scope, action, value] = data.split(":");
  if (scope !== "review") {
    return "/review";
  }
  switch (action) {
    case "refresh":
      return "/review";
    case "next":
      return "/review next";
    case "show":
      return `/review show ${value ?? ""}`.trim();
    case "conflicts":
      return `/review conflicts ${value ?? ""}`.trim();
    case "discard":
      return `/review discard ${value ?? ""} --reason Telegram review discard`.trim();
    case "promote":
      return `/review promote ${value ?? ""}`.trim();
    default:
      return "/review";
  }
}

function telegramReplyOptions(input: string, output: string): { replyMarkup?: unknown } {
  if (!input.startsWith("/review") && !input.startsWith("#리뷰")) {
    return {};
  }
  const firstItem = output.match(/^\s*(?:1\.|\s*1\s+)\s+(memory|skill)\s+([a-zA-Z0-9]{8})/m);
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [
    [
      { text: "Refresh", callback_data: "review:refresh" },
      { text: "Next", callback_data: "review:next" }
    ]
  ];
  if (firstItem?.[2]) {
    const id = firstItem[2];
    buttons.push([
      { text: "Show", callback_data: `review:show:${id}` },
      { text: "Conflicts", callback_data: `review:conflicts:${id}` }
    ]);
    buttons.push([
      { text: "Discard preview", callback_data: `review:discard:${id}` },
      { text: "Promote preview", callback_data: `review:promote:${id}` }
    ]);
  }
  return { replyMarkup: { inline_keyboard: buttons } };
}

async function appendTelegramLog(workspaceRoot: string, event: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(telegramGatewayDir(workspaceRoot), { recursive: true });
  await appendFile(join(telegramGatewayDir(workspaceRoot), "log.jsonl"), `${JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...data
  })}\n`, "utf8");
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

async function shouldStop(options: TelegramStartOptions): Promise<boolean> {
  return Boolean(await options.stopRequested?.());
}
