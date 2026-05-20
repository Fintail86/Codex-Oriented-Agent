import { AgentManager } from "./agent_manager.js";
import { MemoryManager } from "./memory_manager.js";
import { checkProvider } from "./model/provider_registry.js";
import { PolicyManager } from "./policy_manager.js";
import { SessionManager, type ContextHealth } from "./session_manager.js";
import { COSIA_VERSION } from "./version.js";

export type StatusReport = {
  version: string;
  workspaceRoot: string;
  agentsCount: number;
  sessionsCount: number;
  memoriesCount: number;
  pendingCandidatesCount: number;
  providerId: string;
  providerOk: boolean;
  providerMessage: string;
  providerReason?: string;
  providerHint?: string;
  contextWarningCount: number;
  contextCriticalCount: number;
  largestContext?: ContextHealth;
};

export async function getStatusReport(workspaceRoot: string, providerId = "codex-cli"): Promise<StatusReport> {
  const sessionManager = new SessionManager(workspaceRoot);
  const [agents, sessions] = await Promise.all([
    new AgentManager(workspaceRoot).listAgents(),
    sessionManager.listSessions()
  ]);
  const memory = new MemoryManager(workspaceRoot);
  const policy = await loadPolicyIfPresent(workspaceRoot);
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
  return {
    version: COSIA_VERSION,
    workspaceRoot,
    agentsCount: agents.length,
    sessionsCount: sessions.length,
    memoriesCount: memory.countMemories(),
    pendingCandidatesCount: await memory.countPendingCandidates(),
    providerId: providerStatus.id,
    providerOk: providerStatus.ok,
    providerMessage: providerStatus.message,
    providerReason: providerStatus.reason,
    providerHint: providerStatus.hint,
    contextWarningCount: contextHealth.filter((item) => item.level === "warning").length,
    contextCriticalCount: contextHealth.filter((item) => item.level === "critical").length,
    largestContext
  };
}

async function loadPolicyIfPresent(workspaceRoot: string) {
  try {
    return await new PolicyManager(workspaceRoot).loadPolicy();
  } catch {
    return undefined;
  }
}
