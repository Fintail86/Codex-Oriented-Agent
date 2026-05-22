import type { AgentManifest, SessionMetadata, ToolName } from "./types.js";
import type { PolicyConfig } from "./policy_manager.js";
import { PolicyManager, formatPolicySummary } from "./policy_manager.js";
import { getStatusReport, formatStatusReport } from "./status_report.js";
import { MemoryManager } from "./memory_manager.js";
import { SessionManager } from "./session_manager.js";
import { SkillManager } from "./skill_manager.js";
import { ToolRegistry } from "./tool_registry.js";
import { isToolId } from "./tool_catalog.js";
import { checkProvider, listProviders } from "./model/provider_registry.js";
import {
  formatReviewBatchDiscard,
  formatReviewCleanup,
  formatReviewInbox,
  formatReviewNext,
  formatReviewStats,
  formatReviewUpdate,
  ReviewInboxService
} from "./review_inbox.js";
import type { CommandIntentResult, CommandSafety } from "./command_intent.js";

const pendingTtlMs = 5 * 60 * 1000;

export type PendingCommand = {
  id: string;
  commandId: string;
  preview: string;
  args: Record<string, unknown>;
  safety: CommandSafety;
  createdAt: string;
  expiresAt: string;
  createdAtMs: number;
  expiresAtMs: number;
  scope?: {
    chatId?: string;
    sessionId?: string;
  };
  freshness?: {
    targetType: "memory_candidate" | "skill_candidate" | "review_cleanup";
    targetIds: string[];
    snapshots: Array<{
      id: string;
      type: "memory" | "skill";
      status: string;
      conflictCount: number;
    }>;
  };
};

export type CommandCatalogContext = {
  workspaceRoot: string;
  session: SessionMetadata;
  agent: AgentManifest;
  providerId: string;
  policy: PolicyConfig;
  sessions: SessionManager;
  memory: MemoryManager;
  skills: SkillManager;
  reviewInbox: ReviewInboxService;
  now: () => number;
  previewScope?: {
    chatId?: string;
    sessionId?: string;
  };
};

export async function executeReadOnlyCommand(intent: Extract<CommandIntentResult, { type: "matched" }>, ctx: CommandCatalogContext): Promise<string | undefined> {
  switch (intent.commandId) {
    case "status.show":
      return formatStatusReport(await getStatusReport(ctx.workspaceRoot, ctx.providerId));
    case "review.list":
      return formatReviewInbox(await ctx.reviewInbox.list(asReviewFilter(intent.args.filter)));
    case "review.next": {
      const inbox = await ctx.reviewInbox.list("all");
      return formatReviewNext(inbox.items[0]);
    }
    case "review.conflicted_memory": {
      const inbox = await ctx.reviewInbox.list("memory");
      return formatReviewInbox({
        ...inbox,
        items: inbox.items.filter((item) => item.conflictCount > 0)
      }, "Conflicted Memory Review");
    }
    case "review.stats":
      return formatReviewStats(await ctx.reviewInbox.stats({
        discardedRetentionDays: ctx.policy.review.discardedRetentionDays,
        pendingWarningDays: ctx.policy.review.pendingWarningDays
      }));
    case "memory.search":
      return formatMemorySearch(ctx.memory.search(String(intent.args.query ?? ""), 8));
    case "session.list":
      return formatSessionList(await ctx.sessions.listSessions());
    case "session.summary": {
      const source = await ctx.sessions.summarySource(ctx.session.id, ctx.policy.promptBudget.contextTailChars);
      return source.existingSummary || "# SESSION SUMMARY\n\nNo compact session summary yet.";
    }
    case "context.status":
      return formatContextStatus(await ctx.sessions.contextStatus(ctx.session.id, {
        warningChars: ctx.policy.promptBudget.contextWarningChars,
        criticalChars: ctx.policy.promptBudget.contextCriticalChars
      }));
    case "provider.check": {
      const result = await checkProvider(ctx.providerId, ctx.workspaceRoot, ctx.policy);
      return [
        `Provider: ${result.id}`,
        `Status: ${result.ok ? "ok" : "failed"}`,
        `Message: ${result.message}`,
        result.reason ? `Reason: ${result.reason}` : undefined,
        result.hint ? `Hint: ${result.hint}` : undefined,
        "",
        formatProviderList(ctx.policy)
      ].filter(Boolean).join("\n");
    }
    case "tool.run": {
      const toolId = String(intent.args.toolId ?? "");
      if (!isToolId(toolId)) {
        return `[FAILED] Unknown tool: ${toolId}`;
      }
      const toolArgs = intent.args.toolArgs && typeof intent.args.toolArgs === "object" && !Array.isArray(intent.args.toolArgs)
        ? intent.args.toolArgs as Record<string, unknown>
        : {};
      return executeTool(toolId, toolArgs, ctx);
    }
    case "policy.check": {
      const policyManager = new PolicyManager(ctx.workspaceRoot);
      const check = await policyManager.checkPolicy(false, false);
      return [
        `POLICY.json: ${check.jsonExists && check.jsonValid ? "ok" : "failed"}`,
        `POLICY.md: ${check.markdownExists && check.markdownMatches ? "ok" : "failed"}`,
        check.errors.length ? `Errors:\n${check.errors.map((error) => `- ${error}`).join("\n")}` : "Policy check ok.",
        "",
        formatPolicySummary(ctx.policy)
      ].join("\n");
    }
    case "skill.list":
      return formatSkillList(ctx.skills, ctx.agent);
    default:
      return undefined;
  }
}

export async function previewMutationCommand(intent: Extract<CommandIntentResult, { type: "matched" }>, ctx: CommandCatalogContext): Promise<{ output: string; pending?: PendingCommand } | undefined> {
  switch (intent.commandId) {
    case "review.discard": {
      const target = String(intent.args.target ?? "");
      const reason = String(intent.args.reason ?? "");
      const item = await ctx.reviewInbox.resolve(target);
      const output = [
        `[PREVIEW] Review item ${item.idPrefix} will be discarded.`,
        `Type: ${item.type}`,
        `Risk: ${item.risk}`,
        `Reason: ${reason}`,
        "",
        "Run #적용 to proceed or #취소 to cancel."
      ].join("\n");
      return { output, pending: createPendingCommand("review.discard", intent.args, "mutation", output, ctx.now, ctx, [item]) };
    }
    case "review.discard_conflicts": {
      const reason = String(intent.args.reason ?? "");
      const preview = await ctx.reviewInbox.discardConflictingMemoryCandidates(reason, { yes: false });
      const output = [
        `[PREVIEW] ${preview.matched} conflicting memory candidates will be discarded.`,
        formatReviewBatchDiscard(preview),
        "",
        "Run #적용 to proceed or #취소 to cancel."
      ].join("\n");
      return { output, pending: createPendingCommand("review.discard_conflicts", intent.args, "mutation", output, ctx.now, ctx, preview.items) };
    }
    case "review.promote_skill": {
      const target = String(intent.args.target ?? "");
      const item = await ctx.reviewInbox.resolve(target);
      if (item.type !== "skill") {
        const output = [
          "[BLOCKED] This natural command promotes skill candidates only.",
          `Selected item ${item.idPrefix} is a memory candidate.`,
          `Try: /review promote ${item.idPrefix}`
        ].join("\n");
        return { output };
      }
      const result = await ctx.reviewInbox.promote(target, { yes: false });
      const output = [
        "[PREVIEW] Skill candidate promotion preview.",
        result.output,
        "",
        "Run #적용 to proceed or #취소 to cancel."
      ].join("\n");
      return { output, pending: createPendingCommand("review.promote_skill", intent.args, "mutation", output, ctx.now, ctx, [item]) };
    }
    case "review.cleanup": {
      const result = await ctx.reviewInbox.cleanup({
        olderThanDays: ctx.policy.review.discardedRetentionDays,
        yes: false
      });
      const output = [
        "[PREVIEW] Discarded review candidates eligible for cleanup.",
        formatReviewCleanup(result),
        "",
        "Run #적용 to proceed or #취소 to cancel."
      ].join("\n");
      return { output, pending: createPendingCommand("review.cleanup", intent.args, "mutation", output, ctx.now, ctx, []) };
    }
    default:
      return undefined;
  }
}

export async function applyPendingCommand(pending: PendingCommand, ctx: CommandCatalogContext): Promise<string> {
  await validatePendingFreshness(pending, ctx);
  switch (pending.commandId) {
    case "review.discard": {
      const result = await ctx.reviewInbox.discard(String(pending.args.target ?? ""), String(pending.args.reason ?? ""));
      return [`[SUCCESS] ${result.output}`, formatReviewUpdate(result.inbox)].join("\n");
    }
    case "review.discard_conflicts": {
      const result = await ctx.reviewInbox.discardConflictingMemoryCandidates(String(pending.args.reason ?? ""), { yes: true });
      return [
        `[SUCCESS] Discarded ${result.discarded} memory candidates.`,
        formatReviewBatchDiscard(result),
        formatReviewUpdate(result.inbox)
      ].join("\n");
    }
    case "review.promote_skill": {
      const result = await ctx.reviewInbox.promote(String(pending.args.target ?? ""), { yes: true });
      return [`[SUCCESS] Skill promotion applied.`, result.output, formatReviewUpdate(result.inbox)].join("\n");
    }
    case "review.cleanup": {
      const result = await ctx.reviewInbox.cleanup({
        olderThanDays: ctx.policy.review.discardedRetentionDays,
        yes: true
      });
      return [`[SUCCESS] Review cleanup applied.`, formatReviewCleanup(result)].join("\n");
    }
    default:
      return "[BLOCKED] This pending command cannot be applied.";
  }
}

export function createPendingCommand(
  commandId: string,
  args: Record<string, unknown>,
  safety: CommandSafety,
  preview: string,
  now: () => number,
  ctx?: CommandCatalogContext,
  items: Array<{ id: string; type: "memory" | "skill"; status: string; conflictCount: number }> = []
): PendingCommand {
  const createdAtMs = now();
  const expiresAtMs = createdAtMs + pendingTtlMs;
  return {
    id: randomId(),
    commandId,
    preview,
    args,
    safety,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    createdAtMs,
    expiresAtMs,
    scope: ctx?.previewScope ?? { sessionId: ctx?.session.id },
    freshness: {
      targetType: items.length === 0 ? "review_cleanup" : items.some((item) => item.type === "skill") ? "skill_candidate" : "memory_candidate",
      targetIds: items.map((item) => item.id),
      snapshots: items.map((item) => ({
        id: item.id,
        type: item.type,
        status: item.status,
        conflictCount: item.conflictCount
      }))
    }
  };
}

export function isPendingExpired(pending: PendingCommand, now: () => number): boolean {
  return now() > pending.expiresAtMs;
}

export function formatPendingCommand(pending: PendingCommand, now: () => number): string {
  const remainingMs = Math.max(0, pending.expiresAtMs - now());
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  return [
    `Pending command: ${pending.commandId}`,
    `Safety: ${pending.safety}`,
    `Created: ${pending.createdAt}`,
    `Expires: ${pending.expiresAt}`,
    `Remaining: ${remainingSeconds}s`,
    "",
    pending.preview
  ].join("\n");
}

export function formatNeedsInput(commandId: string, missing: string[], hint: string): string {
  return [
    `[BLOCKED] This command needs ${missing.join(", ")}.`,
    `Command: ${commandId}`,
    hint
  ].join("\n");
}

export function formatAmbiguousCommand(candidates: string[], hint: string): string {
  return [
    "[BLOCKED] Natural command is ambiguous.",
    `Candidates: ${candidates.join(", ")}`,
    hint
  ].join("\n");
}

async function executeTool(name: ToolName, args: unknown, ctx: CommandCatalogContext): Promise<string> {
  const result = await new ToolRegistry().execute(name, args, {
    workspaceRoot: ctx.workspaceRoot,
    allowedTools: ctx.agent.allowedTools
  });
  return result.content;
}

function asReviewFilter(value: unknown): "all" | "memory" | "skill" {
  return value === "memory" || value === "skill" ? value : "all";
}

function formatMemorySearch(results: ReturnType<MemoryManager["search"]>): string {
  if (!results.length) {
    return "No matches.";
  }
  return results
    .map((result) => `${result.record.id.slice(0, 8)} [${result.record.tier}/${result.record.kind}] score:${result.score.toFixed(2)} tokens:${result.matchedTokens.join(",")} ${result.record.content}`)
    .join("\n");
}

function formatSessionList(sessions: SessionMetadata[]): string {
  if (!sessions.length) {
    return "No sessions.";
  }
  return sessions
    .map((session) => `${session.id}\t${session.assignedAgentId ?? "unassigned"}\t${session.status}\t${session.updatedAt}\t${session.goal}`)
    .join("\n");
}

function formatContextStatus(status: {
  sessionId: string;
  chars: number;
  warningChars: number;
  criticalChars: number;
  level: string;
  runEntryCount: number;
  archiveEntryCount: number;
  summaryIsPlaceholder: boolean;
  compactRecommended: boolean;
}): string {
  return [
    `Session: ${status.sessionId}`,
    `Context: ${status.level} ${status.chars} chars (warning:${status.warningChars}, critical:${status.criticalChars})`,
    `Run entries: ${status.runEntryCount}`,
    `Archived entries: ${status.archiveEntryCount}`,
    `Summary placeholder: ${status.summaryIsPlaceholder}`,
    `Compact recommended: ${status.compactRecommended}`
  ].join("\n");
}

function formatProviderList(policy: PolicyConfig): string {
  const rows = listProviders(policy).map((provider) => {
    const model = provider.modelConfigured === undefined ? "-" : provider.modelConfigured ? "set" : "unset";
    const baseUrl = provider.baseUrlConfigured === undefined ? "-" : provider.baseUrlConfigured ? "set" : "unset";
    return `${provider.id}\t${provider.type ?? "built-in"}\t${provider.isDefault ? "default" : ""}\t${provider.enabled ? "enabled" : "disabled"}\tmodel:${model}\tbaseUrl:${baseUrl}`;
  });
  return ["Providers:", ...rows].join("\n");
}

function formatSkillList(skills: SkillManager, agent: AgentManifest): string {
  const globalSkills = skills.listSkills();
  if (!globalSkills.length) {
    return "No global skills.";
  }
  return globalSkills.map((item) => {
    const state = agent.blockedSkills.includes(item.id)
      ? "blocked"
      : agent.preferredSkills.includes(item.id)
        ? "preferred"
        : "available";
    const weight = agent.skillWeights?.[item.id] ? ` weight:${agent.skillWeights[item.id]}` : "";
    return `${item.id}\t${state}${weight}\t${item.manualOnly ? "manual-only" : `triggers:${item.triggers.join(",")}`}`;
  }).join("\n");
}

async function validatePendingFreshness(pending: PendingCommand, ctx: CommandCatalogContext): Promise<void> {
  if (pending.scope?.chatId && ctx.previewScope?.chatId && pending.scope.chatId !== ctx.previewScope.chatId) {
    throw new Error("[BLOCKED] Pending preview belongs to a different Telegram chat. Refresh the review inbox and try again.");
  }
  if (pending.scope?.sessionId && ctx.previewScope?.sessionId && pending.scope.sessionId !== ctx.previewScope.sessionId) {
    throw new Error("[BLOCKED] Pending preview belongs to a different session. Refresh the review inbox and try again.");
  }
  const snapshots = pending.freshness?.snapshots ?? [];
  if (!snapshots.length) {
    return;
  }
  const inbox = await ctx.reviewInbox.list("all");
  for (const snapshot of snapshots) {
    const current = inbox.items.find((item) => item.id === snapshot.id);
    if (!current) {
      throw new Error(`[BLOCKED] Pending preview is stale. Target is no longer pending: ${snapshot.id.slice(0, 8)}. Refresh the review inbox and try again.`);
    }
    if (current.status !== snapshot.status || current.conflictCount !== snapshot.conflictCount) {
      throw new Error(`[BLOCKED] Pending preview is stale. Target changed: ${snapshot.id.slice(0, 8)}. Refresh the review inbox and try again.`);
    }
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
