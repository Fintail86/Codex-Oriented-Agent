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
import { formatGatewayWhoami, handleGatewayMessage, isGatewayWhoamiInput, type GatewayChatState, type GatewayMessageResult, type GatewaySourceContext } from "./gateway_runtime.js";
import { gatewayAuthSummary } from "./gateway_auth.js";
import { PolicyManager, type PolicyConfig } from "./policy_manager.js";
import { getTelegramBotTokenSecret } from "./private_config.js";
import { resolveProviderSelection } from "./model/provider_registry.js";
import {
  formatRunJobAccepted,
  RunJobLedger,
  type RunJobRecord
} from "./run_jobs.js";

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
  allowedChatIds?: number;
  allowedUserIds?: number;
  mutationUserIds?: number;
  authChatCount?: number;
  masterConfigured?: boolean;
  guestBindings?: number;
  adminBindings?: number;
  legacyWarning?: string;
  groupMode?: PolicyConfig["connectors"]["telegram"]["groupMode"];
};

export type TelegramGatewayState = {
  nextOffset?: number;
  chats: Record<string, GatewayChatState>;
  failureCount: number;
  lastFailure?: string;
  updatedAt: string;
};

export type TelegramStateIssue = {
  chatId: string;
  sessionId: string;
  kind: "missing_session";
};

export type TelegramStateInspection = {
  chatCount: number;
  staleSessions: TelegramStateIssue[];
};

export type TelegramStateRepairResult = {
  checkedChats: number;
  staleSessionsFound: number;
  staleSessionsCleared: number;
  repaired: boolean;
  clearedSessionIds: string[];
  preservedNextOffset?: number;
  note: string;
};

export type TelegramStateResetResult = {
  removedChats: number;
  preservedNextOffset?: number;
  reset: boolean;
  note: string;
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
      type?: string;
      title?: string;
    };
    from?: TelegramUser;
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: TelegramUser;
    message?: {
      chat: {
        id: number | string;
        type?: string;
        title?: string;
      };
    };
  };
};

export type TelegramUser = {
  id: number | string;
  username?: string;
  first_name?: string;
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
  sendChatAction?(chatId: string, action?: "typing"): Promise<void>;
  answerCallbackQuery?(callbackQueryId: string, text?: string): Promise<void>;
};

const TELEGRAM_TYPING_REFRESH_MS = 4000;
const activeTelegramSessionWorkers = new Set<string>();

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
      allowed_updates: ["message", "callback_query"],
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

  async sendChatAction(chatId: string, action: "typing" = "typing"): Promise<void> {
    await this.call("sendChatAction", {
      chat_id: chatId,
      action
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
  const auth = gatewayAuthSummary(policy);
  if (!config.enabled) {
    return {
      ok: false,
      status: "failed",
      reason: "disabled",
      message: "Telegram connector is disabled.",
      hint: "Run `cosia gateway telegram enable`.",
      authChatCount: auth.chatCount,
      masterConfigured: auth.masterConfigured,
      guestBindings: auth.guestBindings,
      adminBindings: auth.adminBindings,
      legacyWarning: auth.legacyWarning,
      groupMode: config.groupMode
    };
  }
  if (!auth.chatCount) {
    return {
      ok: false,
      status: "failed",
      reason: "missing_allowed_chat_ids",
      message: "Telegram connector has no Gateway-authorized chats.",
      hint: "Run `cosia gateway auth allow-chat telegram <chat-id>`.",
      authChatCount: auth.chatCount,
      masterConfigured: auth.masterConfigured,
      guestBindings: auth.guestBindings,
      adminBindings: auth.adminBindings,
      legacyWarning: auth.legacyWarning,
      groupMode: config.groupMode
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
      tokenStatus: tokenResolution.status,
      authChatCount: auth.chatCount,
      masterConfigured: auth.masterConfigured,
      guestBindings: auth.guestBindings,
      adminBindings: auth.adminBindings,
      legacyWarning: auth.legacyWarning,
      groupMode: config.groupMode
    };
  }
  try {
    await new TelegramApiClient(tokenResolution.token, options.fetchImpl).getMe();
    return {
      ok: true,
      status: "ok",
      message: auth.masterConfigured
        ? "Telegram connector is configured and getMe succeeded."
        : "Telegram connector is configured and getMe succeeded, but no Gateway master user is registered.",
      hint: auth.masterConfigured ? undefined : "Run `cosia gateway auth set-master telegram <user-id>` after /whoami discovery.",
      tokenStatus: tokenResolution.status,
      authChatCount: auth.chatCount,
      masterConfigured: auth.masterConfigured,
      guestBindings: auth.guestBindings,
      adminBindings: auth.adminBindings,
      legacyWarning: auth.legacyWarning,
      groupMode: config.groupMode
    };
  } catch (error) {
    const classified = classifyTelegramCheckError(error);
    return {
      ok: false,
      status: "failed",
      reason: classified.reason,
      message: (error as Error).message,
      hint: classified.hint,
      authChatCount: auth.chatCount,
      masterConfigured: auth.masterConfigured,
      guestBindings: auth.guestBindings,
      adminBindings: auth.adminBindings,
      legacyWarning: auth.legacyWarning,
      groupMode: config.groupMode
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
    await new RunJobLedger(workspaceRoot).interruptActiveJobs("gateway_start_interrupted_previous_jobs");
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
          try {
            state = await processTelegramUpdate(workspaceRoot, policy, client, state, update, {
              providerId,
              owner: `telegram:${telegramUpdateChatId(update) ?? "unknown"}`,
              now: options.now
            });
            state.failureCount = 0;
            state.lastFailure = undefined;
            await appendTelegramLog(workspaceRoot, "update", { updateId: update.update_id, nextOffset: update.update_id + 1 });
          } catch (error) {
            const message = (error as Error).message;
            state.failureCount = state.failureCount + 1;
            state.lastFailure = message;
            await notifyTelegramUpdateFailure(client, update, message);
            await appendTelegramLog(workspaceRoot, "update_failure", { updateId: update.update_id, error: message });
          }
          state.nextOffset = update.update_id + 1;
          state.updatedAt = new Date().toISOString();
          await saveTelegramGatewayState(workspaceRoot, state);
          await writeTelegramStatus(workspaceRoot, {
            running: true,
            failureCount: state.failureCount,
            lastFailure: state.lastFailure
          });
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
    await new RunJobLedger(workspaceRoot).interruptActiveJobs("gateway_stopped");
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
    const source = telegramSourceFromCallback(callback);
    if (client.answerCallbackQuery) {
      await client.answerCallbackQuery(callback.id);
    }
    return withTelegramTyping(client, chatId, async () => {
      const input = telegramCallbackInput(callback.data ?? "");
      let chatState = state.chats[chatId] ?? {
        providerId: options.providerId
      };
      let lastToolResultSummary: string | undefined;
      let result: GatewayMessageResult;
      try {
        result = await handleGatewayMessage({
          workspaceRoot,
          input,
          state: chatState,
          policy,
          providerId: chatState.providerId ?? options.providerId,
          owner: options.owner,
          chatId,
          source,
          now: options.now,
          onRunProgress: (event) => {
            lastToolResultSummary = event.toolResultSummary ?? lastToolResultSummary;
          },
          promoteSessionRun: async (runInput, runState) => promoteTelegramRunJob({
            workspaceRoot,
            policy,
            client,
            chatId,
            input: runInput,
            state,
            chatState: runState,
            providerId: runState.providerId ?? options.providerId,
            owner: options.owner,
            source,
            now: options.now
          })
        });
      } catch (error) {
        await sendForegroundGatewayFailure(client, chatId, policy, error, lastToolResultSummary);
        return state;
      }
      chatState = result.state;
      if (result.output.trim()) {
        for (const chunk of chunkTelegramMessage(result.output, policy.connectors.telegram.messageChunkChars)) {
          await client.sendMessage(chatId, chunk, telegramReplyOptions(input, result.output));
        }
      }
      const chats = nextTelegramChats(state.chats, chatId, chatState);
      return {
        ...state,
        chats,
        updatedAt: new Date().toISOString()
      };
    });
  }

  const message = update.message;
  if (!message?.text) {
    return state;
  }
  const messageText = normalizeTelegramAddressedCommand(message.text);
  const chatId = String(message.chat.id);
  const source = telegramSourceFromMessage(message);
  if (isGatewayWhoamiInput(messageText)) {
    await client.sendMessage(chatId, formatGatewayWhoami(source));
    return state;
  }
  return withTelegramTyping(client, chatId, async () => {
    let chatState = state.chats[chatId] ?? {
      providerId: options.providerId
    };
    for (const input of splitTelegramInputs(messageText)) {
      let lastToolResultSummary: string | undefined;
      let result: GatewayMessageResult;
      try {
        result = await handleGatewayMessage({
          workspaceRoot,
          input,
          state: chatState,
          policy,
          providerId: chatState.providerId ?? options.providerId,
          owner: options.owner,
          chatId,
          source,
          now: options.now,
          onRunProgress: (event) => {
            lastToolResultSummary = event.toolResultSummary ?? lastToolResultSummary;
          },
          promoteSessionRun: async (runInput, runState) => promoteTelegramRunJob({
            workspaceRoot,
            policy,
            client,
            chatId,
            input: runInput,
            state,
            chatState: runState,
            providerId: runState.providerId ?? options.providerId,
            owner: options.owner,
            source,
            now: options.now
          })
        });
      } catch (error) {
        await sendForegroundGatewayFailure(client, chatId, policy, error, lastToolResultSummary);
        continue;
      }
      chatState = result.state;
      if (result.output.trim()) {
        for (const chunk of chunkTelegramMessage(result.output, policy.connectors.telegram.messageChunkChars)) {
          await client.sendMessage(chatId, chunk, telegramReplyOptions(input, result.output));
        }
      }
    }
    const chats = nextTelegramChats(state.chats, chatId, chatState);
    return {
      ...state,
      chats,
      updatedAt: new Date().toISOString()
    };
  });
}

type PromoteTelegramRunJobInput = {
  workspaceRoot: string;
  policy: PolicyConfig;
  client: TelegramMessageSender;
  chatId: string;
  input: string;
  state: TelegramGatewayState;
  chatState: GatewayChatState;
  providerId: string;
  owner: string;
  source: GatewaySourceContext;
  now?: () => number;
};

async function promoteTelegramRunJob(input: PromoteTelegramRunJobInput): Promise<{ output: string; state: GatewayChatState }> {
  if (!input.chatState.activeSessionId) {
    return {
      output: "No active session. Use /sessions, /use <session-id>, or /new <goal>.",
      state: input.chatState
    };
  }
  const job = await new RunJobLedger(input.workspaceRoot).create({
    sessionId: input.chatState.activeSessionId,
    providerId: input.providerId,
    request: input.input,
    source: {
      channel: "telegram",
      chatId: input.chatId,
      chatType: input.source.chatType,
      userId: input.source.userId,
      username: input.source.username,
      firstName: input.source.firstName
    }
  });
  startTelegramSessionWorker({
    workspaceRoot: input.workspaceRoot,
    policy: input.policy,
    client: input.client,
    state: input.state,
    sessionId: job.sessionId,
    fallbackProviderId: input.providerId,
    owner: input.owner,
    now: input.now
  });
  return {
    output: formatRunJobAccepted(job),
    state: input.chatState
  };
}

function startTelegramSessionWorker(options: {
  workspaceRoot: string;
  policy: PolicyConfig;
  client: TelegramMessageSender;
  state: TelegramGatewayState;
  sessionId: string;
  fallbackProviderId: string;
  owner: string;
  now?: () => number;
}): void {
  const key = `${options.workspaceRoot}:${options.sessionId}`;
  if (activeTelegramSessionWorkers.has(key)) {
    return;
  }
  activeTelegramSessionWorkers.add(key);
  void processTelegramSessionQueue(options).finally(() => {
    activeTelegramSessionWorkers.delete(key);
  });
}

async function processTelegramSessionQueue(options: {
  workspaceRoot: string;
  policy: PolicyConfig;
  client: TelegramMessageSender;
  state: TelegramGatewayState;
  sessionId: string;
  fallbackProviderId: string;
  owner: string;
  now?: () => number;
}): Promise<void> {
  const ledger = new RunJobLedger(options.workspaceRoot);
  for (;;) {
    const job = await ledger.nextQueuedForSession(options.sessionId);
    if (!job) {
      return;
    }
    await runTelegramJob({ ...options, job });
  }
}

async function runTelegramJob(options: {
  workspaceRoot: string;
  policy: PolicyConfig;
  client: TelegramMessageSender;
  state: TelegramGatewayState;
  job: RunJobRecord;
  fallbackProviderId: string;
  owner: string;
  now?: () => number;
}): Promise<void> {
  const ledger = new RunJobLedger(options.workspaceRoot);
  const chatId = options.job.source.chatId;
  const stopTyping = chatId ? startTelegramTyping(options.client, chatId) : () => {};
  await ledger.update(options.job.id, {
    status: "running",
    currentStep: "starting"
  });
  try {
    const providerId = options.job.providerId ?? options.fallbackProviderId;
    const source: GatewaySourceContext = {
      connector: "telegram",
      chatId,
      chatType: options.job.source.chatType ?? "private",
      userId: options.job.source.userId,
      username: options.job.source.username,
      firstName: options.job.source.firstName
    };
    const chatState = latestTelegramChatState(options.state, options.job);
    const result = await handleGatewayMessage({
      workspaceRoot: options.workspaceRoot,
      input: options.job.request,
      state: chatState,
      policy: options.policy,
      providerId,
      owner: options.owner,
      chatId,
      source,
      now: options.now,
      onRunProgress: async (event) => {
        await ledger.update(options.job.id, {
          status: event.status,
          currentStep: event.currentStep,
          lastToolResultSummary: event.toolResultSummary
        });
      }
    });
    const latest = await ledger.get(options.job.id);
    if (latest?.cancelRequestedAt) {
      await ledger.update(options.job.id, {
        status: "cancelled",
        currentStep: "cancelled after provider/tool completion"
      });
      return;
    }
    await persistTelegramChatState(options.workspaceRoot, options.state, chatId, result.state);
    await ledger.update(options.job.id, {
      status: "succeeded",
      currentStep: "completed",
      finalOutputSummary: result.output
    });
    if (chatId) {
      for (const chunk of chunkTelegramMessage(result.output, options.policy.connectors.telegram.messageChunkChars)) {
        await options.client.sendMessage(chatId, chunk, telegramReplyOptions(options.job.request, result.output));
      }
    }
  } catch (error) {
    const latest = await ledger.get(options.job.id);
    if (latest?.cancelRequestedAt) {
      await ledger.update(options.job.id, {
        status: "cancelled",
        currentStep: "cancelled after provider/tool failure"
      });
      return;
    }
    const message = (error as Error).message;
    const fallback = isTimeoutFailure(message) && latest?.lastToolResultSummary
      ? formatTimeoutFallback(latest.lastToolResultSummary)
      : undefined;
    await ledger.update(options.job.id, {
      status: "failed",
      currentStep: fallback ? "fallback summary sent" : "failed",
      failureKind: classifyRunJobFailure(message),
      errorSummary: message,
      finalOutputSummary: fallback
    });
    if (chatId) {
      const output = fallback ?? formatTelegramUpdateFailure(message);
      for (const chunk of chunkTelegramMessage(output, options.policy.connectors.telegram.messageChunkChars)) {
        await options.client.sendMessage(chatId, chunk);
      }
    }
  } finally {
    stopTyping();
  }
}

function latestTelegramChatState(state: TelegramGatewayState, job: RunJobRecord): GatewayChatState {
  const chatId = job.source.chatId;
  const existing = chatId ? state.chats[chatId] : undefined;
  return {
    providerId: job.providerId ?? existing?.providerId,
    ...existing,
    activeSessionId: existing?.activeSessionId ?? job.sessionId
  };
}

function shouldPersistTelegramChatState(state: GatewayChatState): boolean {
  return Boolean(
    state.activeSessionId
    || state.pendingCommand
    || state.pendingToolGrowthRequest
    || state.currentToolGrowthRoutineId
  );
}

function nextTelegramChats(chats: TelegramGatewayState["chats"], chatId: string, state: GatewayChatState): TelegramGatewayState["chats"] {
  const next = { ...chats };
  if (shouldPersistTelegramChatState(state)) {
    next[chatId] = state;
  } else {
    delete next[chatId];
  }
  return next;
}

async function persistTelegramChatState(
  workspaceRoot: string,
  stateRef: TelegramGatewayState,
  chatId: string | undefined,
  chatState: GatewayChatState
): Promise<void> {
  if (!chatId) {
    return;
  }
  const latest = await loadTelegramGatewayState(workspaceRoot);
  const current = latest.chats[chatId] ?? stateRef.chats[chatId] ?? {};
  const nextChat = {
    ...current,
    ...chatState,
    activeSessionId: current.activeSessionId ?? chatState.activeSessionId,
    updatedAt: new Date().toISOString()
  };
  const nextState = {
    ...latest,
    chats: {
      ...latest.chats,
      [chatId]: nextChat
    },
    updatedAt: new Date().toISOString()
  };
  stateRef.chats = {
    ...stateRef.chats,
    [chatId]: nextChat
  };
  stateRef.updatedAt = nextState.updatedAt;
  await saveTelegramGatewayState(workspaceRoot, nextState);
}

function classifyRunJobFailure(message: string) {
  if (isTimeoutFailure(message)) return "timeout" as const;
  if (/tool/i.test(message)) return "tool_error" as const;
  if (/provider/i.test(message)) return "provider_error" as const;
  return "unknown" as const;
}

function isTimeoutFailure(message: string): boolean {
  return /timeout|timed out/i.test(message);
}

function formatTimeoutFallback(toolResultSummary: string): string {
  const parsed = parseReviewInboxToolResult(toolResultSummary);
  if (parsed) {
    return [
      "[PARTIAL SUCCESS] 도구 조회는 성공했지만 LLM 최종 응답이 timeout되어, COSIA가 확보한 중간 결과만 요약합니다.",
      "",
      "확인된 결과:",
      `- Memory pending: ${parsed.memoryPending}`,
      `- Skill pending: ${parsed.skillPending}`,
      ...parsed.items.map((item) => `- ${item.id} ${item.risk}: ${item.summary}`)
    ].join("\n");
  }
  return [
    "[PARTIAL SUCCESS] 도구 조회는 성공했지만 LLM 최종 응답이 timeout되어, COSIA가 확보한 중간 결과만 요약합니다.",
    "",
    toolResultSummary
  ].join("\n");
}

async function sendForegroundGatewayFailure(
  client: TelegramMessageSender,
  chatId: string,
  policy: PolicyConfig,
  error: unknown,
  lastToolResultSummary: string | undefined
): Promise<void> {
  const message = (error as Error).message;
  const output = isTimeoutFailure(message) && lastToolResultSummary
    ? formatTimeoutFallback(lastToolResultSummary)
    : formatTelegramUpdateFailure(message);
  for (const chunk of chunkTelegramMessage(output, policy.connectors.telegram.messageChunkChars)) {
    await client.sendMessage(chatId, chunk);
  }
}

function parseReviewInboxToolResult(toolResultSummary: string): {
  memoryPending: number;
  skillPending: number;
  items: Array<{ id: string; risk: string; summary: string }>;
} | undefined {
  const okMarker = "\nOK: true\n";
  const markerStart = toolResultSummary.indexOf(okMarker);
  const resultText = markerStart >= 0
    ? toolResultSummary.slice(markerStart + okMarker.length)
    : toolResultSummary;
  const start = resultText.indexOf("{");
  if (start < 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(resultText.slice(start)) as {
      memoryPending?: number;
      skillPending?: number;
      items?: Array<{ id?: string; risk?: string; summary?: string }>;
    };
    if (typeof parsed.memoryPending !== "number" || typeof parsed.skillPending !== "number") {
      return undefined;
    }
    return {
      memoryPending: parsed.memoryPending,
      skillPending: parsed.skillPending,
      items: (parsed.items ?? []).map((item) => ({
        id: item.id ?? "unknown",
        risk: item.risk ?? "unknown",
        summary: item.summary ?? ""
      }))
    };
  } catch {
    return undefined;
  }
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

export async function inspectTelegramGatewayState(workspaceRoot: string): Promise<TelegramStateInspection> {
  const state = await loadTelegramGatewayState(workspaceRoot);
  const staleSessions: TelegramStateIssue[] = [];
  for (const [chatId, chatState] of Object.entries(state.chats)) {
    if (chatState.activeSessionId && !(await telegramSessionExists(workspaceRoot, chatState.activeSessionId))) {
      staleSessions.push({
        chatId,
        sessionId: chatState.activeSessionId,
        kind: "missing_session"
      });
    }
  }
  return {
    chatCount: Object.keys(state.chats).length,
    staleSessions
  };
}

export async function repairTelegramGatewayState(
  workspaceRoot: string,
  options: { staleSessions?: boolean } = {}
): Promise<TelegramStateRepairResult> {
  if (!options.staleSessions) {
    throw new Error("No Telegram state repair selected. Use --stale-sessions.");
  }
  const state = await loadTelegramGatewayState(workspaceRoot);
  const now = new Date().toISOString();
  const clearedSessionIds: string[] = [];
  const nextChats: Record<string, GatewayChatState> = {};

  for (const [chatId, chatState] of Object.entries(state.chats)) {
    if (chatState.activeSessionId && !(await telegramSessionExists(workspaceRoot, chatState.activeSessionId))) {
      clearedSessionIds.push(chatState.activeSessionId);
      nextChats[chatId] = {
        ...chatState,
        activeSessionId: undefined,
        pendingCommand: undefined,
        updatedAt: now
      };
      continue;
    }
    nextChats[chatId] = chatState;
  }

  const repaired = clearedSessionIds.length > 0;
  if (repaired) {
    await saveTelegramGatewayState(workspaceRoot, {
      ...state,
      chats: nextChats,
      failureCount: shouldClearFailure(state.lastFailure, clearedSessionIds) ? 0 : state.failureCount,
      lastFailure: shouldClearFailure(state.lastFailure, clearedSessionIds) ? undefined : state.lastFailure,
      updatedAt: now
    });
  }

  return {
    checkedChats: Object.keys(state.chats).length,
    staleSessionsFound: clearedSessionIds.length,
    staleSessionsCleared: clearedSessionIds.length,
    repaired,
    clearedSessionIds: [...new Set(clearedSessionIds)],
    preservedNextOffset: state.nextOffset,
    note: repaired
      ? "Cleared missing active session references. Restart a running gateway for the in-memory state to refresh."
      : "No stale Telegram active session references found."
  };
}

export async function resetTelegramGatewayState(
  workspaceRoot: string,
  options: { preserveOffset?: boolean } = {}
): Promise<TelegramStateResetResult> {
  const state = await loadTelegramGatewayState(workspaceRoot);
  const preserveOffset = options.preserveOffset ?? true;
  const nextOffset = preserveOffset ? state.nextOffset : undefined;
  await saveTelegramGatewayState(workspaceRoot, {
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    chats: {},
    failureCount: 0,
    updatedAt: new Date().toISOString()
  });
  return {
    removedChats: Object.keys(state.chats).length,
    preservedNextOffset: nextOffset,
    reset: true,
    note: preserveOffset
      ? "Telegram runtime chat state reset. Update offset was preserved to avoid replaying old Telegram updates."
      : "Telegram runtime chat state reset. Update offset was cleared."
  };
}

export async function formatGatewayStatus(workspaceRoot: string, options: { json?: boolean } = {}): Promise<string> {
  const state = await loadTelegramGatewayState(workspaceRoot);
  const lock = await readGatewayProcessLock(workspaceRoot);
  const legacyLock = await readLegacyTelegramProcessLock(workspaceRoot);
  const processLocked = Boolean(lock);
  const lockStale = isGatewayProcessLockStale(lock, workspaceRoot, Date.now());
  const legacyLockStale = isGatewayProcessLockStale(legacyLock, workspaceRoot, Date.now(), 120000, "telegram");
  const policy = await new PolicyManager(workspaceRoot).loadPolicy();
  const auth = gatewayAuthSummary(policy);
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
      authChatCount: auth.chatCount,
      masterConfigured: auth.masterConfigured,
      guestBindings: auth.guestBindings,
      adminBindings: auth.adminBindings,
      legacyWarning: auth.legacyWarning,
      groupMode: policy.connectors.telegram.groupMode,
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
    `  Authorized chats: ${auth.chatCount}`,
    `  Master configured: ${auth.masterConfigured}`,
    `  Guest bindings: ${auth.guestBindings}`,
    `  Admin bindings: ${auth.adminBindings}`,
    auth.legacyWarning ? `  Warning: ${auth.legacyWarning}` : undefined,
    `  Group mode: ${policy.connectors.telegram.groupMode}`,
    `  Active chats: ${Object.keys(state.chats).length}`,
    `  Next offset: ${state.nextOffset ?? "none"}`,
    `  Failure count: ${state.failureCount}`,
    state.lastFailure ? `  Last failure: ${state.lastFailure}` : undefined,
    legacyLock ? `  Legacy lock: present${legacyLockStale ? " stale" : ""}` : undefined
  ].filter(Boolean).join("\n");
}

export function formatTelegramStateInspection(result: TelegramStateInspection): string {
  return [
    "Telegram gateway state",
    `Active chats: ${result.chatCount}`,
    `Stale active sessions: ${result.staleSessions.length}`,
    ...result.staleSessions.map((issue) => `- chat ${issue.chatId}: missing session ${issue.sessionId}`),
    result.staleSessions.length
      ? "Repair: cosia gateway telegram repair --stale-sessions"
      : undefined
  ].filter(Boolean).join("\n");
}

export function formatTelegramStateRepair(result: TelegramStateRepairResult): string {
  return [
    "Telegram gateway state repair",
    `Repaired: ${result.repaired}`,
    `Checked chats: ${result.checkedChats}`,
    `Stale sessions found: ${result.staleSessionsFound}`,
    `Stale sessions cleared: ${result.staleSessionsCleared}`,
    result.preservedNextOffset !== undefined ? `Preserved next offset: ${result.preservedNextOffset}` : undefined,
    result.clearedSessionIds.length ? `Cleared session ids: ${result.clearedSessionIds.join(", ")}` : undefined,
    `Note: ${result.note}`
  ].filter(Boolean).join("\n");
}

export function formatTelegramStateReset(result: TelegramStateResetResult): string {
  return [
    "Telegram gateway state reset",
    `Reset: ${result.reset}`,
    `Removed chats: ${result.removedChats}`,
    result.preservedNextOffset !== undefined ? `Preserved next offset: ${result.preservedNextOffset}` : undefined,
    `Note: ${result.note}`
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
    result.authChatCount !== undefined ? `Authorized chats: ${result.authChatCount}` : undefined,
    result.masterConfigured !== undefined ? `Master configured: ${result.masterConfigured}` : undefined,
    result.guestBindings !== undefined ? `Guest bindings: ${result.guestBindings}` : undefined,
    result.adminBindings !== undefined ? `Admin bindings: ${result.adminBindings}` : undefined,
    result.legacyWarning ? `Warning: ${result.legacyWarning}` : undefined,
    result.groupMode ? `Group mode: ${result.groupMode}` : undefined,
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

async function telegramSessionExists(workspaceRoot: string, sessionId: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_.-]+$/.test(sessionId)) {
    return false;
  }
  return pathExists(join(workspaceRoot, "sessions", sessionId, "session.json"));
}

function shouldClearFailure(lastFailure: string | undefined, clearedSessionIds: string[]): boolean {
  if (!lastFailure) {
    return false;
  }
  return clearedSessionIds.some((sessionId) => lastFailure.includes(sessionId));
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

function normalizeTelegramAddressedCommand(text: string): string {
  const trimmed = text.trim();
  const addressedSlash = trimmed.match(/^@[A-Za-z0-9_]{5,32}\s+([/#].*)$/);
  if (addressedSlash) {
    return addressedSlash[1].trim();
  }
  return trimmed.replace(/^(\/[A-Za-z0-9_]+)@[A-Za-z0-9_]{5,32}\b/, "$1");
}

function telegramUpdateChatId(update: TelegramUpdate): string | undefined {
  return update.message?.chat.id !== undefined
    ? String(update.message.chat.id)
    : update.callback_query?.message?.chat.id !== undefined
      ? String(update.callback_query.message.chat.id)
      : undefined;
}

function telegramSourceFromMessage(message: NonNullable<TelegramUpdate["message"]>): GatewaySourceContext {
  return {
    connector: "telegram",
    chatId: String(message.chat.id),
    chatType: message.chat.type ?? "private",
    userId: message.from?.id !== undefined ? String(message.from.id) : undefined,
    username: message.from?.username,
    firstName: message.from?.first_name,
    displayName: message.from?.first_name
  };
}

function telegramSourceFromCallback(callback: NonNullable<TelegramUpdate["callback_query"]>): GatewaySourceContext {
  return {
    connector: "telegram",
    chatId: callback.message?.chat.id !== undefined ? String(callback.message.chat.id) : undefined,
    chatType: callback.message?.chat.type ?? "private",
    userId: callback.from?.id !== undefined ? String(callback.from.id) : undefined,
    username: callback.from?.username,
    firstName: callback.from?.first_name,
    displayName: callback.from?.first_name
  };
}

async function withTelegramTyping<T>(
  client: TelegramMessageSender,
  chatId: string,
  task: () => Promise<T>
): Promise<T> {
  const stopTyping = startTelegramTyping(client, chatId);
  try {
    return await task();
  } finally {
    stopTyping();
  }
}

function startTelegramTyping(client: TelegramMessageSender, chatId: string): () => void {
  if (!client.sendChatAction) {
    return () => {};
  }
  let stopped = false;
  const sendTyping = () => {
    if (stopped) return;
    void client.sendChatAction?.(chatId, "typing").catch(() => {
      // Typing indicators are best-effort and should never block the actual response.
    });
  };
  sendTyping();
  const timer = setInterval(sendTyping, TELEGRAM_TYPING_REFRESH_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function notifyTelegramUpdateFailure(
  client: TelegramMessageSender,
  update: TelegramUpdate,
  message: string
): Promise<void> {
  const chatId = telegramUpdateChatId(update);
  if (!chatId) {
    return;
  }
  try {
    for (const chunk of chunkTelegramMessage(formatTelegramUpdateFailure(message), 3500)) {
      await client.sendMessage(chatId, chunk);
    }
  } catch {
    // Failure notifications must not keep an update alive forever.
  }
}

function formatTelegramUpdateFailure(message: string): string {
  return [
    "[FAILED] COSIA could not finish this Telegram request.",
    "",
    previewTelegramFailure(message),
    "",
    "This update was marked handled so it will not retry forever.",
    "Check locally:",
    "  cosia gateway status",
    "  cosia provider profile check"
  ].join("\n");
}

function previewTelegramFailure(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized.length <= 700 ? normalized : `${normalized.slice(0, 700)}... [truncated]`;
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
  if (!input.startsWith("/review")) {
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
