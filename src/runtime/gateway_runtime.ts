import { AgentManager } from "./agent_manager.js";
import {
  authorizeGatewayInput,
  formatGatewayAuthBlocked,
  formatGatewayWhoami as formatGatewayActorWhoami,
  isWhoamiInput,
  shouldSendGatewayBlockNotice
} from "./gateway_auth.js";
import type { GatewayActor, GatewayRole } from "./gateway_auth_types.js";
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
import { MemoryManager } from "./memory_manager.js";
import type { PolicyConfig } from "./policy_manager.js";
import { formatRunJobCancel, formatRunJobDetail, formatRunJobList, RunJobLedger } from "./run_jobs.js";
import { getStatusReport, formatStatusReport } from "./status_report.js";
import { formatReviewInbox, formatReviewNext, formatReviewStats, ReviewInboxService, type ReviewFilter } from "./review_inbox.js";
import { findGatewayCommandDefinition } from "./gateway_command_registry.js";
import {
  formatGatewayHelp,
  formatGatewayUnknownCommand,
  formatHashCommandRemovedNotice,
  formatUnknownCallbackNotice
} from "./gateway_message_renderer.js";
import { runSession } from "./runner.js";
import { SessionManager } from "./session_manager.js";
import { withSessionLock } from "./gateway_locks.js";
import { SkillManager } from "./skill_manager.js";
import { ToolAcquisitionManager } from "./tool_acquisition.js";
import { toolCatalog } from "./tool_catalog.js";
import {
  formatToolGrowthActivation,
  formatToolGrowthCancelled,
  formatToolGrowthRejected,
  formatToolGrowthReview,
  formatToolGrowthRoutine,
  formatToolGrowthStart,
  formatToolGrowthTest,
  ToolGrowthManager,
  type ToolGrowthRoutine
} from "./tool_growth.js";
import type { PromptBlock } from "./prompt_builder.js";
import type { RunProgressEvent } from "./runner.js";
import type { SessionMetadata, ToolGrowthDecision, ToolGrowthRequest } from "./types.js";

const gatewayToolAssistedProviderTimeoutMs = 300_000;
const gatewayRunJobDeadlineMs = 420_000;

export type GatewaySourceContext = {
  connector?: string;
  chatId?: string;
  chatType?: string;
  messageThreadId?: number | string;
  userId?: string;
  username?: string;
  firstName?: string;
  displayName?: string;
};

export type GatewayChatState = {
  activeSessionId?: string;
  providerId?: string;
  pendingCommand?: PendingCommand;
  pendingToolGrowthRequest?: PendingToolGrowthRequest;
  currentToolGrowthRoutineId?: string;
  updatedAt?: string;
};

export type PendingToolGrowthRequest = ToolGrowthRequest & {
  createdAt: string;
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
  promoteSessionRun?: (input: string, state: GatewayChatState) => Promise<GatewayMessageResult>;
  onRunProgress?: (event: RunProgressEvent) => Promise<void> | void;
  gatewayRole?: GatewayRole;
};

export type GatewayMessageResult = {
  output: string;
  state: GatewayChatState;
};

export type GatewayCallbackActionInput = {
  namespace: string;
  action: string;
  value?: string;
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
  const gatewayAuth = gatewayAuthBlockReason(options, input);
  if (gatewayAuth) {
    return done(gatewayAuth.output, gatewayAuth.state);
  }
  const gatewayRole = resolveGatewayRoleForOptions(options, input);
  const authedOptions = gatewayRole ? { ...options, gatewayRole } : options;
  const staleSession = await clearMissingActiveSession(options.workspaceRoot, state);
  state = staleSession.state;
  if (staleSession.cleared && !input.startsWith("/") && !input.startsWith("#")) {
    return done(formatMissingActiveSession(staleSession.sessionId), state);
  }
  if (input.startsWith("/")) {
    return handleSlashCommand({ ...authedOptions, input, state, now });
  }
  if (input.startsWith("#")) {
    return handleHashCommand({ ...authedOptions, input, state, now });
  }
  if (/^cosia\s+tool\s+grow(?:\s|$)/i.test(input)) {
    return done(formatTelegramCliToolGrowGuidance(input), state);
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
  return runGatewaySessionMessage({ ...authedOptions, input, state, now });
}

async function runGatewaySessionMessage(options: GatewayMessageOptions & {
  input: string;
  state: GatewayChatState;
  now: () => number;
}): Promise<GatewayMessageResult> {
  const { input, state, now } = options;
  let pendingOverwrite: PendingCommand | undefined;
  let pendingCodexAmendment: PendingCommand | undefined;
  let pendingToolGrowthRequest: PendingToolGrowthRequest | undefined;
  let toolGrowthDecision: ToolGrowthDecision | undefined;
  let output: string;
  try {
    output = await runSession(options.workspaceRoot, {
      sessionId: state.activeSessionId!,
      prompt: input,
      providerId: state.providerId,
      sourceChannel: "gateway",
      gatewayActor: sourceToGatewayActor(options.source ?? { chatId: options.chatId, chatType: "private" }),
      gatewayRole: options.gatewayRole,
      providerTimeoutAfterToolMs: options.source?.connector === "telegram" ? gatewayToolAssistedProviderTimeoutMs : undefined,
      runDeadlineMs: options.source?.connector === "telegram" ? gatewayRunJobDeadlineMs : undefined,
      promptStaticBlocks: state.pendingToolGrowthRequest ? [pendingToolGrowthPromptBlock(state.pendingToolGrowthRequest)] : undefined,
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
      onToolGrowthRequested: (request) => {
        pendingToolGrowthRequest = {
          ...request,
          createdAt: new Date(now()).toISOString()
        };
      },
      onToolGrowthDecision: (decision) => {
        toolGrowthDecision = decision;
      },
      onProgress: async (event) => {
        await options.onRunProgress?.(event);
        // OpenClaw-style boundary: ordinary chat and short read-only lookups
        // stay foreground. Durable Gateway jobs are for background-worthy tool
        // work such as writes, shell approvals, or generated/unknown tools.
        if (shouldPromoteGatewayRunForTool(event) && options.promoteSessionRun) {
          throw new GatewayRunPromoted(await options.promoteSessionRun(input, state));
        }
      },
      onEvent: () => undefined
    });
  } catch (error) {
    if (error instanceof GatewayRunPromoted) {
      return error.result;
    }
    throw error;
  }
  if (pendingCodexAmendment) {
    return done(pendingCodexAmendment.preview, touch({ ...state, pendingCommand: pendingCodexAmendment }));
  }
  if (pendingOverwrite) {
    return done(pendingOverwrite.preview, touch({ ...state, pendingCommand: pendingOverwrite }));
  }
  if (toolGrowthDecision && state.pendingToolGrowthRequest) {
    return handleToolGrowthDecisionAfterRun({
      ...options,
      state,
      now,
      output,
      decision: toolGrowthDecision
    });
  }
  if (pendingToolGrowthRequest) {
    return done(output, touch({ ...state, pendingToolGrowthRequest }));
  }
  return done(output, state);
}

class GatewayRunPromoted extends Error {
  constructor(readonly result: GatewayMessageResult) {
    super("Gateway run promoted to background job after model selected a tool.");
  }
}

export { formatGatewayHelp };

function gatewayAuthBlockReason(options: GatewayMessageOptions, input: string): { output: string; state: GatewayChatState } | undefined {
  const source = options.source;
  if (!source?.connector) {
    return undefined;
  }
  const actor = sourceToGatewayActor(source);
  const decision = authorizeGatewayInput(options.policy, actor, input);
  if (decision.allowed) {
    return undefined;
  }
  if (isTelegramGroupType(actor.chatType) && !input.startsWith("/")) {
    return { output: "", state: options.state };
  }
  if (!shouldSendGatewayBlockNotice(actor, decision.reason, options.policy.gateway.authorization.unknownBlockThrottleMs, options.now?.() ?? Date.now())) {
    return { output: "", state: options.state };
  }
  return { output: formatGatewayAuthBlocked(actor, decision), state: options.state };
}

function resolveGatewayRoleForOptions(options: GatewayMessageOptions, input: string): GatewayRole | undefined {
  if (!options.source?.connector) {
    return undefined;
  }
  const decision = authorizeGatewayInput(options.policy, sourceToGatewayActor(options.source), input);
  return decision.allowed ? decision.role : undefined;
}

function sourceToGatewayActor(source: GatewaySourceContext): GatewayActor {
  return {
    connector: source.connector ?? "telegram",
    chatId: source.chatId,
    chatType: source.chatType,
    userId: source.userId,
    username: source.username,
    displayName: source.displayName ?? source.firstName
  };
}

function isTelegramGroupType(chatType: string | undefined): boolean {
  return Boolean(chatType && chatType !== "private");
}

async function handleSlashCommand(options: GatewayMessageOptions & {
  input: string;
  state: GatewayChatState;
  now: () => number;
}): Promise<GatewayMessageResult> {
  const { input, state } = options;
  const definition = findGatewayCommandDefinition(input);
  if (!definition) {
    return done(formatGatewayUnknownCommand(input), state);
  }
  switch (definition.id) {
    case "gateway.help":
      return done(formatGatewayHelp(), state);
    case "gateway.whoami":
      return done(formatGatewayWhoami(options.source ?? { chatId: options.chatId, chatType: "private" }), state);
    case "gateway.status":
      return done(formatStatusReport(await getStatusReport(options.workspaceRoot, state.providerId ?? options.providerId), { compact: true }), state);
    case "gateway.sessions":
      return done(formatGatewaySessions(await new SessionManager(options.workspaceRoot).listSessions(), state.activeSessionId), state);
    case "gateway.jobs.list":
      return handleGatewayJobsList(options);
    case "gateway.jobs.show":
      return handleGatewayJobShow(options, input.slice("/job ".length).trim());
    case "gateway.jobs.cancel":
      return handleGatewayJobCancel(options, input.slice("/cancel ".length).trim());
    case "gateway.session.use":
      return handleGatewaySessionUse(options, input.slice("/use ".length).trim());
    case "gateway.session.new":
      return handleGatewaySessionNew(options, input.slice("/new ".length).trim());
    case "gateway.review.list":
    case "gateway.review.filter": {
      const filter: ReviewFilter = input === "/review memory" ? "memory" : input === "/review skill" ? "skill" : "all";
      return handleReviewList(options, filter);
    }
    case "gateway.review.stats":
      return handleReviewStats(options);
    case "gateway.review.cleanup":
      return handleReviewCleanup(options);
    case "gateway.review.next":
      return handleReviewNext(options);
    case "gateway.review.show":
      return handleReviewShow(options, input.slice("/review show ".length).trim());
    case "gateway.review.conflicts":
      return handleReviewConflicts(options, input.slice("/review conflicts ".length).trim());
    case "gateway.review.promote":
      return handleReviewPromote(options, input.slice("/review promote ".length).trim().split(/\s+/)[0]);
    case "gateway.review.discard": {
      const match = input.match(/^\/review\s+discard\s+(\S+)(?:\s+--reason\s+(.+))?$/);
      return handleReviewDiscard(options, match?.[1] ?? "", match?.[2]?.trim() ?? "");
    }
    case "gateway.pending.cancel":
      return handlePendingCancel(options);
    case "gateway.pending.show":
      return handlePendingShow(options);
    case "gateway.pending.apply":
      return applyGatewayPending(options);
    case "gateway.tool_growth":
    case "gateway.tool_growth.test":
    case "gateway.tool_growth.activate":
      return handleToolGrowthGatewayCommand({
        ...options,
        input,
        state,
        now: options.now
      });
    default:
      return done(formatGatewayUnknownCommand(input), state);
  }
}

export async function handleGatewayCallbackAction(options: GatewayMessageOptions & {
  callback: GatewayCallbackActionInput;
  state: GatewayChatState;
  now: () => number;
}): Promise<GatewayMessageResult> {
  const { callback } = options;
  if (callback.namespace !== "review") {
    return done(formatUnknownCallbackNotice(), options.state);
  }
  switch (callback.action) {
    case "refresh":
      return handleReviewList(options, "all");
    case "next":
      return handleReviewNext(options);
    case "show":
      return handleReviewShow(options, callback.value ?? "");
    case "conflicts":
      return handleReviewConflicts(options, callback.value ?? "");
    case "discard":
      return handleReviewDiscard(options, callback.value ?? "", "Telegram review discard");
    case "promote":
      return handleReviewPromote(options, callback.value ?? "");
    default:
      return done(formatUnknownCallbackNotice(), options.state);
  }
}

async function handleGatewayJobsList(options: GatewayMessageOptions & { state: GatewayChatState }): Promise<GatewayMessageResult> {
  const jobs = await new RunJobLedger(options.workspaceRoot).list({
    chatId: options.chatId,
    sessionId: options.state.activeSessionId,
    includeTerminal: false
  });
  return done(formatRunJobList(jobs), options.state);
}

async function handleGatewayJobShow(options: GatewayMessageOptions & { state: GatewayChatState }, jobId: string): Promise<GatewayMessageResult> {
  const job = await new RunJobLedger(options.workspaceRoot).get(jobId);
  return done(job ? formatRunJobDetail(job) : `Run job not found: ${jobId}`, options.state);
}

async function handleGatewayJobCancel(options: GatewayMessageOptions & { state: GatewayChatState }, jobId: string): Promise<GatewayMessageResult> {
  const job = await new RunJobLedger(options.workspaceRoot).requestCancel(jobId);
  return done(formatRunJobCancel(job), options.state);
}

async function handleGatewaySessionUse(
  options: GatewayMessageOptions & { state: GatewayChatState },
  sessionId: string
): Promise<GatewayMessageResult> {
  if (!sessionId) return done("Usage: /use <session-id>", options.state);
  const session = await new SessionManager(options.workspaceRoot).loadSession(sessionId);
  return done(`Active session set to ${session.id}.`, touch({ ...options.state, activeSessionId: session.id }));
}

async function handleGatewaySessionNew(
  options: GatewayMessageOptions & { state: GatewayChatState },
  goal: string
): Promise<GatewayMessageResult> {
  if (!goal) return done("Usage: /new <goal>", options.state);
  const agentId = options.policy.agents.defaultAgentId;
  if (!agentId) return done("No default agent. Run `cosia agent bootstrap` locally first.", options.state);
  await new AgentManager(options.workspaceRoot).loadAgent(agentId);
  const session = await new SessionManager(options.workspaceRoot).createSession(agentId, goal);
  return done(`Created and selected session ${session.id}.`, touch({ ...options.state, activeSessionId: session.id }));
}

async function handleReviewList(
  options: GatewayMessageOptions & { state: GatewayChatState },
  filter: ReviewFilter
): Promise<GatewayMessageResult> {
  return done(formatReviewInbox(await new ReviewInboxService(options.workspaceRoot).list(filter)), options.state);
}

async function handleReviewStats(options: GatewayMessageOptions & { state: GatewayChatState }): Promise<GatewayMessageResult> {
  const inbox = new ReviewInboxService(options.workspaceRoot);
  return done(formatReviewStats(await inbox.stats({
    discardedRetentionDays: options.policy.review.discardedRetentionDays,
    pendingWarningDays: options.policy.review.pendingWarningDays
  })), options.state);
}

async function handleReviewNext(options: GatewayMessageOptions & { state: GatewayChatState }): Promise<GatewayMessageResult> {
  const inbox = await new ReviewInboxService(options.workspaceRoot).list("all");
  return done(formatReviewNext(inbox.items[0]), options.state);
}

async function handleReviewCleanup(options: GatewayMessageOptions & { state: GatewayChatState; now: () => number }): Promise<GatewayMessageResult> {
  const ctx = await buildCatalogContext(options);
  const preview = await previewMutationCommand({
    type: "matched",
    commandId: "review.cleanup",
    confidence: "high",
    args: {}
  }, ctx);
  return done(preview?.output ?? "[BLOCKED] Review cleanup is unavailable.", preview?.pending ? touch({ ...options.state, pendingCommand: preview.pending }) : options.state);
}

async function handleReviewShow(
  options: GatewayMessageOptions & { state: GatewayChatState },
  target: string
): Promise<GatewayMessageResult> {
  return done(await new ReviewInboxService(options.workspaceRoot).formatItemDetail(target), options.state);
}

async function handleReviewConflicts(
  options: GatewayMessageOptions & { state: GatewayChatState },
  target: string
): Promise<GatewayMessageResult> {
  return done(await new ReviewInboxService(options.workspaceRoot).formatConflicts(target), options.state);
}

async function handleReviewPromote(
  options: GatewayMessageOptions & { state: GatewayChatState; now: () => number },
  target: string
): Promise<GatewayMessageResult> {
  const ctx = await buildCatalogContext(options);
  const preview = await previewMutationCommand({
    type: "matched",
    commandId: "review.promote_skill",
    confidence: "high",
    args: { target }
  }, ctx);
  return done(preview?.output ?? "[BLOCKED] Review promote preview is unavailable.", preview?.pending ? touch({ ...options.state, pendingCommand: preview.pending }) : options.state);
}

async function handleReviewDiscard(
  options: GatewayMessageOptions & { state: GatewayChatState; now: () => number },
  target: string,
  reason: string
): Promise<GatewayMessageResult> {
  if (!target || !reason) {
    return done("[BLOCKED] Usage: /review discard <id> --reason <reason>", options.state);
  }
  const ctx = await buildCatalogContext(options);
  const preview = await previewMutationCommand({
    type: "matched",
    commandId: "review.discard",
    confidence: "high",
    args: { target, reason }
  }, ctx);
  return done(preview?.output ?? "[BLOCKED] Review discard preview is unavailable.", preview?.pending ? touch({ ...options.state, pendingCommand: preview.pending }) : options.state);
}

async function handlePendingCancel(options: GatewayMessageOptions & { state: GatewayChatState; now: () => number }): Promise<GatewayMessageResult> {
  if (!options.state.pendingCommand) {
    return done("[SUCCESS] Pending command cancelled.", touch({ ...options.state, pendingCommand: undefined }));
  }
  const output = await cancelGatewayPending(options);
  return done(output, touch({ ...options.state, pendingCommand: undefined }));
}

function handlePendingShow(options: GatewayMessageOptions & { state: GatewayChatState; now: () => number }): GatewayMessageResult {
  const pending = options.state.pendingCommand;
  if (!pending) return done("[BLOCKED] 적용할 대기 작업이 없습니다.", options.state);
  if (isPendingExpired(pending, options.now)) {
    return done("[EXPIRED] Pending command expired after 5 minutes. Please run the command again to refresh the preview.", touch({ ...options.state, pendingCommand: undefined }));
  }
  return done(formatPendingCommand(pending, options.now), options.state);
}

async function handleToolGrowthGatewayCommand(options: GatewayMessageOptions & {
  input: string;
  state: GatewayChatState;
  now: () => number;
}): Promise<GatewayMessageResult> {
  const rest = options.input.slice("/tool grow".length).trim();
  if (!rest) {
    return done([
      "Usage:",
      "  /tool grow <request>",
      "  /tool grow show [routine-id] [--advanced]",
      "  /tool grow test [routine-id] --yes",
      "  /tool grow activate [routine-id] --agent <agent-id> --yes",
      "  /tool grow reject [routine-id] --reason \"<reason>\"",
      "  /tool grow retry [routine-id]",
      "  /tool grow cancel [routine-id] --reason \"<reason>\""
    ].join("\n"), options.state);
  }

  const growth = new ToolGrowthManager(options.workspaceRoot);
  const acquisition = new ToolAcquisitionManager(options.workspaceRoot);
  const tokens = parseGatewayCommandLineArgs(rest);
  const action = tokens[0];
  const state = options.state;
  const providerId = state.providerId ?? options.providerId;

  if (!["review", "show", "test", "activate", "reject", "retry", "cancel"].includes(action)) {
    const agentId = state.activeSessionId
      ? (await new SessionManager(options.workspaceRoot).loadSession(state.activeSessionId)).assignedAgentId ?? options.policy.agents.defaultAgentId
      : options.policy.agents.defaultAgentId;
    if (!agentId) return done("No default agent. Run `cosia agent bootstrap` locally first.", state);
    const result = await growth.start({
      request: rest,
      agentId,
      providerId
    });
    return done(formatToolGrowthStart(result, { surface: "slash" }), touch({
      ...state,
      currentToolGrowthRoutineId: result.routine.id
    }));
  }

  const args = tokens.slice(1);
  const flags = parseGatewayFlagArgs(args);
  if (action === "review") {
    return done(formatToolGrowthReview(growth.list({ all: flags.all === "true" }), {
      advanced: flags.advanced === "true",
      surface: "slash"
    }), state);
  }

  const routineId = resolveGatewayToolGrowthRoutineId(args, state.currentToolGrowthRoutineId);
  if (!routineId) {
    return done("[BLOCKED] Tool growth routine id is required. Use /tool grow review or /tool grow show <routine-id>.", state);
  }

  if (action === "show") {
    const routine = growth.get(routineId);
    const candidate = routine.selectedCandidateId ? acquisition.getCandidate(routine.selectedCandidateId) : undefined;
    return done(formatToolGrowthRoutine(routine, candidate, {
      advanced: flags.advanced === "true",
      surface: "slash"
    }), touch({
      ...state,
      currentToolGrowthRoutineId: updateGatewayToolGrowthRoutineId(state.currentToolGrowthRoutineId, routine)
    }));
  }
  if (action === "test") {
    const result = await growth.test(routineId, { yes: flags.yes === "true" });
    return done(formatToolGrowthTest(result, {
      advanced: flags.advanced === "true",
      surface: "slash"
    }), touch({
      ...state,
      currentToolGrowthRoutineId: updateGatewayToolGrowthRoutineId(state.currentToolGrowthRoutineId, result.routine)
    }));
  }
  if (action === "activate") {
    const result = await growth.activate(routineId, {
      agentId: flags.agent ?? options.policy.agents.defaultAgentId,
      yes: flags.yes === "true"
    });
    return done(formatToolGrowthActivation(result), touch({
      ...state,
      currentToolGrowthRoutineId: updateGatewayToolGrowthRoutineId(state.currentToolGrowthRoutineId, result.routine)
    }));
  }
  if (action === "reject") {
    if (!flags.reason) {
      return done("Usage: /tool grow reject [routine-id] --reason \"<reason>\"", state);
    }
    const routine = growth.reject(routineId, flags.reason);
    return done(formatToolGrowthRejected(routine, { surface: "slash" }), touch({
      ...state,
      currentToolGrowthRoutineId: updateGatewayToolGrowthRoutineId(state.currentToolGrowthRoutineId, routine)
    }));
  }
  if (action === "retry") {
    const result = await growth.retry(routineId, { providerId });
    return done(formatToolGrowthStart(result, { surface: "slash" }), touch({
      ...state,
      currentToolGrowthRoutineId: result.routine.id
    }));
  }
  if (action === "cancel") {
    if (!flags.reason) {
      return done("Usage: /tool grow cancel [routine-id] --reason \"<reason>\"", state);
    }
    const routine = growth.cancel(routineId, flags.reason);
    return done(formatToolGrowthCancelled(routine), touch({
      ...state,
      currentToolGrowthRoutineId: updateGatewayToolGrowthRoutineId(state.currentToolGrowthRoutineId, routine)
    }));
  }

  return done("[BLOCKED] Unknown /tool grow command.", state);
}

async function handleToolGrowthDecisionAfterRun(options: GatewayMessageOptions & {
  state: GatewayChatState;
  now: () => number;
  output: string;
  decision: ToolGrowthDecision;
}): Promise<GatewayMessageResult> {
  const pending = options.state.pendingToolGrowthRequest;
  if (!pending) {
    return done("[BLOCKED] No pending tool creation routine request.", options.state);
  }
  if (options.decision.action === "cancel") {
    return done(options.output, touch({ ...options.state, pendingToolGrowthRequest: undefined }));
  }
  if (options.decision.action !== "start") {
    return done(options.output, options.state);
  }
  const agentId = options.state.activeSessionId
    ? (await new SessionManager(options.workspaceRoot).loadSession(options.state.activeSessionId)).assignedAgentId ?? options.policy.agents.defaultAgentId
    : options.policy.agents.defaultAgentId;
  if (!agentId) {
    return done("No default agent. Run `cosia agent bootstrap` locally first.", options.state);
  }
  const providerId = options.state.providerId ?? options.providerId;
  const result = await new ToolGrowthManager(options.workspaceRoot).start({
    request: pending.request,
    agentId,
    providerId
  });
  return done([
    options.output,
    "",
    formatToolGrowthStart(result, { surface: "slash" })
  ].join("\n"), touch({
    ...options.state,
    pendingToolGrowthRequest: undefined,
    currentToolGrowthRoutineId: result.routine.id
  }));
}

function pendingToolGrowthPromptBlock(pending: PendingToolGrowthRequest): PromptBlock {
  return {
    title: "PENDING TOOL GROWTH REQUEST",
    source: "runtime",
    required: true,
    content: [
      "A previous assistant turn proposed a guided tool-growth routine and asked the user whether to start it.",
      `Request: ${pending.request}`,
      pending.capabilityName ? `Capability name: ${pending.capabilityName}` : undefined,
      pending.summary ? `Summary: ${pending.summary}` : undefined,
      `Read only: ${pending.readOnly === false ? "false" : "true"}`,
      "",
      "Interpret the current user message semantically and set toolGrowthDecision accordingly.",
      "Do not require slash commands for this natural-language decision."
    ].filter(Boolean).join("\n")
  };
}

async function handleHashCommand(options: GatewayMessageOptions & {
  input: string;
  state: GatewayChatState;
  now: () => number;
}): Promise<GatewayMessageResult> {
  return done(formatHashCommandRemovedNotice(), options.state);
}

function updateGatewayToolGrowthRoutineId(current: string | undefined, routine: ToolGrowthRoutine | undefined): string | undefined {
  if (!routine) {
    return current;
  }
  return ["activated", "cancelled", "rejected"].includes(routine.status) ? undefined : routine.id;
}

function resolveGatewayToolGrowthRoutineId(tokens: string[], current: string | undefined): string | undefined {
  return positionalGatewayArgs(tokens)[0] ?? current;
}

function positionalGatewayArgs(tokens: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith("--")) {
      const next = tokens[index + 1];
      if (next && !next.startsWith("--")) {
        index += 1;
      }
      continue;
    }
    result.push(token);
  }
  return result;
}

function parseGatewayCommandLineArgs(value: string): string[] {
  const matches = value.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g);
  return [...matches].map((match) => match[1] ?? match[2] ?? match[3]);
}

function parseGatewayFlagArgs(tokens: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = tokens[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function formatTelegramCliToolGrowGuidance(input: string): string {
  const slash = input.replace(/^cosia\s+tool\s+grow/i, "/tool grow").trim();
  return [
    "Telegram does not execute local CLI commands.",
    "Use the Telegram slash command form instead:",
    `  ${slash}`,
    "",
    "For local PowerShell, run the cosia command directly outside Telegram."
  ].join("\n");
}

export function isGatewayWhoamiInput(input: string): boolean {
  return isWhoamiInput(input);
}

export function formatGatewayWhoami(source: GatewaySourceContext): string {
  return formatGatewayActorWhoami(sourceToGatewayActor(source));
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
    },
    gatewayActor: sourceToGatewayActor(options.source ?? { chatId: options.chatId, chatType: "private" }),
    gatewayRole: options.gatewayRole
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

function shouldPromoteGatewayRunForTool(event: RunProgressEvent): boolean {
  if (event.status !== "waiting_for_tool" || !event.toolName) {
    return false;
  }
  const entry = (toolCatalog as Record<string, { permission: string } | undefined>)[event.toolName];
  if (entry?.permission === "read_only") {
    return false;
  }
  return true;
}
