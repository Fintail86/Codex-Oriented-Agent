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

export function registerSkillCommands(program: Command): void {
  const skill = program.command("skill").description("Manage global skills and agent skill preferences.");

  const skillCandidate = skill.command("candidate").description("Review skill candidates.");

  skillCandidate
    .command("list")
    .option("--all", "Show pending, promoted, and discarded candidates.", false)
    .description("List skill candidates.")
    .action(async (options: { all: boolean }) => {
      await main(async (workspaceRoot) => {
        const candidates = new SkillManager(workspaceRoot).listCandidates(options.all);
        if (!candidates.length) {
          console.log("No skill candidates.");
          return;
        }
        for (const candidate of candidates) {
          console.log(formatSkillCandidate(candidate.record));
        }
        console.log("\nTip: skill candidate ids accept unique prefixes.");
      });
    });

  skillCandidate
    .command("show")
    .argument("<candidate-id>")
    .description("Show one skill candidate.")
    .action(async (candidateId: string) => {
      await main(async (workspaceRoot) => {
        console.log(JSON.stringify(new SkillManager(workspaceRoot).getCandidate(candidateId).record, null, 2));
      });
    });

  skillCandidate
    .command("promote")
    .argument("<candidate-id>")
    .option("--yes", "Apply the promotion after preview.", false)
    .option("--prefer-for <agent-id>", "Add the promoted global skill to one agent's preferredSkills.")
    .option("--confirm-high-risk <phrase>", "Required phrase for high-risk skill promotion.")
    .description("Preview or promote a skill candidate into the global skill toolbox.")
    .action(async (candidateId: string, options: { yes: boolean; preferFor?: string; confirmHighRisk?: string }) => {
      await main(async (workspaceRoot) => {
        const result = new SkillManager(workspaceRoot).promoteCandidate(candidateId, {
          yes: options.yes,
          preferFor: options.preferFor,
          confirmHighRisk: options.confirmHighRisk
        });
        console.log(formatSkillPromotionPreview(result));
      });
    });

  skillCandidate
    .command("discard")
    .argument("<candidate-id>")
    .requiredOption("--reason <reason>", "Discard reason")
    .description("Discard a pending skill candidate.")
    .action(async (candidateId: string, options: { reason: string }) => {
      await main(async (workspaceRoot) => {
        const record = new SkillManager(workspaceRoot).discardCandidate(candidateId, options.reason);
        console.log(`${record.id} discarded`);
      });
    });

  skillCandidate
    .command("export")
    .option("--jsonl", "Print JSONL export.", false)
    .description("Export skill candidates from SQLite.")
    .action(async (options: { jsonl: boolean }) => {
      await main(async (workspaceRoot) => {
        if (!options.jsonl) {
          throw new Error("Only --jsonl export is supported.");
        }
        process.stdout.write(new SkillManager(workspaceRoot).exportCandidatesJsonl());
      });
    });

  skill
    .command("list")
    .option("--agent <agent-id>", "Show one agent's preference view over global skills.")
    .description("List global skills.")
    .action(async (options: { agent?: string }) => {
      await main(async (workspaceRoot) => {
        const manager = new SkillManager(workspaceRoot);
        const skills = manager.listSkills();
        if (!skills.length) {
          console.log("No global skills.");
          return;
        }
        const agent = options.agent ? await new AgentManager(workspaceRoot).loadAgent(options.agent) : undefined;
        for (const item of skills) {
          const state = agent?.blockedSkills.includes(item.id)
            ? "blocked"
            : agent?.preferredSkills.includes(item.id)
              ? "preferred"
              : "available";
          const weight = agent?.skillWeights?.[item.id] ? ` weight:${agent.skillWeights[item.id]}` : "";
          console.log(`${item.id}\t${options.agent ? state : item.riskLevel}${weight}\t${item.manualOnly ? "manual-only" : `triggers:${item.triggers.join(",")}`}\t${item.path}`);
        }
      });
    });

  skill
    .command("show")
    .argument("<skill-id>")
    .option("--agent <agent-id>", "Include one agent's preference state.")
    .description("Show one global skill.")
    .action(async (skillId: string, options: { agent?: string }) => {
      await main(async (workspaceRoot) => {
        const manager = new SkillManager(workspaceRoot);
        const skill = manager.getSkill(skillId);
        const agent = options.agent ? await new AgentManager(workspaceRoot).loadAgent(options.agent) : undefined;
        const state = agent
          ? agent.blockedSkills.includes(skill.id)
            ? "blocked"
            : agent.preferredSkills.includes(skill.id)
              ? "preferred"
              : "available"
          : "global";
        console.log(`# ${skill.id}\n\nName: ${skill.name}\nRisk: ${skill.riskLevel}\nTriggers: ${skill.triggers.length ? skill.triggers.join(", ") : "manual-only"}\nState: ${state}\nPath: ${skill.path}\nMetadata: ${skill.metadataPath}\n\n${skill.content}`);
      });
    });

  skill
    .command("check")
    .option("--agent <agent-id>", "Check one agent's generated skill preference view.")
    .option("--repair", "Regenerate SKILLS.md when it is missing or stale.", false)
    .description("Validate the global skill mirror and optional agent skill view.")
    .action(async (options: { agent?: string; repair: boolean }) => {
      await main(async (workspaceRoot) => {
        const result = new SkillManager(workspaceRoot).checkSkills(options.agent, options.repair);
        console.log(formatSkillCheckResult(result));
        if (!result.ok) {
          process.exitCode = 1;
        }
      });
    });

  skill
    .command("sync")
    .argument("[agent-id]")
    .description("Regenerate global SKILLS.md, or an agent skill preference view when agent-id is provided.")
    .action(async (agentId: string | undefined) => {
      await main(async (workspaceRoot) => {
        const path = new SkillManager(workspaceRoot).syncSkillsIndex(agentId);
        console.log(`Synced ${path}`);
      });
    });

  skill
    .command("prefer")
    .argument("<skill-id>")
    .requiredOption("--agent <agent-id>", "Agent id")
    .option("--weight <0-5>", "Optional agent-specific skill weight.")
    .description("Mark a global skill as preferred by an agent.")
    .action(async (skillId: string, options: { agent: string; weight?: string }) => {
      await main(async (workspaceRoot) => {
        new SkillManager(workspaceRoot).preferSkill(
          skillId,
          options.agent,
          options.weight === undefined ? undefined : parseIntegerOption(options.weight, "weight")
        );
        console.log(`Preferred ${skillId} for ${options.agent}`);
      });
    });

  skill
    .command("unprefer")
    .argument("<skill-id>")
    .requiredOption("--agent <agent-id>", "Agent id")
    .description("Remove one agent's preference for a global skill.")
    .action(async (skillId: string, options: { agent: string }) => {
      await main(async (workspaceRoot) => {
        new SkillManager(workspaceRoot).unpreferSkill(skillId, options.agent);
        console.log(`Unpreferred ${skillId} for ${options.agent}`);
      });
    });

  skill
    .command("block")
    .argument("<skill-id>")
    .requiredOption("--agent <agent-id>", "Agent id")
    .description("Block a global skill for one agent.")
    .action(async (skillId: string, options: { agent: string }) => {
      await main(async (workspaceRoot) => {
        new SkillManager(workspaceRoot).blockSkill(skillId, options.agent);
        console.log(`Blocked ${skillId} for ${options.agent}`);
      });
    });

  skill
    .command("unblock")
    .argument("<skill-id>")
    .requiredOption("--agent <agent-id>", "Agent id")
    .description("Unblock a global skill for one agent.")
    .action(async (skillId: string, options: { agent: string }) => {
      await main(async (workspaceRoot) => {
        new SkillManager(workspaceRoot).unblockSkill(skillId, options.agent);
        console.log(`Unblocked ${skillId} for ${options.agent}`);
      });
    });

  skill
    .command("select")
    .requiredOption("--agent <agent-id>", "Agent id")
    .requiredOption("--prompt <prompt>", "Current request to score.")
    .option("--goal <goal>", "Session goal for trigger scoring.", "")
    .option("--skill <skill-id...>", "Manually selected skills.")
    .option("--explain", "Print compact selection score table.", false)
    .description("Explain deterministic skill selection for a prompt.")
    .action(async (options: { agent: string; prompt: string; goal: string; skill?: string[]; explain: boolean }) => {
      await main(async (workspaceRoot) => {
        const agent = await new AgentManager(workspaceRoot).loadAgent(options.agent);
        const policy = await new PolicyManager(workspaceRoot).loadPolicy();
        const rows = new SkillManager(workspaceRoot).explainSkillSelection({
          agent,
          sessionGoal: options.goal,
          currentRequest: options.prompt,
          manualSkillIds: options.skill,
          budget: {
            skillMaxItems: policy.promptBudget.skillMaxItems,
            skillMaxChars: policy.promptBudget.skillMaxChars,
            skillItemMaxChars: policy.promptBudget.skillItemMaxChars
          }
        });
        console.log(formatSkillSelectionExplanation(rows));
      });
    });
}
