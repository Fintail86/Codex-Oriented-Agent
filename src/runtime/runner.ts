import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { approveOverwrite } from "./approval_gate.js";
import { AgentManager } from "./agent_manager.js";
import { formatMemoryReviewSummary, MemoryManager } from "./memory_manager.js";
import { createProvider } from "./model/provider_registry.js";
import { PolicyAuditLog } from "./policy_audit.js";
import { PolicyEngine } from "./policy_engine.js";
import { PolicyManager } from "./policy_manager.js";
import { appendPromptManifest, buildPromptBundle, type PromptBlock } from "./prompt_builder.js";
import { SessionManager } from "./session_manager.js";
import { SkillManager } from "./skill_manager.js";
import { ToolRegistry } from "./tool_registry.js";
import type { AgentStep, ModelProvider, ToolName } from "./types.js";
import type { MemoryReviewSummary } from "./memory_manager.js";

type RunOptions = {
  sessionId: string;
  prompt: string;
  providerId?: string;
  approveOverwriteFiles?: boolean;
  requireTools?: boolean;
  provider?: ModelProvider;
  providerTimeoutMs?: number;
  promptStaticBlocks?: PromptBlock[];
  refreshReferenceMemory?: boolean;
  refreshReferenceMemoryAfterRun?: boolean;
  onEvent?: (message: string) => void;
  onMemoryReview?: (summary: MemoryReviewSummary) => void;
  manualSkillIds?: string[];
  agentId?: string;
};

export async function runSession(workspaceRoot: string, options: RunOptions): Promise<string> {
  const sessions = new SessionManager(workspaceRoot);
  const agents = new AgentManager(workspaceRoot);
  const memory = new MemoryManager(workspaceRoot);
  const skills = new SkillManager(workspaceRoot);
  const tools = new ToolRegistry();
  const session = await sessions.loadSession(options.sessionId);
  await sessions.ensureSessionSupportFiles(session.id);
  const executingAgentId = options.agentId ?? session.assignedAgentId;
  if (!executingAgentId) {
    throw new Error(`Session has no assigned agent. Run \`cosia session assign ${session.id} --agent <agent-id>\` or pass --agent <agent-id>.`);
  }
  const agent = await agents.loadAgent(executingAgentId);
  const policyManager = new PolicyManager(workspaceRoot);
  const policy = await policyManager.loadPolicy();
  if (await policyManager.ensureMarkdownCurrent()) {
    options.onEvent?.("policy mirror synced from POLICY.json");
  }
  const policyEngine = new PolicyEngine(policy);
  const audit = new PolicyAuditLog(workspaceRoot);
  const runId = randomUUID();
  const recordPolicyEvent = (event: Parameters<PolicyAuditLog["append"]>[2]) => audit.append(session, agent.id, event, runId);
  if (options.refreshReferenceMemory ?? true) {
    await memory.writeReferenceMemory(session, options.prompt, agent.id);
  }

  const providerId = options.providerId ?? policy.model.defaultProvider;
  const provider = options.provider ?? createProvider(providerId, workspaceRoot, options.providerTimeoutMs);
  if (provider.id !== "mock") {
    const auth = await provider.checkAuth();
    if (!auth.ok) {
      throw new Error(`Model provider auth failed: ${auth.message}`);
    }
  }

  const toolResults: string[] = [];
  const toolNames: ToolName[] = [];
  let finalContent = "";
  let lastStep: AgentStep | undefined;
  const maxToolCalls = 5;
  const maxModelAttempts = maxToolCalls + 2;
  let toolCallCount = 0;

  for (let depth = 0; depth < maxModelAttempts; depth += 1) {
    const remainingToolCalls = Math.max(0, maxToolCalls - toolCallCount);
    const forceFinal = remainingToolCalls === 0;
    options.onEvent?.(`model step ${depth + 1}/${maxModelAttempts}`);
    const promptResult = await buildPromptBundle({
      workspaceRoot,
      agent,
      session,
      userPrompt: options.prompt,
      toolResults,
      requireTools: options.requireTools,
      hasObservationTool: hasObservationTool(toolNames, policy.requireTools.observationTools),
      requiresFileRead: requiresFileRead(options.prompt, policy),
      hasReadFile: toolNames.includes("read_file"),
      policy,
      remainingToolCalls,
      forceFinal,
      staticBlocks: options.promptStaticBlocks,
      runId,
      modelStep: depth + 1,
      manualSkillIds: options.manualSkillIds
    });
    await appendPromptManifest(workspaceRoot, session.id, promptResult.manifest);
    const prompt = promptResult.prompt;
    const output = await complete(provider, prompt, session.id);
    lastStep = output.step;
    if (output.step.type === "final") {
      const decision = policyEngine.evaluateFinalAnswer({
        requireTools: options.requireTools,
        userPrompt: options.prompt,
        executedTools: toolNames
      });
      if (!decision.allowed) {
        options.onEvent?.(`final rejected by policy ${decision.ruleId}`);
        await recordPolicyEvent({
          eventType: "final_rejection",
          allowed: false,
          ruleId: decision.ruleId,
          reason: decision.reason
        });
        toolResults.push(
          `Runtime rejection: ${decision.reason} ${runtimeRetryInstruction(decision.ruleId, policy)}`
        );
        continue;
      }
      finalContent = output.step.content;
      const candidates = await memory.appendCandidates(output.step.memoryCandidates, session, runId, agent.id);
      if (candidates.length) {
        const summary = await memory.reviewCandidates(candidates, policy.memory.autoPromotion);
        options.onMemoryReview?.(summary);
        options.onEvent?.(`memory review: ${summary.created} candidates, ${summary.autoPromoted} auto-promoted, ${summary.pending} pending, ${summary.conflicts} conflicts`);
        for (const line of formatMemoryReviewSummary(summary).split(/\r?\n/).slice(1)) {
          options.onEvent?.(line);
        }
      }
      const skillCandidates = skills.appendCandidates(output.step.skillCandidates, session, runId, agent.id);
      if (skillCandidates.length) {
        options.onEvent?.(`skill review: ${skillCandidates.length} candidates pending`);
        for (const candidate of skillCandidates) {
          options.onEvent?.(`skill candidate: ${candidate.id.slice(0, 8)} ${candidate.riskLevel} ${candidate.agentId}/${candidate.skillId}`);
        }
      }
      break;
    }
    if (forceFinal) {
      options.onEvent?.("tool_call rejected because tool call budget is exhausted");
      toolResults.push(
        "Runtime rejection: tool call budget is exhausted. Return a final answer now using the available tool results. Do not call another tool."
      );
      continue;
    }
    const result = await tools.execute(output.step.tool, output.step.args, {
      workspaceRoot,
      allowedTools: agent.allowedTools,
      approveOverwrite: options.approveOverwriteFiles ? approveOverwrite : async () => false,
      policyAudit: recordPolicyEvent
    });
    toolCallCount += 1;
    options.onEvent?.(`tool ${output.step.tool} ${result.ok ? "ok" : "failed"}`);
    toolNames.push(output.step.tool);
    toolResults.push(`Tool: ${output.step.tool}\nArgs: ${JSON.stringify(output.step.args)}\nOK: ${result.ok}\n${result.content}`);
  }

  if (!finalContent) {
    throw new Error(`Run did not produce a final answer after ${maxToolCalls} tool calls. Last step: ${JSON.stringify(lastStep)}`);
  }

  await sessions.appendContext(session.id, contextEntry(options.prompt, finalContent, toolNames, agent.id));
  if (options.refreshReferenceMemoryAfterRun ?? options.refreshReferenceMemory ?? true) {
    await memory.writeReferenceMemory(session, options.prompt, agent.id);
  }
  return finalContent;
}

async function complete(provider: ModelProvider, prompt: string, sessionId: string) {
  return provider.complete({ prompt, sessionId });
}

function contextEntry(prompt: string, finalContent: string, toolNames: string[], agentId: string): string {
  return `## Run ${new Date().toISOString()}

Agent:
${agentId}

Prompt:
${prompt}

Tools:
${toolNames.length ? toolNames.join(", ") : "none"}

Final:
${finalContent}
`;
}

function hasObservationTool(toolNames: string[], observationTools: string[]): boolean {
  return toolNames.some((tool) => observationTools.includes(tool));
}

function requiresFileRead(prompt: string, policy: { fileInspection: { requiresReadFile: boolean; triggerPhrases: string[] } }): boolean {
  return policy.fileInspection.requiresReadFile && asksForActualFiles(prompt, policy.fileInspection.triggerPhrases);
}

function asksForActualFiles(prompt: string, triggerPhrases: string[]): boolean {
  const normalized = prompt.toLowerCase();
  return triggerPhrases.some((needle) => normalized.includes(needle.toLowerCase()));
}

function runtimeRetryInstruction(ruleId: string, policy: { requireTools: { observationTools: string[] } }): string {
  if (ruleId === "runtime.require_tools.observation") {
    return `Call one observation tool first: ${policy.requireTools.observationTools.join(", ")}.`;
  }
  if (ruleId === "runtime.file_inspection.read_file_required") {
    return "Call read_file on a relevant path before returning final.";
  }
  return "Return a policy-compliant AgentStep.";
}
