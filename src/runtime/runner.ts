import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { approveOverwrite } from "./approval_gate.js";
import { AgentManager } from "./agent_manager.js";
import { formatMemoryReviewSummary, MemoryManager } from "./memory_manager.js";
import { formatProviderFailure, ProviderError } from "./model/provider_errors.js";
import { createProvider, resolveProviderSelection } from "./model/provider_registry.js";
import { PolicyAuditLog } from "./policy_audit.js";
import { PolicyEngine } from "./policy_engine.js";
import { PolicyManager } from "./policy_manager.js";
import { appendPromptManifest, buildPromptBundle, type PromptBlock } from "./prompt_builder.js";
import { SelfImprovementGovernor } from "./self_improvement.js";
import { SessionManager } from "./session_manager.js";
import { SkillManager } from "./skill_manager.js";
import { ToolRegistry } from "./tool_registry.js";
import type { AgentStep, ModelProvider, OverwriteApprovalRequest, ToolName } from "./types.js";
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
  onOverwriteApprovalRequired?: (request: OverwriteApprovalRequest) => Promise<void> | void;
  stopAfterOverwriteApprovalRequired?: boolean;
  manualSkillIds?: string[];
  agentId?: string;
  sourceChannel?: "cli" | "repl" | "gateway";
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

  const providerId = options.provider ? options.provider.id : resolveProviderSelection(policy, options.providerId);
  let provider: ModelProvider | undefined;
  try {
    provider = options.provider ?? createProvider(providerId, workspaceRoot, {
      policy,
      timeoutMs: options.providerTimeoutMs
    });
    if (provider.id !== "mock") {
      const auth = await provider.checkAuth();
      if (!auth.ok) {
        throw new ProviderError(auth.reason ?? "auth_failed", `Model provider auth failed: ${auth.message}`, {
          hint: auth.hint
        });
      }
    }
  } catch (error) {
    throw new Error(formatProviderFailure(error, provider?.id ?? providerId));
  }
  if (!provider) {
    throw new Error(`Provider ${providerId} was not created.`);
  }

  const toolResults: string[] = [];
  const toolNames: ToolName[] = [];
  let finalContent = "";
  let lastStep: AgentStep | undefined;
  let overwriteApprovalRequired = false;
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
    await sessions.writeLastTurnDebug(session.id, {
      userMessage: options.prompt,
      prompt,
      runId,
      modelStep: depth + 1,
      promptChars: promptResult.manifest.promptChars,
      estimatedTokens: promptResult.manifest.estimatedTokens,
      timestamp: promptResult.manifest.timestamp
    });
    const output = await complete(provider, prompt, session.id).catch((error: unknown) => {
      throw new Error(formatProviderFailure(error, provider.id));
    });
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
      const skillCandidates = skills.appendCandidates(output.step.skillCandidates, session, runId, agent.id);
      try {
        const improve = await new SelfImprovementGovernor(workspaceRoot).afterRun({
          policy,
          session,
          agentId: agent.id,
          runId,
          memoryCandidates: candidates,
          skillCandidates
        });
        if (improve.memorySummary) {
          options.onMemoryReview?.(improve.memorySummary);
          options.onEvent?.(`memory review: ${improve.memorySummary.created} candidates, ${improve.memorySummary.autoPromoted} auto-promoted, ${improve.memorySummary.pending} pending, ${improve.memorySummary.conflicts} conflicts`);
          for (const line of formatMemoryReviewSummary(improve.memorySummary).split(/\r?\n/).slice(1)) {
            options.onEvent?.(line);
          }
        }
        if (candidates.length || skillCandidates.length || improve.applied.length || improve.blocked.length || improve.failed.length) {
          options.onEvent?.(`[improve] memory/skill applied:${improve.applied.length} blocked:${improve.blocked.length} failed:${improve.failed.length}`);
        }
      } catch (error) {
        options.onEvent?.(`[improve] failed: ${(error as Error).message}`);
      }
      if (candidates.length || skillCandidates.length) {
        options.onEvent?.("review: use /review in chat or `cosia review`.");
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
      sessionId: session.id,
      agentId: agent.id,
      runId,
      sourceChannel: options.sourceChannel ?? "cli",
      approveOverwrite: options.approveOverwriteFiles ? approveOverwrite : async () => false,
      onOverwriteApprovalRequired: async (request) => {
        overwriteApprovalRequired = true;
        await options.onOverwriteApprovalRequired?.(request);
      },
      policyAudit: recordPolicyEvent
    });
    toolCallCount += 1;
    options.onEvent?.(`tool ${output.step.tool} ${result.ok ? "ok" : "failed"}`);
    toolNames.push(output.step.tool);
    toolResults.push(`Tool: ${output.step.tool}\nArgs: ${JSON.stringify(output.step.args)}\nOK: ${result.ok}\n${result.content}`);
    if (overwriteApprovalRequired && options.stopAfterOverwriteApprovalRequired) {
      finalContent = "File overwrite approval is pending. The requested file change has not been applied yet.";
      break;
    }
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
