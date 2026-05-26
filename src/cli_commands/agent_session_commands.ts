import type { Command } from "commander";
import {
  AgentManager,
  formatAgentDeleteResult,
  formatAgentRecommendation
} from "../runtime/agent_manager.js";
import { initProject } from "../runtime/init_project.js";
import { applyReset, formatDoctorRepair, formatDoctorReport, formatResetResult, getDoctorReport, previewReset, repairDoctor } from "../runtime/doctor.js";
import { formatMemoryConflicts, formatMemoryReviewSummary, MemoryManager } from "../runtime/memory_manager.js";
import { formatMvpChecklist } from "../runtime/mvp_checklist.js";
import {
  CapabilityPlanner,
  capabilityScanJson,
  formatCapabilityFacts,
  formatCapabilityPlan,
  formatCapabilityProposal,
  formatCapabilityReview,
  formatCapabilityScan
} from "../runtime/capability.js";
import { checkProvider, createProvider, listProviders, resolveProviderSelection } from "../runtime/model/provider_registry.js";
import { registerProviderProfileCommands } from "./provider_profiles.js";
import { formatProviderFailure, ProviderError } from "../runtime/model/provider_errors.js";
import { formatPolicyAuditEvents, PolicyAuditLog } from "../runtime/policy_audit.js";
import { formatPolicySummary, PolicyManager } from "../runtime/policy_manager.js";
import { applyRuntimeConfigMigration, buildRuntimeConfigMigration, formatConfigCheck, formatConfigShow, repairRuntimeConfig } from "../runtime/runtime_config.js";
import { runChatRepl } from "../runtime/repl.js";
import { formatReviewCleanup, formatReviewInbox, formatReviewStats, ReviewInboxService } from "../runtime/review_inbox.js";
import { runSession } from "../runtime/runner.js";
import { formatLastTurnDebug, SessionManager, type LastTurnDebugPart } from "../runtime/session_manager.js";
import {
  formatImprovementDetail,
  formatImprovementMutation,
  formatImproveApply,
  formatImprovePreview,
  formatImproveRecords,
  formatImproveStatus,
  SelfImprovementGovernor
} from "../runtime/self_improvement.js";
import { formatSkillCandidate, formatSkillCheckResult, formatSkillPromotionPreview, formatSkillSelectionExplanation, SkillManager } from "../runtime/skill_manager.js";
import { formatStatusReport, getStatusReport } from "../runtime/status_report.js";
import { formatSessionChoices, formatStartOverview, recommendStartSession, sessionFromChoice } from "../runtime/start_flow.js";
import { formatGatewayStatus, formatGatewayStopResult, formatGatewayUnlockResult, restartGateway, startGateway, stopGateway, unlockStaleGateway } from "../runtime/gateway_supervisor.js";
import {
  checkTelegramGateway,
  formatTelegramCheck,
  formatTelegramStateInspection,
  formatTelegramStateRepair,
  formatTelegramStateReset,
  inspectTelegramGatewayState,
  repairTelegramGatewayState,
  resetTelegramGatewayState,
  resolveTelegramToken,
  startTelegramGateway
} from "../runtime/telegram_gateway.js";
import {
  addTelegramChatId,
  enableTelegramConnector,
  formatTelegramConnectorList,
  removeTelegramChatId,
  setTelegramToken,
  setTelegramTokenEnv,
  unsetTelegramToken,
  unsetTelegramTokenEnv
} from "../runtime/telegram_connector_config.js";
import { getToolCatalogEntry, isToolId, toolCatalog, toolNameValues } from "../runtime/tool_catalog.js";
import { ToolRegistry } from "../runtime/tool_registry.js";
import { formatShellApprovalList, formatShellApprovalPreview, ShellApprovalLedger } from "../runtime/shell_approval.js";
import { memoryTierSchema } from "../runtime/types.js";
import type { SessionMetadata } from "../runtime/types.js";
import {
  formatActiveTool,
  formatActiveToolList,
  formatActiveToolVisibility,
  formatLearnedBlueprint,
  formatLearnedBlueprintList,
  formatToolActivation,
  formatToolActivationPreview,
  formatToolCandidate,
  formatToolCandidateReview,
  formatToolCandidateTestRun,
  formatToolDraftResult,
  ToolAcquisitionManager
} from "../runtime/tool_acquisition.js";
import {
  formatToolGrowthActivation,
  formatToolGrowthCancelled,
  formatToolGrowthRejected,
  formatToolGrowthReview,
  formatToolGrowthRoutine,
  formatToolGrowthStart,
  formatToolGrowthTest,
  ToolGrowthManager
} from "../runtime/tool_growth.js";
import {
  askOnce,
  contextCriticalHint,
  contextMaintenanceHint,
  createStartSession,
  formatContextCompactResult,
  formatContextHealth,
  formatContextStatus,
  formatPromptManifest,
  formatToolCatalog,
  main,
  normalizeCliToolId,
  parseCliToolArgs,
  parseIntegerOption,
  parseJsonObjectOption,
  parseNumberOption,
  printSessionList,
  promptHidden,
  readRawPolicy,
  resolveBootstrapOptions,
  resolveMemoryTierOptions,
  resolveResetMode,
  runCliTool,
  splitList,
  generateSessionSummary,
  type ToolCliOptions
} from "./shared.js";

export function registerAgentSessionCommands(program: Command): void {
  const agent = program.command("agent").description("Manage agents.");

  agent
    .command("create")
    .argument("<agent-id>")
    .option("--template <template>", "Agent template: cosia or architect", "architect")
    .description("Create an agent from a template.")
    .action(async (agentId: string, options: { template: string }) => {
      await main(async (workspaceRoot) => {
        const manager = new AgentManager(workspaceRoot);
        const manifest = await manager.createAgent(agentId, options.template);
        console.log(`Created agent ${manifest.id}`);
      });
    });

  agent
    .command("list")
    .description("List agents.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        const policy = await new PolicyManager(workspaceRoot).loadPolicy();
        const agents = await new AgentManager(workspaceRoot).listAgents();
        if (!agents.length) {
          console.log("No agents. Run `cosia agent bootstrap` to create one.");
          return;
        }
        for (const item of agents) {
          const marker = item.id === policy.agents.defaultAgentId ? "default" : "available";
          console.log(`${item.id}\t${marker}\t${item.name}\t${item.identity.role}`);
        }
      });
    });

  agent
    .command("show")
    .argument("<agent-id>")
    .description("Show agent identity, selection triggers, tools, and skill preferences.")
    .action(async (agentId: string) => {
      await main(async (workspaceRoot) => {
        const agent = await new AgentManager(workspaceRoot).loadAgent(agentId);
        console.log(JSON.stringify({
          id: agent.id,
          name: agent.name,
          description: agent.description,
          identity: agent.identity,
          selectionTriggers: agent.selectionTriggers,
          allowedTools: agent.allowedTools,
          preferredSkills: agent.preferredSkills,
          blockedSkills: agent.blockedSkills,
          skillWeights: agent.skillWeights
        }, null, 2));
      });
    });

  const agentDefault = agent.command("default").description("Manage the default agent.");

  agentDefault
    .command("show")
    .description("Show the current default agent.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        const policy = await new PolicyManager(workspaceRoot).loadPolicy();
        console.log(policy.agents.defaultAgentId ?? "No default agent. Run `cosia agent bootstrap` to create one.");
      });
    });

  agentDefault
    .command("set")
    .argument("<agent-id>")
    .description("Set the default agent.")
    .action(async (agentId: string) => {
      await main(async (workspaceRoot) => {
        await new AgentManager(workspaceRoot).loadAgent(agentId);
        await new PolicyManager(workspaceRoot).setDefaultAgent(agentId);
        console.log(`Default agent set to ${agentId}`);
      });
    });

  agent
    .command("bootstrap")
    .option("--id <agent-id>", "Agent id")
    .option("--name <name>", "Display name")
    .option("--role <role>", "Agent role")
    .option("--voice <voice>", "Agent voice")
    .option("--priorities <items>", "Comma-separated priorities")
    .option("--boundaries <items>", "Comma-separated boundaries")
    .description("Create a new guided agent and set it as the default.")
    .action(async (options: { id?: string; name?: string; role?: string; voice?: string; priorities?: string; boundaries?: string }) => {
      await main(async (workspaceRoot) => {
        const answers = await resolveBootstrapOptions(options);
        const manager = new AgentManager(workspaceRoot);
        const manifest = await manager.bootstrapAgent({
          id: answers.id,
          name: answers.name,
          role: answers.role,
          voice: answers.voice,
          priorities: splitList(answers.priorities),
          boundaries: splitList(answers.boundaries)
        });
        await new PolicyManager(workspaceRoot).setDefaultAgent(manifest.id);
        console.log(`Bootstrapped agent ${manifest.id}`);
        console.log(`Default agent set to ${manifest.id}`);
      });
    });

  agent
    .command("delete")
    .argument("<agent-id>")
    .option("--yes", "Actually delete the agent.", false)
    .option("--force", "Allow deleting agents referenced by sessions.", false)
    .option("--allow-empty", "Allow deleting the default or last agent.", false)
    .description("Preview or delete an agent.")
    .action(async (agentId: string, options: { yes: boolean; force: boolean; allowEmpty: boolean }) => {
      await main(async (workspaceRoot) => {
        const policyManager = new PolicyManager(workspaceRoot);
        const policy = await policyManager.loadPolicy();
        const result = await new AgentManager(workspaceRoot).deleteAgent(agentId, {
          yes: options.yes,
          force: options.force,
          allowEmpty: options.allowEmpty,
          defaultAgentId: policy.agents.defaultAgentId
        });
        if (result.changed && result.isDefault) {
          await policyManager.setDefaultAgent(null);
        }
        if (result.changed) {
          const archived = new MemoryManager(workspaceRoot).archiveOwnerMemories("agent", agentId, `Agent deleted: ${agentId}`);
          if (archived) {
            console.log(`Archived ${archived} agent memory record(s).`);
          }
        }
        console.log(formatAgentDeleteResult(result));
        if (result.changed && result.isDefault) {
          console.log("No default agent is configured. Run `cosia agent bootstrap` to create one.");
        }
      });
    });

  agent
    .command("recommend")
    .requiredOption("--prompt <prompt>", "Current request")
    .option("--goal <goal>", "Optional session goal", "")
    .option("--explain", "Show deterministic scoring table.", false)
    .description("Recommend an agent for a prompt without changing session state.")
    .action(async (options: { prompt: string; goal: string; explain: boolean }) => {
      await main(async (workspaceRoot) => {
        const policy = await new PolicyManager(workspaceRoot).loadPolicy();
        const rows = await new AgentManager(workspaceRoot).recommendAgent({
          prompt: options.prompt,
          goal: options.goal,
          defaultAgentId: policy.agents.defaultAgentId
        });
        if (options.explain) {
          console.log(formatAgentRecommendation(rows));
        } else {
          console.log(rows[0]?.agentId ?? "No agents. Run `cosia agent bootstrap` to create one.");
        }
      });
    });

  agent
    .command("sessions")
    .argument("<agent-id>")
    .description("List sessions currently assigned to an agent.")
    .action(async (agentId: string) => {
      await main(async (workspaceRoot) => {
        await new AgentManager(workspaceRoot).loadAgent(agentId);
        const sessions = await new SessionManager(workspaceRoot).listSessions({ agentId });
        if (!sessions.length) {
          console.log(`No sessions assigned to ${agentId}.`);
          return;
        }
        await printSessionList(workspaceRoot, sessions);
      });
    });

  const session = program.command("session").description("Manage sessions.");

  session
    .command("create")
    .option("--agent <agent-id>", "Agent id. Defaults to policy agents.defaultAgentId.")
    .requiredOption("--goal <goal>", "Session goal")
    .description("Create a session for an agent.")
    .action(async (options: { agent?: string; goal: string }) => {
      await main(async (workspaceRoot) => {
        const agents = new AgentManager(workspaceRoot);
        const policy = await new PolicyManager(workspaceRoot).loadPolicy();
        const agentId = options.agent ?? policy.agents.defaultAgentId;
        if (!agentId) {
          throw new Error("No default agent is configured. Run `cosia agent bootstrap` or pass --agent <agent-id>.");
        }
        await agents.loadAgent(agentId);
        const sessions = new SessionManager(workspaceRoot);
        const metadata = await sessions.createSession(agentId, options.goal);
        console.log(metadata.id);
      });
    });

  session
    .command("list")
    .option("--agent <agent-id>", "Only show sessions assigned to this agent.")
    .description("List sessions.")
    .action(async (options: { agent?: string }) => {
      await main(async (workspaceRoot) => {
        const sessions = await new SessionManager(workspaceRoot).listSessions({ agentId: options.agent });
        if (!sessions.length) {
          console.log("No sessions.");
          return;
        }
        await printSessionList(workspaceRoot, sessions);
      });
    });

  session
    .command("assign")
    .argument("<session-id>")
    .requiredOption("--agent <agent-id>", "Agent id to assign.")
    .description("Assign a session to an existing agent.")
    .action(async (sessionId: string, options: { agent: string }) => {
      await main(async (workspaceRoot) => {
        await new AgentManager(workspaceRoot).loadAgent(options.agent);
        const metadata = await new SessionManager(workspaceRoot).assignAgent(sessionId, options.agent);
        console.log(`Assigned ${metadata.id} to ${metadata.assignedAgentId}`);
      });
    });

  session
    .command("unassign")
    .argument("<session-id>")
    .description("Remove a session's assigned agent.")
    .action(async (sessionId: string) => {
      await main(async (workspaceRoot) => {
        const metadata = await new SessionManager(workspaceRoot).assignAgent(sessionId, null);
        console.log(`Unassigned ${metadata.id}`);
      });
    });

  session
    .command("archive")
    .argument("<session-id>")
    .requiredOption("--reason <reason>", "Archive reason")
    .description("Archive a session and its session-tier memories.")
    .action(async (sessionId: string, options: { reason: string }) => {
      await main(async (workspaceRoot) => {
        const sessions = new SessionManager(workspaceRoot);
        const metadata = await sessions.archiveSession(sessionId);
        const archived = new MemoryManager(workspaceRoot).archiveOwnerMemories("session", sessionId, `Session archived: ${options.reason}`);
        console.log(`Archived session ${metadata.id}`);
        console.log(`Archived ${archived} session memory record(s).`);
      });
    });

  session
    .command("show")
    .argument("<session-id>")
    .option("--tail <chars>", "Context tail character count", "1200")
    .description("Show session metadata and recent working context.")
    .action(async (sessionId: string, options: { tail: string }) => {
      await main(async (workspaceRoot) => {
        const sessions = new SessionManager(workspaceRoot);
        const metadata = await sessions.loadSession(sessionId);
        const policy = await new PolicyManager(workspaceRoot).loadPolicy();
        const contextStatus = await sessions.contextStatus(sessionId, {
          warningChars: policy.promptBudget.contextWarningChars,
          criticalChars: policy.promptBudget.contextCriticalChars
        });
        console.log("# Session metadata\n");
        console.log(JSON.stringify(metadata, null, 2));
        console.log(`\n# Working context status\n`);
        console.log(formatContextStatus(contextStatus));
        console.log("\n# Next maintenance commands\n");
        if (contextStatus.level !== "ok" || contextStatus.compactRecommended) {
          console.log(contextMaintenanceHint(sessionId));
        } else {
          console.log("No context maintenance currently recommended.");
        }
        const tail = await sessions.contextTail(sessionId, Number.parseInt(options.tail, 10));
        console.log("\n# Working context tail\n");
        console.log(tail || "No working context yet.");
      });
    });

  session
    .command("summarize")
    .argument("<session-id>")
    .option("--content <summary>", "Compact session summary")
    .option("--from-context", "Generate a summary proposal from budgeted context.", false)
    .option("--provider <provider>", "Provider profile name or mock for --from-context")
    .option("--provider-timeout-ms <ms>", "Override provider timeout for --from-context")
    .option("--yes", "Write generated summary instead of previewing it.", false)
    .description("Write SESSION_SUMMARY.md for a session.")
    .action(async (sessionId: string, options: { content?: string; fromContext: boolean; provider?: string; providerTimeoutMs?: string; yes: boolean }) => {
      await main(async (workspaceRoot) => {
        const sessions = new SessionManager(workspaceRoot);
        const session = await sessions.loadSession(sessionId);
        if (options.content && options.fromContext) {
          throw new Error("Use either --content or --from-context, not both.");
        }
        if (!options.content && !options.fromContext) {
          throw new Error("Provide --content <summary> or --from-context.");
        }
        if (options.content) {
          await sessions.updateSummary(sessionId, options.content);
          console.log(`Updated ${sessionId} SESSION_SUMMARY.md`);
          return;
        }
        const policy = await new PolicyManager(workspaceRoot).loadPolicy();
        const providerId = resolveProviderSelection(policy, options.provider);
        const summary = await generateSessionSummary(workspaceRoot, session, providerId, {
          timeoutMs: options.providerTimeoutMs ? parseIntegerOption(options.providerTimeoutMs, "provider-timeout-ms") : undefined,
          contextChars: policy.promptBudget.contextTailChars
        });
        if (!options.yes) {
          console.log("# SESSION SUMMARY PREVIEW\n");
          console.log(summary);
          console.log(`\nRe-run with --yes to update sessions/${sessionId}/SESSION_SUMMARY.md.`);
          return;
        }
        await sessions.updateSummary(sessionId, summary);
        console.log(`Updated ${sessionId} SESSION_SUMMARY.md`);
      });
    });

  session
    .command("prompt")
    .argument("<session-id>")
    .option("--latest", "Show only the latest prompt manifest.", false)
    .option("--limit <n>", "Prompt manifest count", "1")
    .description("Show readable prompt budget manifests for a session; this is not debug/LAST_PROMPT.md.")
    .action(async (sessionId: string, options: { latest: boolean; limit: string }) => {
      await main(async (workspaceRoot) => {
        const sessions = new SessionManager(workspaceRoot);
        await sessions.loadSession(sessionId);
        const limit = options.latest ? 1 : parseIntegerOption(options.limit, "limit");
        const manifests = await sessions.listPromptManifests(sessionId, limit);
        if (!manifests.length) {
          console.log("No prompt manifests.");
          return;
        }
        console.log(manifests.map(formatPromptManifest).join("\n\n"));
      });
    });

  session
    .command("debug")
    .argument("<session-id>")
    .option("--part <part>", "Debug part: metadata, user-message, prompt, provider-prompt, provider-response, or all.", "metadata")
    .option("--max-chars <n>", "Maximum chars for prompt/user-message output.", "4000")
    .description("Inspect the last-turn diagnostic debug files for a session.")
    .action(async (sessionId: string, options: { part: string; maxChars: string }) => {
      await main(async (workspaceRoot) => {
        const sessions = new SessionManager(workspaceRoot);
        const record = await sessions.readLastTurnDebug(sessionId);
        if (!record) {
          console.log("No debug record yet. Run/chat once first.");
          return;
        }
        console.log(formatLastTurnDebug(record, {
          part: parseSessionDebugPart(options.part),
          maxChars: parseIntegerOption(options.maxChars, "max-chars")
        }));
      });
    });

  const sessionContext = session.command("context").description("Manage session context memory.");

  sessionContext
    .command("status")
    .argument("<session-id>")
    .description("Show session context maintenance status.")
    .action(async (sessionId: string) => {
      await main(async (workspaceRoot) => {
        const sessions = new SessionManager(workspaceRoot);
        await sessions.loadSession(sessionId);
        const policy = await new PolicyManager(workspaceRoot).loadPolicy();
        const status = await sessions.contextStatus(sessionId, {
          warningChars: policy.promptBudget.contextWarningChars,
          criticalChars: policy.promptBudget.contextCriticalChars
        });
        console.log(formatContextStatus(status));
        if (status.level !== "ok" || status.compactRecommended) {
          console.log(contextMaintenanceHint(sessionId));
        }
      });
    });

  sessionContext
    .command("undo-last")
    .argument("<session-id>")
    .requiredOption("--reason <reason>", "Archive reason")
    .description("Move the latest context run entry into CONTEXT_ARCHIVE.md.")
    .action(async (sessionId: string, options: { reason: string }) => {
      await main(async (workspaceRoot) => {
        const sessions = new SessionManager(workspaceRoot);
        await sessions.loadSession(sessionId);
        const result = await sessions.undoLastContextEntry(sessionId, options.reason);
        console.log(result.message);
        if (result.moved) {
          console.log(`Moved at: ${result.movedAt}`);
          console.log("Archive: CONTEXT_ARCHIVE.md");
        }
      });
    });

  sessionContext
    .command("compact")
    .argument("<session-id>")
    .requiredOption("--keep-last <n>", "Number of latest run entries to keep in CONTEXT_MEMORY.md.")
    .requiredOption("--reason <reason>", "Compaction reason.")
    .option("--yes", "Apply compaction. Without this, only preview.", false)
    .option("--allow-empty-summary", "Allow compaction while SESSION_SUMMARY.md is still placeholder.", false)
    .description("Move old context run blocks into CONTEXT_ARCHIVE.md.")
    .action(async (sessionId: string, options: { keepLast: string; reason: string; yes: boolean; allowEmptySummary: boolean }) => {
      await main(async (workspaceRoot) => {
        const sessions = new SessionManager(workspaceRoot);
        await sessions.loadSession(sessionId);
        const result = await sessions.compactContext(sessionId, {
          keepLast: parseIntegerOption(options.keepLast, "keep-last"),
          reason: options.reason,
          apply: options.yes,
          allowEmptySummary: options.allowEmptySummary
        });
        console.log(formatContextCompactResult(result));
        if (result.blocked) {
          console.log(contextMaintenanceHint(sessionId));
        } else if (!result.applied && result.archivedRuns > 0) {
          console.log(`Re-run with --yes to apply compaction for ${sessionId}.`);
        }
      });
    });
}

function parseSessionDebugPart(value: string): LastTurnDebugPart {
  if (
    value === "metadata"
    || value === "user-message"
    || value === "prompt"
    || value === "provider-prompt"
    || value === "provider-response"
    || value === "all"
  ) {
    return value;
  }
  throw new Error("Invalid debug part. Use metadata, user-message, prompt, provider-prompt, provider-response, or all.");
}
