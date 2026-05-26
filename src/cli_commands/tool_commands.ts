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

export function registerToolCommands(program: Command): void {
  program
    .command("tool")
    .argument("[action-or-tool-id]", "`list`, `run`, `draft`, `candidate`, `active`, `blueprint`, `activate`, `deactivate`, or a tool id")
    .argument("[tool-id]", "Tool id when using `run`")
    .argument("[extra-id]", "Extra id for nested tool commands.")
    .option("--args <json>", "JSON object arguments for the tool.")
    .option("--path <path>", "Compatibility shortcut for tools that accept a workspace path.")
    .option("--staged", "Compatibility shortcut for staged diffs.", false)
    .option("--max-count <n>", "Compatibility shortcut for tools that accept maxCount.")
    .option("--from-capability <id>", "Create a draft from a capability proposal.")
    .option("--request <text>", "Create a tool growth routine from a user request.")
    .option("--provider <provider>", "Model provider for LLM tool draft generation.", "default")
    .option("--agent <agent-id>", "Target agent id for activation.")
    .option("--reason <reason>", "Reason for discard/reject/deactivate.")
    .option("--yes", "Apply an activation. Required for tool activate.", false)
    .option("--all", "Show all records, including inactive/discarded/rejected.", false)
    .option("--advanced", "Show advanced tool growth and governance details.", false)
    .description("Advanced governance for tool growth, candidates, active tools, and blueprints.")
    .action(async (actionOrToolId: string | undefined, toolId: string | undefined, extraId: string | undefined, options: ToolCliOptions) => {
      await main(async (workspaceRoot) => {
        const acquisition = new ToolAcquisitionManager(workspaceRoot);
        if (!actionOrToolId || actionOrToolId === "list") {
          console.log(formatToolCatalog(acquisition.listActiveTools({ includeInactive: true })));
          return;
        }

        if (actionOrToolId === "draft") {
          if (!options.fromCapability) {
            throw new Error("Usage: cosia tool draft --from-capability <capability-id>");
          }
          console.log(formatToolDraftResult(await acquisition.draftFromCapability(options.fromCapability, {
            providerId: options.provider
          })));
          return;
        }

        if (actionOrToolId === "grow") {
          const growth = new ToolGrowthManager(workspaceRoot);
          const action = toolId ?? (options.request ? "start" : "review");
          if (action === "start") {
            if (!options.request) throw new Error("Usage: cosia tool grow --request \"<text>\" [--agent <agent-id>] [--provider <provider>]");
            console.log(formatToolGrowthStart(await growth.start({
              request: options.request,
              agentId: options.agent,
              providerId: options.provider
            }), { advanced: options.advanced }));
            return;
          }
          if (action === "review") {
            console.log(formatToolGrowthReview(growth.list({ all: options.all }), { advanced: options.advanced }));
            return;
          }
          if (action === "show") {
            if (!extraId) throw new Error("Usage: cosia tool grow show <routine-id>");
            const routine = growth.get(extraId);
            const candidate = routine.selectedCandidateId ? acquisition.getCandidate(routine.selectedCandidateId) : undefined;
            console.log(formatToolGrowthRoutine(routine, candidate, { advanced: options.advanced }));
            return;
          }
          if (action === "test") {
            if (!extraId) throw new Error("Usage: cosia tool grow test <routine-id> --yes");
            console.log(formatToolGrowthTest(await growth.test(extraId, { yes: options.yes }), { advanced: options.advanced }));
            return;
          }
          if (action === "activate") {
            if (!extraId || !options.agent) throw new Error("Usage: cosia tool grow activate <routine-id> --agent <agent-id> --yes");
            console.log(formatToolGrowthActivation(await growth.activate(extraId, {
              agentId: options.agent,
              yes: options.yes
            })));
            return;
          }
          if (action === "reject") {
            if (!extraId || !options.reason) throw new Error("Usage: cosia tool grow reject <routine-id> --reason \"<reason>\"");
            console.log(formatToolGrowthRejected(growth.reject(extraId, options.reason)));
            return;
          }
          if (action === "retry") {
            if (!extraId) throw new Error("Usage: cosia tool grow retry <routine-id> [--provider <provider>]");
            console.log(formatToolGrowthStart(await growth.retry(extraId, { providerId: options.provider }), { advanced: options.advanced }));
            return;
          }
          if (action === "cancel") {
            if (!extraId || !options.reason) throw new Error("Usage: cosia tool grow cancel <routine-id> --reason \"<reason>\"");
            console.log(formatToolGrowthCancelled(growth.cancel(extraId, options.reason)));
            return;
          }
          throw new Error(`Unknown tool grow action: ${action}`);
        }

        if (actionOrToolId === "candidate") {
          const action = toolId ?? "review";
          if (action === "review") {
            console.log(formatToolCandidateReview(acquisition.listCandidates({ all: options.all })));
            return;
          }
          if (action === "show") {
            if (!extraId) throw new Error("Usage: cosia tool candidate show <candidate-id>");
            console.log(formatToolCandidate(acquisition.getCandidate(extraId)));
            return;
          }
          if (action === "discard") {
            if (!extraId || !options.reason) throw new Error("Usage: cosia tool candidate discard <candidate-id> --reason \"<reason>\"");
            console.log(formatToolCandidate(acquisition.discardCandidate(extraId, options.reason)));
            return;
          }
          if (action === "reject") {
            if (!extraId || !options.reason) throw new Error("Usage: cosia tool candidate reject <candidate-id> --reason \"<reason>\"");
            console.log(formatToolCandidate(acquisition.rejectCandidate(extraId, options.reason)));
            return;
          }
          if (action === "approve") {
            if (!extraId) throw new Error("Usage: cosia tool candidate approve <candidate-id>");
            console.log(formatToolCandidate(acquisition.approveCandidate(extraId)));
            return;
          }
          if (action === "test") {
            if (!extraId) throw new Error("Usage: cosia tool candidate test <candidate-id>");
            console.log(formatToolCandidateTestRun(await acquisition.testCandidate(extraId)));
            return;
          }
          throw new Error(`Unknown tool candidate action: ${action}`);
        }

        if (actionOrToolId === "active") {
          const action = toolId ?? "list";
          if (action === "list") {
            console.log(formatActiveToolList(acquisition.listActiveTools({ includeInactive: options.all })));
            return;
          }
          if (action === "show") {
            if (!extraId) throw new Error("Usage: cosia tool active show <tool-id>");
            const tool = acquisition.getActiveTool(extraId);
            const visibility = await acquisition.activeToolVisibility(extraId);
            console.log(`${formatActiveTool(tool)}\n\n${formatActiveToolVisibility(visibility)}`);
            return;
          }
          throw new Error(`Unknown tool active action: ${action}`);
        }

        if (actionOrToolId === "blueprint") {
          const action = toolId ?? "list";
          if (action === "list") {
            console.log(formatLearnedBlueprintList(acquisition.listBlueprints()));
            return;
          }
          if (action === "show") {
            if (!extraId) throw new Error("Usage: cosia tool blueprint show <blueprint-id>");
            console.log(formatLearnedBlueprint(acquisition.getBlueprint(extraId)));
            return;
          }
          if (action === "create-from-active") {
            if (!extraId) throw new Error("Usage: cosia tool blueprint create-from-active <tool-id> --yes");
            console.log(formatLearnedBlueprint(await Promise.resolve(acquisition.createBlueprintFromActive(extraId, { yes: options.yes }))));
            return;
          }
          throw new Error(`Unknown tool blueprint action: ${action}`);
        }

        if (actionOrToolId === "activate") {
          if (!toolId || !options.agent) {
            throw new Error("Usage: cosia tool activate <candidate-id> --agent <agent-id> [--yes]");
          }
          if (!options.yes) {
            console.log(formatToolActivationPreview(await acquisition.previewActivation(toolId, options.agent)));
            return;
          }
          console.log(formatToolActivation(await acquisition.activateCandidate(toolId, options.agent, { yes: true })));
          return;
        }

        if (actionOrToolId === "deactivate") {
          if (!toolId || !options.reason) {
            throw new Error("Usage: cosia tool deactivate <tool-id> --reason \"<reason>\"");
          }
          console.log(formatActiveTool(await acquisition.deactivateTool(toolId, options.reason)));
          return;
        }

        const requestedTool = actionOrToolId === "run" ? toolId : actionOrToolId;
        if (!requestedTool) {
          console.log("[FAILED] Missing tool id.");
          console.log("Try: cosia tool list");
          process.exitCode = 1;
          return;
        }

        const normalizedToolId = normalizeCliToolId(requestedTool);
        if (!normalizedToolId) {
          console.log(`[FAILED] Unknown tool: ${requestedTool}`);
          console.log("Run `cosia tool list` to see registered tools.");
          process.exitCode = 1;
          return;
        }

        await runCliTool(workspaceRoot, normalizedToolId, parseCliToolArgs(normalizedToolId, options));
      });
    });
}
