import { z } from "zod";
import { CodexAmendmentLedger, type CodexAmendment } from "./codex_amendment.js";
import { detectSecrets } from "./risk_classifier.js";
import { isRunJobTerminal, RunJobLedger, type RunJobRecord } from "./run_jobs.js";
import { ShellApprovalLedger, type ShellApproval } from "./shell_approval.js";
import { ToolGrowthManager, type ToolGrowthRoutine } from "./tool_growth.js";
import type { ToolContext, ToolResult } from "./types.js";

const scopeSchema = z.enum(["current", "all"]).default("current");
const boolOption = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean().optional());
const limitOption = z.preprocess((value) => {
  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }
  return value;
}, z.number().int().min(1).max(50).optional()).default(10);

const runtimeStatusArgs = z.object({
  scope: scopeSchema.optional()
});

const runJobsReadArgs = z.object({
  jobId: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional()),
  includeTerminal: boolOption.default(false),
  scope: scopeSchema,
  limit: limitOption
});

const toolGrowthStatusArgs = z.object({
  routineId: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional()),
  includeClosed: boolOption.default(false),
  advanced: boolOption.default(false),
  scope: scopeSchema,
  limit: limitOption
});

const pendingActionsReadArgs = z.object({
  scope: scopeSchema,
  limit: limitOption
});

type EffectiveScope = {
  scope: "current" | "all";
  notice?: string;
};

export async function executeRuntimeStatusRead(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = runtimeStatusArgs.parse(args ?? {});
  const scope = effectiveScope(ctx, parsed.scope ?? "current");
  const { getStatusReport } = await import("./status_report.js");
  const report = await getStatusReport(ctx.workspaceRoot, ctx.gatewayRuntime?.providerId ?? "default");
  return jsonToolResult({
    tool: "runtime_status_read",
    scope: scope.scope,
    notice: scope.notice,
    version: report.version,
    provider: {
      id: report.providerId,
      ok: report.providerOk,
      messagePreview: sanitizedPreview(report.providerMessage),
      reason: report.providerReason
    },
    sessions: {
      activeSessionId: ctx.gatewayRuntime?.activeSessionId ?? ctx.sessionId,
      total: report.sessionsCount,
      active: report.activeSessionsCount,
      largestContext: report.largestContext ? {
        sessionId: report.largestContext.sessionId,
        chars: report.largestContext.chars,
        level: report.largestContext.level
      } : undefined
    },
    review: {
      memoryPending: report.pendingCandidatesCount,
      skillPending: report.pendingSkillCandidatesCount
    },
    gateway: {
      sourceChannel: ctx.sourceChannel,
      role: ctx.gatewayRole,
      chatId: ctx.gatewayActor?.chatId,
      chatType: ctx.gatewayActor?.chatType,
      currentToolGrowthRoutineId: ctx.gatewayRuntime?.currentToolGrowthRoutineId,
      hasPendingCommand: Boolean(ctx.gatewayRuntime?.pendingCommand),
      hasPendingToolGrowthRequest: Boolean(ctx.gatewayRuntime?.pendingToolGrowthRequest)
    },
    health: {
      policyOk: report.policyOk,
      policyMarkdownMatches: report.policyMarkdownMatches,
      skillMirrorOk: report.skillMirrorOk,
      contextWarningCount: report.contextWarningCount,
      contextCriticalCount: report.contextCriticalCount,
      issues: report.issues.slice(0, 8).map((issue) => ({
        id: issue.id,
        severity: issue.severity,
        title: sanitizedPreview(issue.title),
        detailPreview: sanitizedPreview(issue.detail),
        action: issue.action
      }))
    },
    nextActions: report.recommendedActions.slice(0, 5)
  });
}

export async function executeRunJobsRead(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = runJobsReadArgs.parse(args ?? {});
  const scope = effectiveScope(ctx, parsed.scope);
  const ledger = new RunJobLedger(ctx.workspaceRoot);
  if (parsed.jobId) {
    const job = await ledger.get(parsed.jobId);
    if (!job) {
      return jsonToolResult({ tool: "run_jobs_read", ok: false, message: `Run job not found: ${parsed.jobId}` });
    }
    if (!jobVisibleInScope(job, ctx, scope.scope)) {
      return jsonToolResult({ tool: "run_jobs_read", ok: false, message: "Run job is outside the permitted inspector scope." });
    }
    return jsonToolResult({
      tool: "run_jobs_read",
      scope: scope.scope,
      notice: scope.notice,
      job: sanitizeRunJob(job)
    });
  }
  const jobs = await ledger.list({
    includeTerminal: parsed.includeTerminal,
    chatId: scope.scope === "current" ? ctx.gatewayActor?.chatId : undefined,
    sessionId: scope.scope === "current" ? currentSessionId(ctx) : undefined
  });
  return jsonToolResult({
    tool: "run_jobs_read",
    scope: scope.scope,
    notice: scope.notice,
    total: jobs.length,
    jobs: jobs.slice(0, parsed.limit).map(sanitizeRunJob)
  });
}

export async function executeToolGrowthStatusRead(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = toolGrowthStatusArgs.parse(args ?? {});
  const scope = effectiveScope(ctx, parsed.scope);
  const growth = new ToolGrowthManager(ctx.workspaceRoot);
  const currentRoutineId = ctx.gatewayRuntime?.currentToolGrowthRoutineId;
  if (scope.scope === "current") {
    const routineId = parsed.routineId ?? currentRoutineId;
    if (!routineId) {
      return jsonToolResult({
        tool: "tool_growth_status_read",
        scope: "current",
        notice: scope.notice,
        routines: [],
        message: "No current tool growth routine is selected for this gateway/session context."
      });
    }
    if (parsed.routineId && currentRoutineId && parsed.routineId !== currentRoutineId) {
      return jsonToolResult({
        tool: "tool_growth_status_read",
        scope: "current",
        ok: false,
        message: "Requested routine is outside the current gateway/session scope."
      });
    }
    const routine = growth.get(routineId);
    return jsonToolResult({
      tool: "tool_growth_status_read",
      scope: "current",
      notice: scope.notice,
      routine: sanitizeToolGrowthRoutine(routine, parsed.advanced)
    });
  }
  if (parsed.routineId) {
    return jsonToolResult({
      tool: "tool_growth_status_read",
      scope: "all",
      routine: sanitizeToolGrowthRoutine(growth.get(parsed.routineId), parsed.advanced)
    });
  }
  const routines = growth.list({ all: parsed.includeClosed });
  return jsonToolResult({
    tool: "tool_growth_status_read",
    scope: "all",
    total: routines.length,
    routines: routines.slice(0, parsed.limit).map((routine) => sanitizeToolGrowthRoutine(routine, parsed.advanced))
  });
}

export async function executePendingActionsRead(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = pendingActionsReadArgs.parse(args ?? {});
  const scope = effectiveScope(ctx, parsed.scope);
  const sessionId = scope.scope === "current" ? currentSessionId(ctx) : undefined;
  const shell = new ShellApprovalLedger(ctx.workspaceRoot)
    .list({ status: "pending" })
    .filter((approval) => !sessionId || approval.sourceSessionId === sessionId)
    .slice(0, parsed.limit);
  const codex = new CodexAmendmentLedger(ctx.workspaceRoot)
    .list()
    .filter((amendment) => !sessionId || amendment.sourceSessionId === sessionId)
    .slice(0, parsed.limit);
  const pendingCommand = ctx.gatewayRuntime?.pendingCommand;
  const pendingToolGrowthRequest = ctx.gatewayRuntime?.pendingToolGrowthRequest;
  return jsonToolResult({
    tool: "pending_actions_read",
    scope: scope.scope,
    notice: scope.notice,
    gatewayPendingCommand: pendingCommand ? {
      id: pendingCommand.id,
      commandId: pendingCommand.commandId,
      safety: pendingCommand.safety,
      createdAt: pendingCommand.createdAt,
      expiresAt: pendingCommand.expiresAt,
      scope: pendingCommand.scope
    } : undefined,
    pendingToolGrowthRequest: pendingToolGrowthRequest ? {
      capabilityName: pendingToolGrowthRequest.capabilityName,
      requestPreview: sanitizedPreview(pendingToolGrowthRequest.request),
      summaryPreview: sanitizedPreview(pendingToolGrowthRequest.summary ?? ""),
      readOnly: pendingToolGrowthRequest.readOnly,
      createdAt: pendingToolGrowthRequest.createdAt
    } : undefined,
    shellApprovals: shell.map(sanitizeShellApproval),
    codexAmendments: codex.map(sanitizeCodexAmendment)
  });
}

function effectiveScope(ctx: ToolContext, requested: "current" | "all"): EffectiveScope {
  if (ctx.sourceChannel !== "gateway") {
    return { scope: requested };
  }
  if (ctx.gatewayRole === "master") {
    return { scope: requested };
  }
  if (requested === "all") {
    return {
      scope: "current",
      notice: `Requested scope=all is limited to current scope for gateway role ${ctx.gatewayRole ?? "unknown"}.`
    };
  }
  return { scope: "current" };
}

function currentSessionId(ctx: ToolContext): string | undefined {
  return ctx.gatewayRuntime?.activeSessionId ?? ctx.sessionId;
}

function jobVisibleInScope(job: RunJobRecord, ctx: ToolContext, scope: "current" | "all"): boolean {
  if (scope === "all") {
    return true;
  }
  const sessionId = currentSessionId(ctx);
  const chatId = ctx.gatewayActor?.chatId;
  if (chatId && job.source.chatId !== chatId) {
    return false;
  }
  if (sessionId && job.sessionId !== sessionId) {
    return false;
  }
  return true;
}

function sanitizeRunJob(job: RunJobRecord): Record<string, unknown> {
  return {
    id: job.id,
    sessionId: job.sessionId,
    providerId: job.providerId,
    source: {
      channel: job.source.channel,
      chatId: job.source.chatId,
      chatType: job.source.chatType,
      userId: job.source.userId
    },
    status: job.status,
    terminal: isRunJobTerminal(job.status),
    currentStep: job.currentStep,
    failureKind: job.failureKind,
    requestPreview: sanitizedPreview(job.request),
    lastToolResultPreview: sanitizedPreview(job.lastToolResultSummary ?? ""),
    finalOutputPreview: sanitizedPreview(job.finalOutputSummary ?? ""),
    errorPreview: sanitizedPreview(job.errorSummary ?? ""),
    cancelRequestedAt: job.cancelRequestedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt
  };
}

function sanitizeToolGrowthRoutine(routine: ToolGrowthRoutine, advanced: boolean): Record<string, unknown> {
  return {
    id: routine.id,
    status: routine.status,
    requestPreview: sanitizedPreview(routine.sourceRequest),
    attemptCount: routine.attemptCount,
    selectedCandidateId: routine.selectedCandidateId,
    candidateCount: routine.candidateIds.length,
    draftCount: routine.draftIds.length,
    targetAgentId: routine.targetAgentId,
    providerId: routine.providerId,
    nextAction: nextToolGrowthAction(routine),
    reasonPreview: sanitizedPreview(routine.reason ?? ""),
    createdAt: routine.createdAt,
    updatedAt: routine.updatedAt,
    completedAt: routine.completedAt,
    ...(advanced ? {
      sourceScanId: routine.sourceScanId,
      sourceCapabilityId: routine.sourceCapabilityId,
      draftIds: routine.draftIds,
      candidateIds: routine.candidateIds,
      evidenceKeys: Object.keys(routine.evidence).sort()
    } : {})
  };
}

function sanitizeShellApproval(approval: ShellApproval): Record<string, unknown> {
  return {
    id: approval.id,
    status: approval.status,
    risk: approval.risk,
    blocked: approval.blocked,
    commandHash: approval.commandHash,
    cwdHash: approval.cwdHash,
    reasonPreview: sanitizedPreview(approval.reason),
    expectedEffectPreview: sanitizedPreview(approval.expectedEffect),
    sourceSessionId: approval.sourceSessionId,
    sourceAgentId: approval.sourceAgentId,
    sourceChannel: approval.sourceChannel,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt
  };
}

function sanitizeCodexAmendment(amendment: CodexAmendment): Record<string, unknown> {
  return {
    id: amendment.id,
    status: amendment.status,
    targetPath: amendment.targetPath,
    previousHash: amendment.previousHash,
    proposedHash: amendment.proposedHash,
    reasonPreview: sanitizedPreview(amendment.reason),
    sourceSessionId: amendment.sourceSessionId,
    sourceAgentId: amendment.sourceAgentId,
    sourceChannel: amendment.sourceChannel,
    createdAt: amendment.createdAt
  };
}

function nextToolGrowthAction(routine: ToolGrowthRoutine): string {
  if (routine.status === "candidate_ready") return `test ${routine.id} --yes`;
  if (routine.status === "test_failed") return `retry ${routine.id}`;
  if (routine.status === "test_passed" || routine.status === "awaiting_activation") return `activate ${routine.id} --agent <agent-id> --yes`;
  if (routine.status === "rejected") return `retry ${routine.id}`;
  if (routine.status === "cancelled") return "closed; no further action";
  if (routine.status === "activated") return "active tool registration already applied";
  return "inspect routine";
}

function jsonToolResult(value: unknown): ToolResult {
  return { ok: true, content: `${JSON.stringify(value, null, 2)}\n` };
}

function sanitizedPreview(value: string, maxChars = 180): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  const detected = detectSecrets(normalized);
  const redacted = detected.matched ? detected.redactedPreview : normalized;
  return redacted.length > maxChars ? `${redacted.slice(0, Math.max(0, maxChars - 3))}...` : redacted;
}
