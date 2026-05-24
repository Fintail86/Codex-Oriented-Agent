import { AgentManager } from "./agent_manager.js";
import {
  createCodexAmendmentPendingCommand,
  applyPendingCommand,
  cancelPendingCommand,
  createWriteFileOverwritePendingCommand,
  formatPendingCommand,
  isPendingExpired,
  previewMutationCommand,
  type CommandCatalogContext,
  type PendingCommand
} from "./runtime_command_executor.js";
import { withSessionLock } from "./gateway_locks.js";
import { MemoryManager } from "./memory_manager.js";
import type { PolicyConfig } from "./policy_manager.js";
import { getStatusReport, formatStatusReport } from "./status_report.js";
import { formatReviewInbox, formatReviewNext, formatReviewStats, ReviewInboxService, type ReviewFilter } from "./review_inbox.js";
import { runSession } from "./runner.js";
import { SessionManager } from "./session_manager.js";
import { SkillManager } from "./skill_manager.js";
import { formatToolGrowthStart, ToolGrowthManager } from "./tool_growth.js";
import type { SessionMetadata } from "./types.js";

export type GatewaySourceContext = {
  connector?: "telegram";
  chatId?: string;
  chatType?: string;
  userId?: string;
  username?: string;
  firstName?: string;
};

export type GatewayChatState = {
  activeSessionId?: string;
  providerId?: string;
  pendingCommand?: PendingCommand;
  updatedAt?: string;
};

export type GatewayMessageOptions = {
  workspaceRoot: string;
  input: string;
  state: GatewayChatState;
  policy: PolicyConfig;
  providerId: string;
  owner: string;
  chatId?: string;
  source?: GatewaySourceContext;
  now?: () => number;
};

export type GatewayMessageResult = {
  output: string;
  state: GatewayChatState;
};

export async function handleGatewayMessage(options: GatewayMessageOptions): Promise<GatewayMessageResult> {
  const now = options.now ?? (() => Date.now());
  const input = options.input.trim();
  let state: GatewayChatState = {
    ...options.state,
    providerId: options.state.providerId ?? options.providerId
  };
  if (!input) {
    return done("Send /help for available commands.", state);
  }
  const groupBlock = gatewayGroupBlockReason(options, input);
  if (groupBlock) {
    return done(groupBlock, state);
  }
  const staleSession = await clearMissingActiveSession(options.workspaceRoot, state);
  state = staleSession.state;
  if (staleSession.cleared && !input.startsWith("/") && !input.startsWith("#")) {
    return done(formatMissingActiveSession(staleSession.sessionId), state);
  }
  if (input.startsWith("/")) {
    return handleSlashCommand({ ...options, input, state, now });
  }
  if (input.startsWith("#")) {
    return handleHashCommand({ ...options, input, state, now });
  }
  if (!state.activeSessionId) {
    return done("No active session. Use /sessions, /use <session-id>, or /new <goal>.", state);
  }
  if (state.pendingCommand && looksLikePlainApproval(input)) {
    if (isPendingExpired(state.pendingCommand, now)) {
      return done("[EXPIRED] Pending command expired after 5 minutes. Please run the command again to refresh the preview.", touch({ ...state, pendingCommand: undefined }));
    }
    return done(formatPlainApprovalNeedsApply(state.pendingCommand), state);
  }
  let pendingOverwrite: PendingCommand | undefined;
  let pendingCodexAmendment: PendingCommand | undefined;
  const output = await withSessionLock(options.workspaceRoot, state.activeSessionId, {
    owner: options.owner
  }, async () => runSession(options.workspaceRoot, {
    sessionId: state.activeSessionId!,
    prompt: input,
    providerId: state.providerId,
    sourceChannel: "gateway",
    forceOverwriteApproval: options.source?.connector === "telegram",
    stopAfterOverwriteApprovalRequired: true,
    stopAfterCodexAmendmentRequired: true,
    onOverwriteApprovalRequired: async (request) => {
      pendingOverwrite = await createWriteFileOverwritePendingCommand({
        path: request.path,
        content: request.content,
        workspaceRoot: options.workspaceRoot,
        now,
        ctx: await buildCatalogContext({ ...options, state, now })
      });
    },
    onCodexAmendmentRequired: async (request) => {
      pendingCodexAmendment = await createCodexAmendmentPendingCommand({
        path: request.path,
        content: request.content,
        reason: "Model requested a protected Codex law change through write_file.",
        workspaceRoot: options.workspaceRoot,
        now,
        ctx: await buildCatalogContext({ ...options, state, now })
      });
      return pendingCodexAmendment.preview;
    },
    onEvent: () => undefined
  }));
  if (pendingCodexAmendment) {
    return done(pendingCodexAmendment.preview, touch({ ...state, pendingCommand: pendingCodexAmendment }));
  }
  if (pendingOverwrite) {
    return done(pendingOverwrite.preview, touch({ ...state, pendingCommand: pendingOverwrite }));
  }
  return done(output, state);
}

export function formatGatewayHelp(): string {
  return [
    "COSIA Telegram Gateway commands:",
    "  /help                 Show this help.",
    "  /whoami               Show Telegram chat/user ids for local setup.",
    "  /status               Show compact COSIA status.",
    "  /sessions             List sessions.",
    "  /use <session-id>     Select active session for this chat.",
    "  /new <goal>           Create a session with the default agent.",
    "  /review               Show memory/skill review inbox.",
    "  /review memory|skill  Filter review inbox.",
    "  /tool grow <request>  Start a guided reusable-tool routine.",
    "  /cancel               Cancel pending mutation preview.",
    "  /apply                Apply pending mutation preview.",
    "",
    "Notes:",
    "  # command shortcuts were removed. Use slash commands or plain natural language.",
    "",
    "Plain text is sent to the active COSIA session."
  ].join("\n");
}

type GatewayInputSafety = "read_only" | "state_change" | "mutation" | "session_run" | "unknown";

function gatewayGroupBlockReason(options: GatewayMessageOptions, input: string): string | undefined {
  const source = options.source;
  if (source?.connector !== "telegram" || !isTelegramGroupType(source.chatType)) {
    return undefined;
  }
  if (isGatewayWhoamiInput(input)) {
    return undefined;
  }

  const safety = classifyGatewayInputSafety(input, options.workspaceRoot);
  if (safety === "read_only") {
    return undefined;
  }

  const config = options.policy.connectors.telegram;
  if (config.groupMode === "read_only") {
    return formatTelegramGroupBlocked(source, "Telegram group chats are read-only by default.");
  }

  if (safety === "unknown") {
    return formatTelegramGroupBlocked(source, "Only recognized read-only or explicitly authorized group commands are allowed.");
  }

  if (safety === "mutation") {
    if (!config.allowMutations) {
      return formatTelegramGroupBlocked(source, "Telegram mutations are disabled by policy.");
    }
    if (!source.userId) {
      return formatTelegramGroupBlocked(source, "Telegram did not provide a sender user id, so mutation approval is blocked.");
    }
    if (!config.mutationUserIds.includes(source.userId)) {
      return formatTelegramGroupBlocked(source, "This Telegram user is not allowed to approve mutations.");
    }
    return undefined;
  }

  if (safety === "state_change" || safety === "session_run") {
    if (!source.userId) {
      return formatTelegramGroupBlocked(source, "Telegram did not provide a sender user id, so state-changing group interaction is blocked.");
    }
    if (!config.allowedUserIds.includes(source.userId)) {
      return formatTelegramGroupBlocked(source, "This Telegram user is not allowed to run state-changing group interactions.");
    }
  }

  return undefined;
}

function classifyGatewayInputSafety(input: string, workspaceRoot: string): GatewayInputSafety {
  if (input.startsWith("/")) {
    if (isReadOnlySlashCommand(input)) return "read_only";
    if (input === "/apply" || input === "/cancel" || input.startsWith("/review cleanup") || input.startsWith("/review promote ") || input.startsWith("/review discard ")) {
      return "mutation";
    }
    if (input.startsWith("/new ") || input.startsWith("/use ") || input.startsWith("/tool grow ")) {
      return "state_change";
    }
    return "unknown";
  }
  if (input.startsWith("#")) {
    return "unknown";
  }
  return "session_run";
}

function isReadOnlySlashCommand(input: string): boolean {
  return input === "/help"
    || input === "/whoami"
    || input === "/status"
    || input === "/sessions"
    || input === "/pending"
    || input === "/review"
    || input === "/review memory"
    || input === "/review skill"
    || input === "/review stats"
    || input === "/review next"
    || input.startsWith("/review show ")
    || input.startsWith("/review conflicts ");
}

function isTelegramGroupType(chatType: string | undefined): boolean {
  return Boolean(chatType && chatType !== "private");
}

function formatTelegramGroupBlocked(source: GatewaySourceContext, reason: string): string {
  return [
    "[BLOCKED] Telegram group safety gate.",
    reason,
    `Chat id: ${source.chatId ?? "unknown"}`,
    `Chat type: ${source.chatType ?? "unknown"}`,
    `User id: ${source.userId ?? "unknown"}`,
    "",
    "Use /whoami in Telegram to confirm ids.",
    "",
    "Local setup:",
    source.chatId ? `  cosia gateway telegram set chat-id ${source.chatId}` : "  cosia gateway telegram set chat-id <chat-id>",
    source.userId ? `  cosia gateway telegram set user-id ${source.userId}` : "  cosia gateway telegram set user-id <user-id>",
    source.userId ? `  cosia gateway telegram set mutation-user-id ${source.userId}` : "  cosia gateway telegram set mutation-user-id <user-id>",
    "  cosia gateway telegram set group-mode allowed-users"
  ].join("\n");
}

async function handleSlashCommand(options: GatewayMessageOptions & {
  input: string;
  state: GatewayChatState;
  now: () => number;
}): Promise<GatewayMessageResult> {
  const { input, state } = options;
  if (input === "/help") {
    return done(formatGatewayHelp(), state);
  }
  if (input === "/whoami") {
    return done(formatGatewayWhoami(options.source ?? { chatId: options.chatId, chatType: "private" }), state);
  }
  if (input === "/status") {
    return done(formatStatusReport(await getStatusReport(options.workspaceRoot, state.providerId ?? options.providerId), { compact: true }), state);
  }
  if (input === "/sessions") {
    return done(formatGatewaySessions(await new SessionManager(options.workspaceRoot).listSessions(), state.activeSessionId), state);
  }
  if (input.startsWith("/use ")) {
    const sessionId = input.slice("/use ".length).trim();
    if (!sessionId) return done("Usage: /use <session-id>", state);
    const session = await new SessionManager(options.workspaceRoot).loadSession(sessionId);
    return done(`Active session set to ${session.id}.`, touch({ ...state, activeSessionId: session.id }));
  }
  if (input.startsWith("/new ")) {
    const goal = input.slice("/new ".length).trim();
    if (!goal) return done("Usage: /new <goal>", state);
    const agentId = options.policy.agents.defaultAgentId;
    if (!agentId) return done("No default agent. Run `cosia agent bootstrap` locally first.", state);
    await new AgentManager(options.workspaceRoot).loadAgent(agentId);
    const session = await new SessionManager(options.workspaceRoot).createSession(agentId, goal);
    return done(`Created and selected session ${session.id}.`, touch({ ...state, activeSessionId: session.id }));
  }
  if (input === "/review" || input === "/review memory" || input === "/review skill") {
    const filter: ReviewFilter = input === "/review memory" ? "memory" : input === "/review skill" ? "skill" : "all";
    return done(formatReviewInbox(await new ReviewInboxService(options.workspaceRoot).list(filter)), state);
  }
  if (input === "/review stats") {
    const inbox = new ReviewInboxService(options.workspaceRoot);
    return done(formatReviewStats(await inbox.stats({
      discardedRetentionDays: options.policy.review.discardedRetentionDays,
      pendingWarningDays: options.policy.review.pendingWarningDays
    })), state);
  }
  if (input === "/review cleanup") {
    const ctx = await buildCatalogContext(options);
    const preview = await previewMutationCommand({
      type: "matched",
      commandId: "review.cleanup",
      confidence: "high",
      args: {}
    }, ctx);
    return done(preview?.output ?? "[BLOCKED] Review cleanup is unavailable.", preview?.pending ? touch({ ...state, pendingCommand: preview.pending }) : state);
  }
  if (input === "/review next") {
    const inbox = await new ReviewInboxService(options.workspaceRoot).list("all");
    return done(formatReviewNext(inbox.items[0]), state);
  }
  if (input.startsWith("/review show ")) {
    return done(await new ReviewInboxService(options.workspaceRoot).formatItemDetail(input.slice("/review show ".length).trim()), state);
  }
  if (input.startsWith("/review conflicts ")) {
    return done(await new ReviewInboxService(options.workspaceRoot).formatConflicts(input.slice("/review conflicts ".length).trim()), state);
  }
  if (input.startsWith("/review promote ")) {
    const parts = input.slice("/review promote ".length).trim().split(/\s+/);
    const target = parts[0];
    const ctx = await buildCatalogContext(options);
    const preview = await previewMutationCommand({
      type: "matched",
      commandId: "review.promote_skill",
      confidence: "high",
      args: { target }
    }, ctx);
    return done(preview?.output ?? "[BLOCKED] Review promote preview is unavailable.", preview?.pending ? touch({ ...state, pendingCommand: preview.pending }) : state);
  }
  if (input.startsWith("/review discard ")) {
    const match = input.match(/^\/review\s+discard\s+(\S+)(?:\s+--reason\s+(.+))?$/);
    if (!match?.[2]) {
      return done("[BLOCKED] Usage: /review discard <id> --reason <reason>", state);
    }
    const ctx = await buildCatalogContext(options);
    const preview = await previewMutationCommand({
      type: "matched",
      commandId: "review.discard",
      confidence: "high",
      args: { target: match[1], reason: match[2].trim() }
    }, ctx);
    return done(preview?.output ?? "[BLOCKED] Review discard preview is unavailable.", preview?.pending ? touch({ ...state, pendingCommand: preview.pending }) : state);
  }
  if (input === "/cancel") {
    if (!state.pendingCommand) {
      return done("[SUCCESS] Pending command cancelled.", touch({ ...state, pendingCommand: undefined }));
    }
    const output = await cancelGatewayPending(options);
    return done(output, touch({ ...state, pendingCommand: undefined }));
  }
  if (input === "/pending") {
    const pending = state.pendingCommand;
    if (!pending) return done("[BLOCKED] 적용할 대기 작업이 없습니다.", state);
    if (isPendingExpired(pending, options.now)) {
      return done("[EXPIRED] Pending command expired after 5 minutes. Please run the command again to refresh the preview.", touch({ ...state, pendingCommand: undefined }));
    }
    return done(formatPendingCommand(pending, options.now), state);
  }
  if (input === "/apply") {
    return applyGatewayPending(options);
  }
  if (input.startsWith("/tool grow ")) {
    const request = input.slice("/tool grow ".length).trim();
    if (!request) return done("Usage: /tool grow <request>", state);
    const agentId = state.activeSessionId
      ? (await new SessionManager(options.workspaceRoot).loadSession(state.activeSessionId)).assignedAgentId ?? options.policy.agents.defaultAgentId
      : options.policy.agents.defaultAgentId;
    if (!agentId) return done("No default agent. Run `cosia agent bootstrap` locally first.", state);
    const result = await new ToolGrowthManager(options.workspaceRoot).start({
      request,
      agentId,
      providerId: state.providerId ?? options.providerId
    });
    return done(formatToolGrowthStart(result), state);
  }
  return done(`Unknown Telegram gateway command: ${input}\n\n${formatGatewayHelp()}`, state);
}

async function handleHashCommand(options: GatewayMessageOptions & {
  input: string;
  state: GatewayChatState;
  now: () => number;
}): Promise<GatewayMessageResult> {
  return done(formatHashCommandRemovedNotice(), options.state);
}

export function isGatewayWhoamiInput(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized === "/whoami";
}

export function formatGatewayWhoami(source: GatewaySourceContext): string {
  const chatId = source.chatId ?? "unknown";
  const userId = source.userId ?? "unknown";
  return [
    "Telegram identity",
    `Chat id: ${chatId}`,
    `Chat type: ${source.chatType ?? "private"}`,
    `User id: ${userId}`,
    source.username ? `Username: @${source.username}` : undefined,
    source.firstName ? `Name: ${source.firstName}` : undefined,
    "",
    "Local setup hints:",
    `  cosia gateway telegram set chat-id ${chatId}`,
    source.userId ? `  cosia gateway telegram set user-id ${source.userId}` : "  cosia gateway telegram set user-id <user-id>",
    source.userId ? `  cosia gateway telegram set mutation-user-id ${source.userId}` : "  cosia gateway telegram set mutation-user-id <user-id>",
    "  cosia gateway telegram set group-mode allowed-users"
  ].filter(Boolean).join("\n");
}

async function applyGatewayPending(options: GatewayMessageOptions & {
  state: GatewayChatState;
  now: () => number;
}): Promise<GatewayMessageResult> {
  const pending = options.state.pendingCommand;
  if (!pending) return done("[BLOCKED] 적용할 대기 작업이 없습니다.", options.state);
  if (isPendingExpired(pending, options.now)) {
    return done("[EXPIRED] Pending command expired after 5 minutes. Please run the command again to refresh the preview.", touch({ ...options.state, pendingCommand: undefined }));
  }
  if (!options.policy.connectors.telegram.allowMutations) {
    return done("[BLOCKED] Telegram mutations are disabled by policy.", options.state);
  }
  const activeSessionId = options.state.activeSessionId;
  if (!activeSessionId) {
    return done("[BLOCKED] No active session. Use /use <session-id> first.", options.state);
  }
  const output = await withSessionLock(options.workspaceRoot, activeSessionId, {
    owner: options.owner
  }, async () => applyPendingCommand(pending, await buildCatalogContext(options)));
  return done(output, touch({ ...options.state, pendingCommand: undefined }));
}

async function cancelGatewayPending(options: GatewayMessageOptions & {
  state: GatewayChatState;
  now: () => number;
}): Promise<string> {
  const pending = options.state.pendingCommand;
  if (!pending) {
    return "[SUCCESS] Pending command cancelled.";
  }
  return cancelPendingCommand(pending, await buildCatalogContext(options));
}

async function buildCatalogContext(options: GatewayMessageOptions & {
  state: GatewayChatState;
  now: () => number;
}): Promise<CommandCatalogContext> {
  const sessions = new SessionManager(options.workspaceRoot);
  const activeSessionId = options.state.activeSessionId;
  let session = activeSessionId ? await loadSessionIfPresent(sessions, activeSessionId) : undefined;
  if (!session) {
    const list = await sessions.listSessions();
    session = list.find((item) => item.status === "active") ?? list[0];
  }
  if (!session) {
    throw new Error("No session exists. Use /new <goal> first.");
  }
  const agentId = session.assignedAgentId ?? options.policy.agents.defaultAgentId;
  if (!agentId) throw new Error("No agent is assigned. Use /new <goal> or assign a session locally.");
  const agent = await new AgentManager(options.workspaceRoot).loadAgent(agentId);
  return {
    workspaceRoot: options.workspaceRoot,
    session,
    agent,
    providerId: options.state.providerId ?? options.providerId,
    policy: options.policy,
    sessions,
    memory: new MemoryManager(options.workspaceRoot),
    skills: new SkillManager(options.workspaceRoot),
    reviewInbox: new ReviewInboxService(options.workspaceRoot),
    now: options.now,
    previewScope: {
      chatId: options.chatId,
      sessionId: session.id
    }
  };
}

function formatGatewaySessions(sessions: Awaited<ReturnType<SessionManager["listSessions"]>>, activeSessionId: string | undefined): string {
  if (!sessions.length) return "No sessions. Use /new <goal>.";
  return sessions
    .map((session) => `${session.id === activeSessionId ? "*" : " "} ${session.id}\t${session.assignedAgentId ?? "unassigned"}\t${session.status}\t${session.updatedAt}\t${session.goal}`)
    .join("\n");
}

function done(output: string, state: GatewayChatState): GatewayMessageResult {
  return { output, state };
}

function touch(state: GatewayChatState): GatewayChatState {
  return { ...state, updatedAt: new Date().toISOString() };
}

async function clearMissingActiveSession(
  workspaceRoot: string,
  state: GatewayChatState
): Promise<{ state: GatewayChatState; cleared: boolean; sessionId?: string }> {
  const sessionId = state.activeSessionId;
  if (!sessionId) {
    return { state, cleared: false };
  }
  try {
    await new SessionManager(workspaceRoot).loadSession(sessionId);
    return { state, cleared: false };
  } catch (error) {
    if (!isMissingSessionError(error)) {
      throw error;
    }
    return {
      state: touch({
        ...state,
        activeSessionId: undefined,
        pendingCommand: undefined
      }),
      cleared: true,
      sessionId
    };
  }
}

async function loadSessionIfPresent(sessions: SessionManager, sessionId: string): Promise<SessionMetadata | undefined> {
  try {
    return await sessions.loadSession(sessionId);
  } catch (error) {
    if (isMissingSessionError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isMissingSessionError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function formatMissingActiveSession(sessionId: string | undefined): string {
  return [
    "The active COSIA session for this Telegram chat no longer exists.",
    sessionId ? `Missing session: ${sessionId}` : undefined,
    "",
    "Start a new Telegram session:",
    "/new <goal>",
    "",
    "Or select an existing session:",
    "/sessions",
    "/use <session-id>"
  ].filter(Boolean).join("\n");
}

function looksLikePlainApproval(input: string): boolean {
  return /\b(apply|approve|approved|confirm)\b/i.test(input)
    || /(승인|적용|동의|진행)/.test(input);
}

function formatPlainApprovalNeedsApply(pending: PendingCommand): string {
  return [
    "승인 대기 작업이 있습니다.",
    `Pending command: ${pending.commandId}`,
    "",
    "대화 문장만으로는 파일 변경을 적용하지 않습니다.",
    "실제로 적용하려면 다음 중 하나를 보내주세요:",
    "  /apply",
    "",
    "취소하려면:",
    "  /cancel"
  ].join("\n");
}

function formatHashCommandRemovedNotice(): string {
  return [
    "Hash command shortcuts were removed.",
    "Use slash commands for explicit runtime actions:",
    "  /status",
    "  /review",
    "  /sessions",
    "  /pending",
    "  /apply",
    "  /cancel",
    "  /tool grow <request>",
    "",
    "Or send plain natural language without #."
  ].join("\n");
}
