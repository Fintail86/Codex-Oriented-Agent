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
import { formatSkillCandidate, formatSkillCheckResult, formatSkillMigrationResult, formatSkillPromotionPreview, formatSkillSelectionExplanation, SkillManager } from "../runtime/skill_manager.js";
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
import { memoryScopeSchema, memoryTierSchema } from "../runtime/types.js";
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

export function registerCapabilityShellCommands(program: Command): void {
  program
    .command("capability")
    .argument("[action]", "`scan`, `facts`, `plan`, `review`, `show`, or `discard`", "review")
    .argument("[id]", "Capability proposal id.")
    .option("--request <text>", "User request to ground a capability scan.")
    .option("--latest", "Show the latest capability fact scan.", false)
    .option("--scan-id <id>", "Show one capability fact scan by id.")
    .option("--json", "Print stable JSON output.", false)
    .option("--reason <reason>", "Reason for discard.")
    .option("--all", "Show all capability proposals.", false)
    .description("Advanced: scan facts and review zero-base capability proposals.")
    .action(async (action: string, id: string | undefined, options: { request?: string; latest: boolean; scanId?: string; json: boolean; reason?: string; all: boolean }) => {
      await main(async (workspaceRoot) => {
        const planner = new CapabilityPlanner(workspaceRoot);
        if (action === "scan") {
          const result = await planner.scan({ userNeed: options.request });
          console.log(options.json ? capabilityScanJson(result) : formatCapabilityScan(result));
          return;
        }
        if (action === "facts") {
          const result = planner.listFacts({ latest: options.latest || !options.scanId, scanId: options.scanId });
          console.log(options.json ? capabilityScanJson(result) : formatCapabilityFacts(result));
          return;
        }
        if (action === "plan") {
          if (!options.request) throw new Error("Usage: cosia capability plan --request \"<text>\"");
          console.log(formatCapabilityPlan(planner.plan({ userNeed: options.request })));
          return;
        }
        if (action === "review") {
          const proposals = planner.listProposals({ all: options.all });
          const warningsById = new Map(proposals.map((proposal) => [proposal.id, planner.integrityWarningsForProposal(proposal)]));
          console.log(formatCapabilityReview(proposals, warningsById));
          return;
        }
        if (action === "show") {
          if (!id) throw new Error("Usage: cosia capability show <id>");
          const proposal = planner.getProposal(id);
          console.log(formatCapabilityProposal(proposal, planner.groundingFactsForProposal(id), planner.integrityWarningsForProposal(proposal)));
          return;
        }
        if (action === "discard") {
          if (!id || !options.reason) throw new Error("Usage: cosia capability discard <id> --reason \"<reason>\"");
          const proposal = planner.discardProposal(id, options.reason);
          console.log(formatCapabilityProposal(proposal, planner.groundingFactsForProposal(id), planner.integrityWarningsForProposal(proposal)));
          return;
        }
        throw new Error(`Unknown capability action: ${action}`);
      });
    });

  program
    .command("shell")
    .argument("[action]", "`preview`, `apply`, `run`, `cancel`, or `status`", "status")
    .argument("[approval-id]", "Shell approval id.")
    .option("--command <command>", "Exact shell command for preview/run.")
    .option("--cwd <cwd>", "Workspace-relative working directory.", ".")
    .option("--reason <reason>", "Reason for requesting shell execution.")
    .option("--expected-effect <text>", "Expected shell command effect.")
    .option("--from-capability <id>", "Create a one-shot shell approval from a capability proposal.")
    .option("--yes", "Apply a newly created preview immediately.", false)
    .option("--confirm <phrase>", "Approval-id-bound confirmation phrase for high-risk commands.")
    .description("Advanced: create or inspect one-shot shell approvals. Use `cosia pending` for the normal queue.")
    .action(async (action: string, approvalId: string | undefined, options: {
      command?: string;
      cwd: string;
      reason?: string;
      expectedEffect?: string;
      fromCapability?: string;
      yes: boolean;
      confirm?: string;
    }) => {
      await main(async (workspaceRoot) => {
        const ledger = new ShellApprovalLedger(workspaceRoot);
        if (action === "status") {
          console.log(formatShellApprovalList(ledger.list().slice(0, 20)));
          return;
        }
        if (action === "preview") {
          if (options.fromCapability) {
            if (!options.command) {
              throw new Error("Usage: cosia shell preview --from-capability <proposal-id> --command \"<exact command>\"");
            }
            const result = new CapabilityPlanner(workspaceRoot).convertToShell(options.fromCapability, {
              command: options.command,
              cwd: options.cwd,
              reason: options.reason,
              expectedEffect: options.expectedEffect,
              sourceChannel: "cli"
            });
            if (result.didCreate && result.approval) {
              console.log(formatShellApprovalPreview(result.approval));
            } else {
              console.log(result.message ?? "No new shell approval was created.");
            }
            return;
          }
          if (!options.command || !options.reason) {
            throw new Error("Usage: cosia shell preview --command \"<command>\" --reason \"<reason>\"");
          }
          console.log(formatShellApprovalPreview(ledger.create({
            command: options.command,
            cwd: options.cwd,
            reason: options.reason,
            expectedEffect: options.expectedEffect,
            sourceChannel: "cli"
          })));
          return;
        }
        if (action === "apply") {
          if (!approvalId) throw new Error("Usage: cosia shell apply <approval-id>");
          const result = await ledger.apply(approvalId, { confirm: options.confirm });
          console.log(result.content);
          if (!result.ok) process.exitCode = 1;
          return;
        }
        if (action === "run") {
          if (options.fromCapability) {
            if (!options.command || !options.yes) {
              throw new Error("Usage: cosia shell run --from-capability <proposal-id> --command \"<exact command>\" --yes");
            }
            const result = new CapabilityPlanner(workspaceRoot).convertToShell(options.fromCapability, {
              command: options.command,
              cwd: options.cwd,
              reason: options.reason,
              expectedEffect: options.expectedEffect,
              sourceChannel: "cli"
            });
            if (!result.didCreate || !result.approval) {
              console.log(result.message ?? "No new shell approval was created. No command was executed.");
              process.exitCode = 1;
              return;
            }
            console.log(formatShellApprovalPreview(result.approval));
            const applyResult = await ledger.apply(result.approval.id, { confirm: options.confirm });
            console.log("");
            console.log(applyResult.content);
            if (!applyResult.ok) process.exitCode = 1;
            return;
          }
          if (!options.command || !options.reason || !options.yes) {
            throw new Error("Usage: cosia shell run --command \"<command>\" --reason \"<reason>\" --yes");
          }
          const approval = ledger.create({
            command: options.command,
            cwd: options.cwd,
            reason: options.reason,
            expectedEffect: options.expectedEffect,
            sourceChannel: "cli"
          });
          console.log(formatShellApprovalPreview(approval));
          const result = await ledger.apply(approval.id, { confirm: options.confirm });
          console.log("");
          console.log(result.content);
          if (!result.ok) process.exitCode = 1;
          return;
        }
        if (action === "cancel") {
          if (!approvalId) throw new Error("Usage: cosia shell cancel <approval-id>");
          console.log(formatShellApprovalPreview(ledger.cancel(approvalId)));
          return;
        }
        throw new Error(`Unknown shell action: ${action}`);
      });
    });
}
