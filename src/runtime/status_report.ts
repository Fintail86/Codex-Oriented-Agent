import { AgentManager } from "./agent_manager.js";
import { MemoryManager } from "./memory_manager.js";
import { createProvider } from "./model/provider_registry.js";
import { SessionManager } from "./session_manager.js";
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
};

export async function getStatusReport(workspaceRoot: string, providerId = "codex-cli"): Promise<StatusReport> {
  const [agents, sessions] = await Promise.all([
    new AgentManager(workspaceRoot).listAgents(),
    new SessionManager(workspaceRoot).listSessions()
  ]);
  const memory = new MemoryManager(workspaceRoot);
  const provider = createProvider(providerId, workspaceRoot);
  const providerStatus = await provider.checkAuth();
  return {
    version: COSIA_VERSION,
    workspaceRoot,
    agentsCount: agents.length,
    sessionsCount: sessions.length,
    memoriesCount: memory.countMemories(),
    pendingCandidatesCount: await memory.countPendingCandidates(),
    providerId: provider.id,
    providerOk: providerStatus.ok,
    providerMessage: providerStatus.message
  };
}
