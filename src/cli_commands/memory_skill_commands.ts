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

export function registerMemorySkillCommands(program: Command): void {
  const memory = program.command("memory").description("Manage long-term memory.");

  memory
    .command("add")
    .option("--tier <tier>", "Memory tier: core, agent, or session")
    .option("--scope <scope>", "Deprecated memory scope alias")
    .requiredOption("--content <content>", "Memory content")
    .option("--kind <kind>", "Memory kind", "note")
    .option("--owner-id <owner-id>", "Owner id")
    .option("--importance <importance>", "Memory importance from 1 to 5", "3")
    .option("--confidence <confidence>", "Memory confidence from 0 to 1", "0.7")
    .description("Add an explicit long-term memory.")
    .action(async (options: { tier?: string; scope?: string; content: string; kind: string; ownerId?: string; importance: string; confidence: string }) => {
      await main(async (workspaceRoot) => {
        const ownership = await resolveMemoryTierOptions(workspaceRoot, options, true);
        const manager = new MemoryManager(workspaceRoot);
        const record = manager.addMemory({
          tier: ownership.tier,
          scope: ownership.scope,
          content: options.content,
          kind: options.kind,
          ownerId: ownership.ownerId ?? undefined,
          importance: parseIntegerOption(options.importance, "importance"),
          confidence: parseNumberOption(options.confidence, "confidence")
        });
        console.log(record.id);
      });
    });

  memory
    .command("search")
    .requiredOption("--query <query>", "Search query")
    .option("--tier <tier>", "Filter by memory tier")
    .option("--owner-id <owner-id>", "Filter by owner id")
    .option("--limit <limit>", "Result limit", "8")
    .option("--show-score", "Show memory search scores.", false)
    .description("Search explicit long-term memory.")
    .action(async (options: { query: string; tier?: string; ownerId?: string; limit: string; showScore: boolean }) => {
      await main(async (workspaceRoot) => {
        const manager = new MemoryManager(workspaceRoot);
        const tier = options.tier ? memoryTierSchema.parse(options.tier) : undefined;
        const results = manager.search(options.query, Number.parseInt(options.limit, 10), { tier, ownerId: options.ownerId });
        if (!results.length) {
          console.log("No matches.");
          return;
        }
        for (const result of results) {
          const record = result.record;
          const score = options.showScore ? ` score:${result.score.toFixed(2)} tokens:${result.matchedTokens.join(",") || "none"}` : "";
          console.log(`${record.id}\t[${record.tier}/${record.kind}]${score}\t${record.content}`);
        }
      });
    });

  memory
    .command("list")
    .option("--tier <tier>", "Filter by memory tier")
    .option("--owner-id <owner-id>", "Filter by owner id")
    .option("--limit <limit>", "Result limit", "20")
    .option("--all", "Show active and archived memories.", false)
    .description("List latest active long-term memories.")
    .action(async (options: { tier?: string; ownerId?: string; limit: string; all: boolean }) => {
      await main(async (workspaceRoot) => {
        const tier = options.tier ? memoryTierSchema.parse(options.tier) : undefined;
        const records = new MemoryManager(workspaceRoot).listMemories(Number.parseInt(options.limit, 10), options.all, {
          tier,
          ownerId: options.ownerId
        });
        if (!records.length) {
          console.log("No memories.");
          return;
        }
        for (const record of records) {
          console.log(`${record.id}\t${record.status}\t[${record.tier}/${record.kind}]\t${record.content}`);
        }
      });
    });

  memory
    .command("show")
    .argument("<memory-id>")
    .description("Show one long-term memory.")
    .action(async (memoryId: string) => {
      await main(async (workspaceRoot) => {
        console.log(JSON.stringify(new MemoryManager(workspaceRoot).getMemory(memoryId), null, 2));
      });
    });

  memory
    .command("update")
    .argument("<memory-id>")
    .option("--content <content>", "Memory content")
    .option("--kind <kind>", "Memory kind")
    .option("--tier <tier>", "Memory tier")
    .option("--scope <scope>", "Deprecated memory scope alias")
    .option("--owner-id <owner-id>", "Owner id")
    .option("--importance <importance>", "Memory importance from 1 to 5")
    .option("--confidence <confidence>", "Memory confidence from 0 to 1")
    .description("Update an active long-term memory.")
    .action(async (memoryId: string, options: { content?: string; kind?: string; tier?: string; scope?: string; ownerId?: string; importance?: string; confidence?: string }) => {
      await main(async (workspaceRoot) => {
        const ownership = (options.tier || options.scope || options.ownerId)
          ? await resolveMemoryTierOptions(workspaceRoot, options, false)
          : {};
        const record = new MemoryManager(workspaceRoot).updateMemory(memoryId, {
          content: options.content,
          kind: options.kind,
          tier: ownership.tier,
          scope: ownership.scope,
          ownerId: ownership.ownerId ?? undefined,
          importance: options.importance ? parseIntegerOption(options.importance, "importance") : undefined,
          confidence: options.confidence ? parseNumberOption(options.confidence, "confidence") : undefined
        });
        console.log(record.id);
      });
    });

  memory
    .command("archive")
    .argument("<memory-id>")
    .requiredOption("--reason <reason>", "Archive reason")
    .description("Archive an active long-term memory.")
    .action(async (memoryId: string, options: { reason: string }) => {
      await main(async (workspaceRoot) => {
        const record = new MemoryManager(workspaceRoot).archiveMemory(memoryId, options.reason);
        console.log(`${record.id} archived`);
      });
    });

  memory
    .command("promote")
    .argument("<memory-id>")
    .option("--to-tier <tier>", "Target memory tier: agent or core")
    .option("--to-skill-candidate", "Create a skill candidate from core memory.", false)
    .option("--skill-name <name>", "Skill candidate name for --to-skill-candidate")
    .option("--owner-id <owner-id>", "Target owner id")
    .requiredOption("--reason <reason>", "Promotion reason")
    .option("--content <content>", "Promoted or merged content")
    .option("--kind <kind>", "Promoted memory kind")
    .option("--importance <importance>", "Promoted memory importance from 1 to 5")
    .option("--confidence <confidence>", "Promoted memory confidence from 0 to 1")
    .option("--force", "Promote even if conflicts are detected.", false)
    .option("--replace <memory-id>", "Archive an existing target memory and promote this memory.")
    .option("--merge <memory-id>", "Merge this memory into an existing target memory.")
    .description("Promote memory across lifecycle tiers or into a skill candidate.")
    .action(async (memoryId: string, options: {
      toTier?: string;
      toSkillCandidate: boolean;
      skillName?: string;
      ownerId?: string;
      reason: string;
      content?: string;
      kind?: string;
      importance?: string;
      confidence?: string;
      force: boolean;
      replace?: string;
      merge?: string;
    }) => {
      await main(async (workspaceRoot) => {
        const manager = new MemoryManager(workspaceRoot);
        if (options.toSkillCandidate) {
          if (options.toTier) {
            throw new Error("Use either --to-tier or --to-skill-candidate, not both.");
          }
          if (!options.skillName?.trim()) {
            throw new Error("--skill-name is required with --to-skill-candidate.");
          }
          const result = manager.promoteCoreMemoryToSkillCandidate(memoryId, {
            skillName: options.skillName,
            reason: options.reason,
            content: options.content
          });
          console.log(`Skill candidate: ${result.candidate.id}`);
          console.log(`Promotion: ${result.promotion.id}`);
          return;
        }
        if (!options.toTier) {
          throw new Error("Use --to-tier agent|core or --to-skill-candidate.");
        }
        const toTier = memoryTierSchema.parse(options.toTier);
        if (toTier === "session") {
          throw new Error("Memory promotion to session tier is not supported.");
        }
        if (toTier === "agent") {
          await new AgentManager(workspaceRoot).loadAgent(options.ownerId ?? "");
        }
        const record = manager.promoteMemory(memoryId, {
          toTier,
          ownerId: options.ownerId,
          reason: options.reason,
          content: options.content,
          kind: options.kind,
          importance: options.importance ? parseIntegerOption(options.importance, "importance") : undefined,
          confidence: options.confidence ? parseNumberOption(options.confidence, "confidence") : undefined,
          force: options.force,
          replaceMemoryId: options.replace,
          mergeMemoryId: options.merge
        });
        console.log(`Promotion: ${record.id}`);
        console.log(`Target memory: ${record.targetMemoryId}`);
      });
    });

  const candidate = memory.command("candidate").description("Review memory candidates.");

  const promotion = memory.command("promotion").description("Review automatic memory promotions.");

  candidate
    .command("export")
    .option("--jsonl", "Print JSONL export.", false)
    .description("Export memory candidates from the SQLite queue.")
    .action(async (options: { jsonl: boolean }) => {
      await main(async (workspaceRoot) => {
        if (!options.jsonl) {
          throw new Error("Only --jsonl export is supported.");
        }
        process.stdout.write(new MemoryManager(workspaceRoot).exportCandidatesJsonl());
      });
    });

  candidate
    .command("list")
    .option("--all", "Show pending, promoted, discarded, and legacy candidates.", false)
    .description("List memory candidates.")
    .action(async (options: { all: boolean }) => {
      await main(async (workspaceRoot) => {
        const candidates = await new MemoryManager(workspaceRoot).listCandidates(options.all);
        if (!candidates.length) {
          console.log("No memory candidates.");
          return;
        }
        for (const candidate of candidates) {
          const record = candidate.record;
          const status = record?.status ?? "legacy";
          const tier = record?.tier ?? String(candidate.raw.tier ?? candidate.raw.scope ?? "unknown");
          const kind = record?.kind ?? String(candidate.raw.kind ?? "unknown");
          const content = record?.content ?? String(candidate.raw.content ?? JSON.stringify(candidate.raw));
          console.log(`${candidate.displayId}\t${status}\t[${tier}/${kind}]\t${content}`);
        }
        console.log("\nTip: candidate ids accept unique prefixes, e.g. `cosia memory candidate show d1ec6de4`.");
      });
    });

  candidate
    .command("show")
    .argument("<candidate-id>")
    .description("Show one memory candidate.")
    .action(async (candidateId: string) => {
      await main(async (workspaceRoot) => {
        const candidate = await new MemoryManager(workspaceRoot).getCandidate(candidateId);
        console.log(JSON.stringify(candidate.record ?? candidate.raw, null, 2));
      });
    });

  candidate
    .command("promote")
    .argument("[candidate-id]")
    .option("--force", "Promote even if conflicts are detected.", false)
    .option("--replace <memory-id>", "Archive an existing memory and promote this candidate.")
    .option("--merge <memory-id>", "Merge this candidate into an existing memory.")
    .option("--content <content>", "Merged memory content for --merge.")
    .option("--all-low-risk", "Promote all low-risk pending candidates with no conflicts.", false)
    .option("--yes", "Confirm a batch operation.", false)
    .description("Promote a pending memory candidate into long-term memory.")
    .action(async (candidateId: string | undefined, options: { force: boolean; replace?: string; merge?: string; content?: string; allLowRisk: boolean; yes: boolean }) => {
      await main(async (workspaceRoot) => {
        const manager = new MemoryManager(workspaceRoot);
        if (options.allLowRisk) {
          const summary = await manager.promoteAllLowRisk({ yes: options.yes });
          console.log(formatMemoryReviewSummary(summary));
          if (!options.yes) {
            console.log("\nNo changes made. Re-run with --yes to promote these candidates.");
          }
          return;
        }
        if (!candidateId) {
          throw new Error("candidate-id is required unless --all-low-risk is used.");
        }
        const record = await manager.promoteCandidate(candidateId, {
          force: options.force,
          replaceMemoryId: options.replace,
          mergeMemoryId: options.merge,
          mergeContent: options.content
        });
        console.log(record.id);
      });
    });

  candidate
    .command("conflicts")
    .argument("<candidate-id>")
    .option("--json", "Print raw JSON conflict records.", false)
    .description("Show memory conflicts for one pending candidate.")
    .action(async (candidateId: string, options: { json: boolean }) => {
      await main(async (workspaceRoot) => {
        const result = await new MemoryManager(workspaceRoot).findCandidateConflicts(candidateId);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(formatMemoryConflicts(result.candidate, result.conflicts));
      });
    });

  candidate
    .command("review")
    .option("--latest", "Review pending candidates from the latest run.", false)
    .option("--pending", "Review all pending candidates.", false)
    .description("Show risk and conflict review for memory candidates.")
    .action(async (options: { latest: boolean; pending: boolean }) => {
      await main(async (workspaceRoot) => {
        const manager = new MemoryManager(workspaceRoot);
        const reviews = await manager.reviewPendingCandidates({ latest: options.latest && !options.pending });
        console.log(formatMemoryReviewSummary({
          created: reviews.length,
          autoPromoted: 0,
          pending: reviews.length,
          conflicts: reviews.filter((review) => review.conflicts.length).length,
          reviews
        }));
      });
    });

  candidate
    .command("discard")
    .argument("[candidate-id]")
    .requiredOption("--reason <reason>", "Discard reason")
    .option("--all-low-risk", "Discard all low-risk pending candidates with no conflicts.", false)
    .option("--yes", "Confirm a batch operation.", false)
    .description("Discard a pending memory candidate.")
    .action(async (candidateId: string | undefined, options: { reason: string; allLowRisk: boolean; yes: boolean }) => {
      await main(async (workspaceRoot) => {
        const manager = new MemoryManager(workspaceRoot);
        if (options.allLowRisk) {
          const summary = await manager.discardAllLowRisk(options.reason, { yes: options.yes });
          console.log(formatMemoryReviewSummary(summary));
          if (!options.yes) {
            console.log("\nNo changes made. Re-run with --yes to discard these candidates.");
          }
          return;
        }
        if (!candidateId) {
          throw new Error("candidate-id is required unless --all-low-risk is used.");
        }
        const record = await manager.discardCandidate(candidateId, options.reason);
        console.log(`${record.id} discarded`);
      });
    });

  promotion
    .command("export")
    .option("--jsonl", "Print JSONL export.", false)
    .description("Export automatic memory promotions from the SQLite queue.")
    .action(async (options: { jsonl: boolean }) => {
      await main(async (workspaceRoot) => {
        if (!options.jsonl) {
          throw new Error("Only --jsonl export is supported.");
        }
        process.stdout.write(new MemoryManager(workspaceRoot).exportPromotionsJsonl());
      });
    });

  promotion
    .command("list")
    .option("--all", "Include reverted promotions.", false)
    .option("--type <type>", "Promotion type: auto or tier", "auto")
    .description("List automatic or tier memory promotions.")
    .action(async (options: { all: boolean; type: string }) => {
      await main(async (workspaceRoot) => {
        const manager = new MemoryManager(workspaceRoot);
        if (options.type === "tier") {
          const records = manager.listTierPromotions(options.all);
          if (!records.length) {
            console.log("No tier promotions.");
            return;
          }
          for (const record of records) {
            const status = record.revertedAt ? "reverted" : "active";
            console.log(`${record.id}\t${status}\t${record.fromTier}->${record.toTier}\t${record.mode}\ttarget:${record.targetMemoryId.slice(0, 8)}`);
          }
          return;
        }
        if (options.type !== "auto") {
          throw new Error("Promotion type must be auto or tier.");
        }
        const records = manager.listPromotions(options.all);
        if (!records.length) {
          console.log("No auto promotions.");
          return;
        }
        for (const record of records) {
          const status = record.revertedAt ? "reverted" : "active";
          console.log(`${record.id}\t${status}\t${record.riskLevel}\tmem:${record.promotedMemoryId.slice(0, 8)}\tcandidate:${record.candidateId.slice(0, 8)}`);
        }
      });
    });

  promotion
    .command("show")
    .argument("<promotion-id>")
    .description("Show one automatic or tier memory promotion.")
    .action(async (promotionId: string) => {
      await main(async (workspaceRoot) => {
        const manager = new MemoryManager(workspaceRoot);
        try {
          console.log(JSON.stringify(manager.getPromotion(promotionId), null, 2));
        } catch {
          console.log(JSON.stringify(manager.getTierPromotion(promotionId), null, 2));
        }
      });
    });

  promotion
    .command("revert")
    .argument("<promotion-id>")
    .requiredOption("--reason <reason>", "Revert reason")
    .description("Revert an automatic or tier memory promotion.")
    .action(async (promotionId: string, options: { reason: string }) => {
      await main(async (workspaceRoot) => {
        const manager = new MemoryManager(workspaceRoot);
        try {
          const record = manager.revertPromotion(promotionId, options.reason);
          console.log(`${record.id} reverted`);
        } catch {
          const record = manager.revertTierPromotion(promotionId, options.reason);
          console.log(`${record.id} reverted`);
        }
      });
    });

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

  skill
    .command("migrate")
    .requiredOption("--agent <agent-id>", "Agent id")
    .option("--yes", "Apply the migration after preview.", false)
    .description("Preview or migrate legacy agent-local skills into the global skill toolbox.")
    .action(async (options: { agent: string; yes: boolean }) => {
      await main(async (workspaceRoot) => {
        const result = new SkillManager(workspaceRoot).migrateAgentSkills(options.agent, options.yes);
        console.log(formatSkillMigrationResult(result));
      });
    });
}
