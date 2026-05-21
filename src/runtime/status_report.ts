import { AgentManager } from "./agent_manager.js";
import { MemoryManager } from "./memory_manager.js";
import { checkProvider } from "./model/provider_registry.js";
import { PolicyManager } from "./policy_manager.js";
import { SessionManager, type ContextHealth } from "./session_manager.js";
import { SkillManager } from "./skill_manager.js";
import type { SessionMetadata } from "./types.js";
import { COSIA_VERSION } from "./version.js";
import { pathExists } from "./fs_utils.js";
import { join } from "node:path";

export type StatusIssueSeverity = "critical" | "warning" | "info";

export type StatusIssue = {
  id: string;
  severity: StatusIssueSeverity;
  title: string;
  detail: string;
  action?: string;
};

export type StatusReport = {
  version: string;
  workspaceRoot: string;
  agentsCount: number;
  sessionsCount: number;
  activeSessionsCount: number;
  memoriesCount: number;
  pendingCandidatesCount: number;
  pendingSkillCandidatesCount: number;
  defaultAgentId: string | null;
  defaultAgentExists: boolean;
  providerId: string;
  providerOk: boolean;
  providerMessage: string;
  providerReason?: string;
  providerHint?: string;
  policyOk: boolean;
  policyMarkdownMatches: boolean;
  skillMirrorOk: boolean;
  contextWarningCount: number;
  contextCriticalCount: number;
  largestContext?: ContextHealth;
  sessions: SessionMetadata[];
  orphanSessions: SessionMetadata[];
  issues: StatusIssue[];
  recommendedActions: string[];
};

export async function getStatusReport(workspaceRoot: string, providerId = "codex-cli"): Promise<StatusReport> {
  const sessionManager = new SessionManager(workspaceRoot);
  const [agents, sessions, requiredStructure] = await Promise.all([
    new AgentManager(workspaceRoot).listAgents(),
    sessionManager.listSessions(),
    requiredStructureStatus(workspaceRoot)
  ]);
  const agentIds = new Set(agents.map((agent) => agent.id));
  const activeSessions = sessions.filter((session) => session.status === "active");
  const orphanSessions = sessions.filter((session) => Boolean(session.assignedAgentId) && !agentIds.has(session.assignedAgentId!));
  const memory = new MemoryManager(workspaceRoot);
  const policy = await loadPolicyIfPresent(workspaceRoot);
  const policyCheck = await checkPolicyIfPresent(workspaceRoot);
  const skillCheck = checkSkillMirrorIfPresent(workspaceRoot);
  const contextHealth = policy
    ? await sessionManager.contextHealthForSessions({
      warningChars: policy.promptBudget.contextWarningChars,
      criticalChars: policy.promptBudget.contextCriticalChars
    })
    : [];
  const largestContext = contextHealth.sort((left, right) => right.chars - left.chars)[0];
  const resolvedProviderId = providerId === "default" && policy ? policy.model.defaultProvider : providerId;
  const providerStatus = policy
    ? await checkProvider(resolvedProviderId, workspaceRoot, policy)
    : resolvedProviderId === "mock"
      ? { id: "mock", ok: true, message: "Mock provider does not require authentication." }
      : { id: resolvedProviderId, ok: false, message: "Policy not loaded.", reason: "missing_config", hint: "Run `cosia init` or `cosia policy check --repair`." };
  const defaultAgentId = policy?.agents.defaultAgentId ?? null;
  const defaultAgentExists = Boolean(defaultAgentId && agentIds.has(defaultAgentId));
  const pendingSkillCandidatesCount = countPendingSkillCandidates(workspaceRoot);
  const issues = sortIssues([
    ...requiredStructure.filter((item) => !item.exists).map((item): StatusIssue => ({
      id: `missing_structure.${item.path}`,
      severity: "critical",
      title: `Missing workspace structure: ${item.path}`,
      detail: `Required path is missing: ${item.path}`,
      action: "Run `cosia init` or `cosia doctor repair`."
    })),
    agents.length === 0 ? {
      id: "agents.none",
      severity: "critical",
      title: "No agents configured",
      detail: "COSIA needs at least one agent to run sessions.",
      action: "Run `cosia agent bootstrap` or `cosia doctor repair`."
    } : undefined,
    defaultAgentId && !defaultAgentExists ? {
      id: "agents.default_missing",
      severity: "critical",
      title: "Default agent is missing",
      detail: `Policy default agent '${defaultAgentId}' does not exist.`,
      action: "Run `cosia agent default set <agent-id>` or `cosia doctor repair`."
    } : undefined,
    !providerStatus.ok ? {
      id: "provider.failed",
      severity: "critical",
      title: `Provider ${providerStatus.id} is not ready`,
      detail: providerStatus.message,
      action: providerStatus.hint ?? "Run `cosia provider check <provider-id>`."
    } : undefined,
    policyCheck && !policyCheck.ok ? {
      id: "policy.check_failed",
      severity: policyCheck.jsonValid ? "warning" : "critical",
      title: "Policy files need attention",
      detail: policyCheck.errors.join("; ") || "POLICY.md is stale or missing.",
      action: "Run `cosia policy check --repair` or `cosia doctor repair`."
    } : undefined,
    skillCheck && !skillCheck.ok ? {
      id: "skills.check_failed",
      severity: "warning",
      title: "Skill mirror needs attention",
      detail: "Global skills mirror is missing, stale, or references missing files.",
      action: "Run `cosia skill check --repair` or `cosia doctor repair`."
    } : undefined,
    orphanSessions.length > 0 ? {
      id: "sessions.orphan",
      severity: "warning",
      title: "Orphan sessions found",
      detail: `${orphanSessions.length} active or historical session(s) reference a missing agent.`,
      action: "Run `cosia session assign <session-id> --agent <agent-id>`."
    } : undefined,
    contextHealth.some((item) => item.level !== "ok") ? {
      id: "context.needs_attention",
      severity: "warning",
      title: "Session context needs attention",
      detail: `${contextHealth.filter((item) => item.level === "warning").length} warning, ${contextHealth.filter((item) => item.level === "critical").length} critical context file(s).`,
      action: largestContext ? `Run \`cosia session context status ${largestContext.sessionId}\`.` : "Run `cosia session context status <session-id>`."
    } : undefined,
    (await memory.countPendingCandidates()) > 0 ? {
      id: "memory.pending",
      severity: "warning",
      title: "Pending memory review",
      detail: "Memory candidates are waiting for review.",
      action: "Run `cosia memory candidate review --pending`."
    } : undefined,
    pendingSkillCandidatesCount > 0 ? {
      id: "skills.pending",
      severity: "warning",
      title: "Pending skill review",
      detail: "Skill candidates are waiting for review.",
      action: "Run `cosia skill candidate list`."
    } : undefined,
    activeSessions.length === 0 ? {
      id: "sessions.none_active",
      severity: "info",
      title: "No active sessions",
      detail: "Create or choose a session before running work.",
      action: "Run `cosia start` or `cosia session create --goal \"<goal>\"`."
    } : undefined
  ].filter((issue): issue is StatusIssue => Boolean(issue)));
  const pendingCandidatesCount = await memory.countPendingCandidates();
  const recommendedActions = issues.filter((issue) => issue.action).map((issue) => issue.action!);
  if (!recommendedActions.length) {
    recommendedActions.push("Run `cosia start`.");
  }
  return {
    version: COSIA_VERSION,
    workspaceRoot,
    agentsCount: agents.length,
    sessionsCount: sessions.length,
    activeSessionsCount: activeSessions.length,
    memoriesCount: memory.countMemories(),
    pendingCandidatesCount,
    pendingSkillCandidatesCount,
    defaultAgentId,
    defaultAgentExists,
    providerId: providerStatus.id,
    providerOk: providerStatus.ok,
    providerMessage: providerStatus.message,
    providerReason: providerStatus.reason,
    providerHint: providerStatus.hint,
    policyOk: policyCheck?.ok ?? false,
    policyMarkdownMatches: policyCheck?.markdownMatches ?? false,
    skillMirrorOk: skillCheck?.ok ?? false,
    contextWarningCount: contextHealth.filter((item) => item.level === "warning").length,
    contextCriticalCount: contextHealth.filter((item) => item.level === "critical").length,
    largestContext,
    sessions,
    orphanSessions,
    issues,
    recommendedActions
  };
}

async function loadPolicyIfPresent(workspaceRoot: string) {
  try {
    return await new PolicyManager(workspaceRoot).loadPolicy();
  } catch {
    return undefined;
  }
}

async function checkPolicyIfPresent(workspaceRoot: string) {
  try {
    return await new PolicyManager(workspaceRoot).checkPolicy(false, false);
  } catch {
    return undefined;
  }
}

function checkSkillMirrorIfPresent(workspaceRoot: string) {
  try {
    return new SkillManager(workspaceRoot).checkSkills(undefined, false);
  } catch {
    return undefined;
  }
}

function countPendingSkillCandidates(workspaceRoot: string): number {
  try {
    return new SkillManager(workspaceRoot).listCandidates(false).filter((candidate) => candidate.record.status === "pending").length;
  } catch {
    return 0;
  }
}

async function requiredStructureStatus(workspaceRoot: string): Promise<Array<{ path: string; exists: boolean }>> {
  const required = ["codex", "agents", "sessions", "memory", "skills"];
  return Promise.all(required.map(async (path) => ({
    path,
    exists: await pathExists(join(workspaceRoot, path))
  })));
}

export function sortIssues(issues: StatusIssue[]): StatusIssue[] {
  const severityRank: Record<StatusIssueSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2
  };
  return [...issues].sort((left, right) => {
    if (severityRank[left.severity] !== severityRank[right.severity]) {
      return severityRank[left.severity] - severityRank[right.severity];
    }
    return left.id.localeCompare(right.id);
  });
}

export function formatStatusReport(report: StatusReport, options: { compact?: boolean } = {}): string {
  if (options.compact) {
    return [
      `COSIA ${report.version} | ${report.providerId}:${report.providerOk ? "ok" : "failed"} | agents:${report.agentsCount} sessions:${report.activeSessionsCount}/${report.sessionsCount} memories:${report.memoriesCount}`,
      `Issues: ${report.issues.length ? report.issues.map((issue) => `${issue.severity}:${issue.id}`).join(", ") : "none"}`,
      report.recommendedActions[0] ? `Next: ${report.recommendedActions[0]}` : "Next: cosia start"
    ].join("\n");
  }

  const lines = [
    `COSIA ${report.version}`,
    "",
    "Workspace",
    `  Root: ${report.workspaceRoot}`,
    "",
    "Runtime",
    `  Provider: ${report.providerId} (${report.providerOk ? "ok" : "failed"})`,
    `  Provider message: ${report.providerMessage}`,
    `  Default agent: ${report.defaultAgentId ?? "none"} (${report.defaultAgentExists ? "ok" : "missing"})`,
    `  Agents: ${report.agentsCount}`,
    `  Sessions: ${report.activeSessionsCount} active / ${report.sessionsCount} total`,
    `  Memories: ${report.memoriesCount}`,
    "",
    "Review Queues",
    `  Memory candidates: ${report.pendingCandidatesCount}`,
    `  Skill candidates: ${report.pendingSkillCandidatesCount}`,
    "",
    "Health",
    `  Policy mirror: ${report.policyOk ? "ok" : "needs attention"}`,
    `  Skill mirror: ${report.skillMirrorOk ? "ok" : "needs attention"}`,
    `  Context: ${report.contextWarningCount} warning / ${report.contextCriticalCount} critical`,
    report.largestContext ? `  Largest context: ${formatContextHealth(report.largestContext)}` : "  Largest context: none",
    ""
  ];

  if (report.issues.length) {
    lines.push("Issues");
    for (const issue of report.issues) {
      lines.push(`  [${issue.severity}] ${issue.title}`);
      lines.push(`    ${issue.detail}`);
    }
    lines.push("");
  }

  lines.push("Recommended next actions");
  if (!report.recommendedActions.length) {
    lines.push("  cosia start");
  } else {
    for (const action of report.recommendedActions.slice(0, 6)) {
      lines.push(`  ${action}`);
    }
  }
  return lines.join("\n");
}

function formatContextHealth(item: ContextHealth): string {
  return `${item.sessionId} ${item.level} ${item.chars} chars (warning:${item.warningChars}, critical:${item.criticalChars})`;
}
