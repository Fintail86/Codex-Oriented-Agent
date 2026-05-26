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
import { checkCommandTriggers, formatCommandTriggerCheck, formatCommandTriggerSync, syncCommandTriggers } from "../runtime/runtime_command_triggers.js";
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
import {
  applyPendingApproval,
  cancelPendingApproval,
  formatPendingApprovals,
  getPendingApprovalSummary
} from "../runtime/pending_approvals.js";
import { applyRuntimeConfigMigration, buildRuntimeConfigMigration, formatConfigCheck, formatConfigShow, repairRuntimeConfig } from "../runtime/runtime_config.js";
import { runChatRepl } from "../runtime/repl.js";
import { formatReviewCleanup, formatReviewInbox, formatReviewStats, ReviewInboxService } from "../runtime/review_inbox.js";
import { runSession } from "../runtime/runner.js";
import { SessionManager } from "../runtime/session_manager.js";
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
  startTelegramGateway,
  unlockStaleTelegramGateway
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

export function registerStatusDoctorCommands(program: Command): void {
  program
    .command("status")
    .option("--provider <provider>", "Provider smoke check override: active profile default, a provider profile name, provider id, or mock", "default")
    .option("--compact", "Print a compact status summary.", false)
    .option("--json", "Print structured JSON status.", false)
    .description("Show workspace, runtime, memory, session, and provider status.")
    .action(async (options: { provider: string; compact: boolean; json: boolean }) => {
      await main(async (workspaceRoot) => {
        const report = await getStatusReport(workspaceRoot, options.provider);
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(formatStatusReport(report, { compact: options.compact }));
        }
      });
    });

  const doctor = program.command("doctor").description("Diagnose and safely repair COSIA workspace health.");

  doctor
    .action(async () => {
      await main(async (workspaceRoot) => {
        const report = await getDoctorReport(workspaceRoot);
        console.log(formatDoctorReport(report));
      });
    });

  doctor
    .command("repair")
    .description("Run deterministic, idempotent safe repairs.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        console.log(formatDoctorRepair(await repairDoctor(workspaceRoot)));
      });
    });

  doctor
    .command("reset")
    .option("--state", "Reset runtime state only.", false)
    .option("--factory", "Reset COSIA runtime workspace configuration and state.", false)
    .option("--yes", "Apply the reset. Without this, only preview.", false)
    .option("--confirm <phrase>", "Required confirmation phrase when applying.")
    .description("Preview or apply a safe two-phase COSIA reset.")
    .action(async (options: { state: boolean; factory: boolean; yes: boolean; confirm?: string }) => {
      await main(async (workspaceRoot) => {
        const mode = resolveResetMode(options);
        const result = options.yes
          ? await applyReset(workspaceRoot, mode, options.confirm)
          : await previewReset(workspaceRoot, mode);
        console.log(formatResetResult(result));
      });
    });
}

export function registerPendingApprovalCommands(program: Command): void {
  program
    .command("pending")
    .description("Show durable pending approvals and in-chat apply guidance.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        console.log(formatPendingApprovals(getPendingApprovalSummary(workspaceRoot)));
      });
    });

  program
    .command("apply")
    .argument("<id>")
    .option("--yes", "Apply the pending approval. Without this, only preview.", false)
    .option("--confirm <phrase>", "Confirmation phrase for high-risk shell approvals.")
    .description("Apply a durable pending approval by id.")
    .action(async (id: string, options: { yes: boolean; confirm?: string }) => {
      await main(async (workspaceRoot) => {
        const result = await applyPendingApproval(workspaceRoot, id, {
          yes: options.yes,
          confirm: options.confirm
        });
        console.log(result.content);
        if (!result.ok && options.yes) {
          process.exitCode = 1;
        }
      });
    });

  program
    .command("cancel")
    .argument("<id>")
    .requiredOption("--reason <reason>", "Reason to preserve with the cancelled approval.")
    .description("Cancel a durable pending approval by id without deleting evidence.")
    .action(async (id: string, options: { reason: string }) => {
      await main(async (workspaceRoot) => {
        console.log(cancelPendingApproval(workspaceRoot, id, options.reason).content);
      });
    });
}

export function registerMvpReviewImproveCommandCommands(program: Command): void {
  const mvp = program.command("mvp").description("Historical/manual acceptance helpers.");

  mvp
    .command("checklist")
    .description("Print the manual COSIA MVP acceptance checklist.")
    .action(() => {
      console.log(formatMvpChecklist());
    });

  const reviewCommand = program
    .command("review")
    .option("--memory", "Show pending memory candidates only.", false)
    .option("--skill", "Show pending skill candidates only.", false)
    .description("Show the read-only memory and skill review inbox.")
    .action(async (options: { memory: boolean; skill: boolean }) => {
      await main(async (workspaceRoot) => {
        if (options.memory && options.skill) {
          throw new Error("Use at most one filter: --memory or --skill.");
        }
        const filter = options.memory ? "memory" : options.skill ? "skill" : "all";
        console.log(formatReviewInbox(await new ReviewInboxService(workspaceRoot).list(filter)));
      });
    });

  reviewCommand
    .command("stats")
    .description("Show review queue statistics and cleanup recommendations.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        const policy = await new PolicyManager(workspaceRoot).loadPolicy();
        console.log(formatReviewStats(await new ReviewInboxService(workspaceRoot).stats({
          discardedRetentionDays: policy.review.discardedRetentionDays,
          pendingWarningDays: policy.review.pendingWarningDays
        })));
      });
    });

  reviewCommand
    .command("cleanup")
    .option("--yes", "Apply cleanup. Without this, only preview.", false)
    .description("Clean up discarded review candidates after retention.")
    .action(async (options: { yes: boolean }) => {
      await main(async (workspaceRoot) => {
        const policy = await new PolicyManager(workspaceRoot).loadPolicy();
        console.log(formatReviewCleanup(await new ReviewInboxService(workspaceRoot).cleanup({
          olderThanDays: policy.review.discardedRetentionDays,
          yes: options.yes
        })));
      });
    });

  const improveCommand = program.command("improve").description("Advanced: inspect and apply governed self-improvement candidates.");

  improveCommand
    .command("status")
    .description("Show self-improvement backlog and evidence status.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        const policy = await new PolicyManager(workspaceRoot).loadPolicy();
        console.log(formatImproveStatus(await new SelfImprovementGovernor(workspaceRoot).status(policy)));
      });
    });

  improveCommand
    .command("preview")
    .description("Preview eligible backlog improvements without changing files or DB state.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        const policy = await new PolicyManager(workspaceRoot).loadPolicy();
        console.log(formatImprovePreview(await new SelfImprovementGovernor(workspaceRoot).preview(policy)));
      });
    });

  improveCommand
    .command("apply")
    .option("--yes", "Apply eligible improvements after re-evaluating backlog.", false)
    .description("Apply eligible self-improvements. Requires --yes.")
    .action(async (options: { yes: boolean }) => {
      await main(async (workspaceRoot) => {
        if (!options.yes) {
          throw new Error("Refusing to apply improvements without --yes. Run `cosia improve preview` first.");
        }
        const policy = await new PolicyManager(workspaceRoot).loadPolicy();
        console.log(formatImproveApply(await new SelfImprovementGovernor(workspaceRoot).applyBacklog(policy)));
      });
    });

  improveCommand
    .command("review")
    .description("List improvement evidence records.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        console.log(formatImproveRecords(new SelfImprovementGovernor(workspaceRoot).listRecords(true)));
      });
    });

  improveCommand
    .command("show")
    .argument("<id>")
    .description("Show an improvement evidence record.")
    .action(async (id: string) => {
      await main(async (workspaceRoot) => {
        console.log(formatImprovementDetail(new SelfImprovementGovernor(workspaceRoot).getRecord(id)));
      });
    });

  improveCommand
    .command("revert")
    .argument("<id>")
    .requiredOption("--reason <reason>", "Revert reason.")
    .description("Revert an applied automatic improvement.")
    .action(async (id: string, options: { reason: string }) => {
      await main(async (workspaceRoot) => {
        console.log(formatImprovementMutation("Reverted", await new SelfImprovementGovernor(workspaceRoot).revert(id, options.reason)));
      });
    });

  improveCommand
    .command("discard")
    .argument("<id>")
    .requiredOption("--reason <reason>", "Discard reason.")
    .description("Discard an improvement recommendation or blocked record.")
    .action(async (id: string, options: { reason: string }) => {
      await main(async (workspaceRoot) => {
        console.log(formatImprovementMutation("Discarded", await new SelfImprovementGovernor(workspaceRoot).discard(id, options.reason)));
      });
    });

  const commandCommand = program.command("command").description("Debug: inspect runtime command metadata.");
  const triggerCommand = commandCommand.command("triggers").description("Manage hash command trigger packs.");

  triggerCommand
    .command("check")
    .option("--locale <locale>", "Locale to check.", "ko")
    .description("Check command trigger pack conflicts and short triggers.")
    .action(async (options: { locale: string }) => {
      await main(async (workspaceRoot) => {
        console.log(formatCommandTriggerCheck(checkCommandTriggers(workspaceRoot, options.locale)));
      });
    });

  triggerCommand
    .command("sync")
    .option("--locale <locale>", "Locale to sync.", "ko")
    .description("Create or update a user command trigger override pack.")
    .action(async (options: { locale: string }) => {
      await main(async (workspaceRoot) => {
        console.log(formatCommandTriggerSync(syncCommandTriggers(workspaceRoot, options.locale)));
      });
    });

  program
    .command("init")
    .description("Create the default runtime directory structure and Codex templates.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        const created = await initProject(workspaceRoot);
        console.log(`Initialized runtime in ${workspaceRoot}`);
        console.log(created.map((item) => `- ${item}`).join("\n"));
      }, { allowUninitialized: true });
    });
}

export function registerStartRunChatCommands(program: Command): void {
  program
    .command("start")
    .option("--session <session-id>", "Use an existing session.")
    .option("--new-session", "Create a new session.", false)
    .option("--goal <goal>", "Goal for --new-session.")
    .option("--provider <provider>", "Model provider for the suggested or launched chat.", "default")
    .option("--no-chat", "Do not enter chat; print the selected next command.")
    .description("Guided entrypoint for choosing or creating a session.")
    .action(async (options: { session?: string; newSession: boolean; goal?: string; provider: string; chat?: boolean }) => {
      await main(async (workspaceRoot) => {
        const enterChat = options.chat !== false;
        const agents = new AgentManager(workspaceRoot);
        const sessions = new SessionManager(workspaceRoot);
        const policy = await new PolicyManager(workspaceRoot).loadPolicy();
        const [agentList, sessionList, report] = await Promise.all([
          agents.listAgents(),
          sessions.listSessions(),
          getStatusReport(workspaceRoot, options.provider)
        ]);
        const recommendation = recommendStartSession(sessionList, agentList);
        console.log(formatStartOverview({
          agents: agentList,
          sessions: sessionList,
          defaultAgentId: policy.agents.defaultAgentId,
          providerId: report.providerId,
          issues: report.issues,
          recommendation
        }));

        if (!agentList.length) {
          console.log("\nNo agents are available. Run `cosia agent bootstrap` first.");
          return;
        }

        let selectedSession: SessionMetadata | undefined;
        if (options.session) {
          selectedSession = await sessions.loadSession(options.session);
        } else if (options.newSession) {
          selectedSession = await createStartSession(workspaceRoot, options.goal ?? await askOnce("New session goal: "));
        } else if (!enterChat) {
          selectedSession = recommendation.session;
        } else {
          console.log("");
          console.log(formatSessionChoices(sessionList, recommendation.session));
          const choice = sessionFromChoice(await askOnce("start> "), sessionList, recommendation.session);
          if (choice === "quit") {
            console.log("Start cancelled.");
            return;
          }
          if (choice === "new") {
            selectedSession = await createStartSession(workspaceRoot, await askOnce("New session goal: "));
          } else if (choice) {
            selectedSession = choice;
          } else {
            throw new Error("Invalid session selection.");
          }
        }

        if (!selectedSession) {
          console.log("\nNo usable session selected.");
          console.log("Next: cosia start --new-session --goal \"<goal>\"");
          return;
        }

        console.log(`\nSelected session: ${selectedSession.id}`);
        console.log(`Provider: ${report.providerId}`);
        console.log(`Assigned agent: ${selectedSession.assignedAgentId ?? "none"}`);
        if (report.pendingCandidatesCount > 0 || report.pendingSkillCandidatesCount > 0) {
          console.log(`Review inbox: ${report.pendingCandidatesCount} memory, ${report.pendingSkillCandidatesCount} skill pending. In chat, use /review.`);
        }
        const chatCommand = `cosia chat --session ${selectedSession.id} --provider ${report.providerId}`;
        if (!enterChat) {
          console.log(`Next: ${chatCommand}`);
          return;
        }
        if (!report.providerOk) {
          console.log(`Provider ${report.providerId} is not ready.`);
          console.log(`Reason: ${report.providerReason ?? "unknown"}`);
          console.log(`Message: ${report.providerMessage}`);
          if (report.providerHint) {
            console.log(`Hint: ${report.providerHint}`);
          }
          console.log("Next:");
          console.log("  cosia provider setup");
          console.log("  cosia provider profile use <name>");
          console.log("  cosia provider profile check <name>");
          return;
        }
        console.log(`[cosia] entering chat. Equivalent command: ${chatCommand}`);
        await runChatRepl({
          workspaceRoot,
          sessionId: selectedSession.id,
          providerId: report.providerId
        });
      });
    });

  program
    .command("run")
    .requiredOption("--session <session-id>", "Session id")
    .requiredOption("--prompt <prompt>", "Current user request")
    .option("--agent <agent-id>", "Agent id for this run. Overrides the session assignment without changing it.")
    .option("--provider <provider>", "Provider override: provider profile name, provider id, or mock")
    .option("--provider-timeout-ms <ms>", "Override provider call timeout in milliseconds")
    .option("--approve-overwrite", "Allow interactive overwrite approval prompts", false)
    .option("--require-tools", "Require at least one read_file or search_files call before final.", false)
    .option("--skill <skill-id...>", "Manually include one or more global skills.")
    .description("Run a session turn.")
    .action(async (options: { session: string; prompt: string; agent?: string; provider?: string; providerTimeoutMs?: string; approveOverwrite: boolean; requireTools: boolean; skill?: string[] }) => {
      await main(async (workspaceRoot) => {
        const { withSessionLock } = await import("../runtime/gateway_locks.js");
        const content = await withSessionLock(workspaceRoot, options.session, {
          owner: "cli:run"
        }, async () => runSession(workspaceRoot, {
            sessionId: options.session,
            prompt: options.prompt,
            agentId: options.agent,
            providerId: options.provider,
            providerTimeoutMs: options.providerTimeoutMs ? Number.parseInt(options.providerTimeoutMs, 10) : undefined,
            approveOverwriteFiles: options.approveOverwrite,
            requireTools: options.requireTools,
            manualSkillIds: options.skill,
            onEvent: (message) => console.error(`[cosia] ${message}`)
          }));
        console.log(content);
      });
    });

  program
    .command("chat")
    .requiredOption("--session <session-id>", "Session id")
    .option("--agent <agent-id>", "Agent id for this chat. Overrides the session assignment without changing it.")
    .option("--provider <provider>", "Provider override: provider profile name, provider id, or mock")
    .option("--provider-timeout-ms <ms>", "Override provider call timeout in milliseconds")
    .option("--approve-overwrite", "Allow interactive overwrite approval prompts", false)
    .option("--require-tools", "Require at least one read_file or search_files call before final.", false)
    .option("--skill <skill-id...>", "Manually include one or more global skills.")
    .description("Enter a simple session REPL.")
    .action(async (options: { session: string; agent?: string; provider?: string; providerTimeoutMs?: string; approveOverwrite: boolean; requireTools: boolean; skill?: string[] }) => {
      await main(async (workspaceRoot) => {
        await runChatRepl({
          workspaceRoot,
          sessionId: options.session,
          agentId: options.agent,
          providerId: options.provider,
          providerTimeoutMs: options.providerTimeoutMs ? Number.parseInt(options.providerTimeoutMs, 10) : undefined,
          approveOverwriteFiles: options.approveOverwrite,
          requireTools: options.requireTools,
          manualSkillIds: options.skill
        });
      });
    });
}
