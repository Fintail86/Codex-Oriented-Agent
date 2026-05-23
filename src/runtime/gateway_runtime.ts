import { AgentManager } from "./agent_manager.js";
import {
  applyPendingCommand,
  executeReadOnlyCommand,
  formatAmbiguousCommand,
  formatNeedsInput,
  formatPendingCommand,
  isPendingExpired,
  previewMutationCommand,
  type CommandCatalogContext,
  type PendingCommand
} from "./command_catalog.js";
import { interpretHashCommand } from "./command_interpreter.js";
import { parseHashCommand, retrieveCommandCandidates } from "./command_intent.js";
import { withSessionLock } from "./gateway_locks.js";
import { MemoryManager } from "./memory_manager.js";
import type { PolicyConfig } from "./policy_manager.js";
import { getStatusReport, formatStatusReport } from "./status_report.js";
import { formatReviewInbox, formatReviewNext, formatReviewStats, ReviewInboxService, type ReviewFilter } from "./review_inbox.js";
import { runSession } from "./runner.js";
import { SessionManager } from "./session_manager.js";
import { SkillManager } from "./skill_manager.js";

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
  now?: () => number;
};

export type GatewayMessageResult = {
  output: string;
  state: GatewayChatState;
};

export async function handleGatewayMessage(options: GatewayMessageOptions): Promise<GatewayMessageResult> {
  const now = options.now ?? (() => Date.now());
  const input = options.input.trim();
  const state = {
    ...options.state,
    providerId: options.state.providerId ?? options.providerId
  };
  if (!input) {
    return done("Send /help for available commands.", state);
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
  const output = await withSessionLock(options.workspaceRoot, state.activeSessionId, {
    owner: options.owner
  }, async () => runSession(options.workspaceRoot, {
    sessionId: state.activeSessionId!,
    prompt: input,
    providerId: state.providerId,
    sourceChannel: "gateway",
    onEvent: () => undefined
  }));
  return done(output, state);
}

export function formatGatewayHelp(): string {
  return [
    "COSIA Telegram Gateway commands:",
    "  /help                 Show this help.",
    "  /status               Show compact COSIA status.",
    "  /sessions             List sessions.",
    "  /use <session-id>     Select active session for this chat.",
    "  /new <goal>           Create a session with the default agent.",
    "  /review               Show memory/skill review inbox.",
    "  /review memory|skill  Filter review inbox.",
    "  /cancel               Cancel pending mutation preview.",
    "  /apply                Apply pending mutation preview.",
    "",
    "Natural runtime commands:",
    "  #상태 보여줘",
    "  #리뷰 보여줘",
    "  #컨플릭트 메모리 전부 디스카드해 이유는 중복",
    "  #적용",
    "  #취소",
    "",
    "Plain text is sent to the active COSIA session."
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
    return done("[SUCCESS] Pending command cancelled.", touch({ ...state, pendingCommand: undefined }));
  }
  if (input === "/apply") {
    return applyGatewayPending(options);
  }
  return done(`Unknown Telegram gateway command: ${input}\n\n${formatGatewayHelp()}`, state);
}

async function handleHashCommand(options: GatewayMessageOptions & {
  input: string;
  state: GatewayChatState;
  now: () => number;
}): Promise<GatewayMessageResult> {
  let intent = parseHashCommand(options.input);
  if (intent.type === "no_match") {
    const candidates = retrieveCommandCandidates(options.input, 8, options.workspaceRoot);
    if (!candidates.length) {
      return done("[BLOCKED] Natural command not recognized. Try #상태 보여줘, #리뷰 보여줘, or /help.", options.state);
    }
    intent = await interpretHashCommand({
      input: options.input,
      candidates,
      workspaceRoot: options.workspaceRoot,
      providerId: options.state.providerId ?? options.providerId,
      policy: options.policy,
      sessionId: options.state.activeSessionId ?? "gateway"
    });
  }
  if (intent.type === "needs_input") {
    return done(formatNeedsInput(intent.commandId, intent.missing, intent.hint), options.state);
  }
  if (intent.type === "ambiguous") {
    return done(formatAmbiguousCommand(intent.candidates, intent.hint), options.state);
  }
  if (intent.type === "no_match") {
    return done("[BLOCKED] Natural command not recognized. Try #상태 보여줘, #리뷰 보여줘, or /help.", options.state);
  }
  if (intent.commandId === "pending.cancel") {
    return done("[SUCCESS] Pending command cancelled.", touch({ ...options.state, pendingCommand: undefined }));
  }
  if (intent.commandId === "pending.show") {
    const pending = options.state.pendingCommand;
    if (!pending) return done("[BLOCKED] 적용할 대기 작업이 없습니다.", options.state);
    if (isPendingExpired(pending, options.now)) {
      return done("[EXPIRED] Pending command expired after 5 minutes. Please run the command again to refresh the preview.", touch({ ...options.state, pendingCommand: undefined }));
    }
    return done(formatPendingCommand(pending, options.now), options.state);
  }
  if (intent.commandId === "pending.apply") {
    return applyGatewayPending(options);
  }

  const sessionFree = await executeSessionFreeReadOnly(intent, options);
  if (sessionFree !== undefined) {
    return done(sessionFree, options.state);
  }
  const ctx = await buildCatalogContext(options);
  const readOnly = await executeReadOnlyCommand(intent, ctx);
  if (readOnly !== undefined) {
    return done(readOnly, options.state);
  }
  const preview = await previewMutationCommand(intent, ctx);
  if (preview?.pending) {
    return done(preview.output, touch({ ...options.state, pendingCommand: preview.pending }));
  }
  if (preview?.output) {
    return done(preview.output, options.state);
  }
  return done("[BLOCKED] This natural command is recognized but is not available through the gateway yet.", options.state);
}

async function executeSessionFreeReadOnly(intent: Extract<ReturnType<typeof parseHashCommand>, { type: "matched" }>, options: GatewayMessageOptions & {
  state: GatewayChatState;
}): Promise<string | undefined> {
  switch (intent.commandId) {
    case "status.show":
      return formatStatusReport(await getStatusReport(options.workspaceRoot, options.state.providerId ?? options.providerId));
    case "session.list":
      return formatGatewaySessions(await new SessionManager(options.workspaceRoot).listSessions(), options.state.activeSessionId);
    case "review.list":
      return formatReviewInbox(await new ReviewInboxService(options.workspaceRoot).list(intent.args.filter === "memory" || intent.args.filter === "skill" ? intent.args.filter : "all"));
    case "review.next": {
      const inbox = await new ReviewInboxService(options.workspaceRoot).list("all");
      return formatReviewNext(inbox.items[0]);
    }
    case "review.conflicted_memory": {
      const inbox = await new ReviewInboxService(options.workspaceRoot).list("memory");
      return formatReviewInbox({
        ...inbox,
        items: inbox.items.filter((item) => item.conflictCount > 0)
      }, "Conflicted Memory Review");
    }
    case "review.stats": {
      const inbox = new ReviewInboxService(options.workspaceRoot);
      return formatReviewStats(await inbox.stats({
        discardedRetentionDays: options.policy.review.discardedRetentionDays,
        pendingWarningDays: options.policy.review.pendingWarningDays
      }));
    }
    case "memory.search":
      return new MemoryManager(options.workspaceRoot)
        .search(String(intent.args.query ?? ""), 8)
        .map((result) => `${result.record.id.slice(0, 8)} [${result.record.tier}/${result.record.kind}] score:${result.score.toFixed(2)} ${result.record.content}`)
        .join("\n") || "No matches.";
    default:
      return undefined;
  }
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

async function buildCatalogContext(options: GatewayMessageOptions & {
  state: GatewayChatState;
  now: () => number;
}): Promise<CommandCatalogContext> {
  const sessions = new SessionManager(options.workspaceRoot);
  const activeSessionId = options.state.activeSessionId;
  let session = activeSessionId ? await sessions.loadSession(activeSessionId) : undefined;
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
