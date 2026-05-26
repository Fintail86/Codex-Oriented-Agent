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

export function registerPolicyCommands(program: Command): void {
  const policy = program.command("policy").description("Inspect and maintain runtime policy.");

  policy
    .command("show")
    .description("Show the active policy summary.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        const manager = new PolicyManager(workspaceRoot);
        console.log(formatPolicySummary(await manager.loadPolicy()));
      });
    });

  policy
    .command("check")
    .option("--repair", "Regenerate POLICY.md when it is missing or stale.", false)
    .description("Validate policy JSON and Markdown mirror.")
    .action(async (options: { repair: boolean }) => {
      await main(async (workspaceRoot) => {
        const result = await new PolicyManager(workspaceRoot).checkPolicy(true, options.repair);
        if (result.created.length) {
          console.log(`Created: ${result.created.join(", ")}`);
        }
        if (result.repaired.length) {
          console.log(`Repaired: ${result.repaired.join(", ")}`);
        }
        console.log(`POLICY.json: ${result.jsonExists && result.jsonValid ? "ok" : "failed"}`);
        console.log(`POLICY.md: ${result.markdownExists && result.markdownMatches ? "ok" : "failed"}`);
        if (result.errors.length) {
          console.log(result.errors.map((error) => `- ${error}`).join("\n"));
        }
        if (!result.ok) {
          process.exitCode = 1;
        }
      });
    });

  policy
    .command("sync")
    .description("Regenerate POLICY.md from POLICY.json.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        await new PolicyManager(workspaceRoot).syncMarkdown();
        console.log("Synced codex/POLICY.md from codex/POLICY.json");
      });
    });

  policy
    .command("audit")
    .requiredOption("--session <session-id>", "Session id")
    .option("--limit <limit>", "Result limit", "20")
    .option("--run-id <run-id>", "Show only events from one run id")
    .option("--latest-run", "Show only events from the latest run id", false)
    .option("--json", "Print raw JSON events.", false)
    .description("Show policy audit events for one session.")
    .action(async (options: { session: string; limit: string; runId?: string; latestRun: boolean; json: boolean }) => {
      await main(async (workspaceRoot) => {
        const events = await new PolicyAuditLog(workspaceRoot).list(options.session, {
          limit: Number.parseInt(options.limit, 10),
          runId: options.runId,
          latestRun: options.latestRun
        });
        if (!events.length) {
          console.log("No policy audit events.");
          return;
        }
        if (options.json) {
          for (const event of events) {
            console.log(JSON.stringify(event));
          }
          return;
        }
        console.log(formatPolicyAuditEvents(events));
      });
    });
}
