#!/usr/bin/env node
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import {
  AgentManager,
  formatAgentDeleteResult,
  formatAgentRecommendation
} from "./runtime/agent_manager.js";
import { initProject } from "./runtime/init_project.js";
import { applyReset, formatDoctorRepair, formatDoctorReport, formatResetResult, getDoctorReport, previewReset, repairDoctor, type ResetMode } from "./runtime/doctor.js";
import { formatMemoryConflicts, formatMemoryReviewSummary, MemoryManager } from "./runtime/memory_manager.js";
import { formatMvpChecklist } from "./runtime/mvp_checklist.js";
import { checkCommandTriggers, formatCommandTriggerCheck, formatCommandTriggerSync, syncCommandTriggers } from "./runtime/command_triggers.js";
import {
  CapabilityPlanner,
  capabilityScanJson,
  formatCapabilityFacts,
  formatCapabilityPlan,
  formatCapabilityProposal,
  formatCapabilityReview,
  formatCapabilityScan
} from "./runtime/capability.js";
import { checkProvider, createProvider, listProviders } from "./runtime/model/provider_registry.js";
import { formatProviderFailure, ProviderError } from "./runtime/model/provider_errors.js";
import { formatPolicyAuditEvents, PolicyAuditLog } from "./runtime/policy_audit.js";
import { formatPolicySummary, PolicyManager } from "./runtime/policy_manager.js";
import { applyRuntimeConfigMigration, buildRuntimeConfigMigration, formatConfigCheck, formatConfigShow } from "./runtime/runtime_config.js";
import type { PromptManifest } from "./runtime/prompt_builder.js";
import { runChatRepl } from "./runtime/repl.js";
import { formatReviewCleanup, formatReviewInbox, formatReviewStats, ReviewInboxService } from "./runtime/review_inbox.js";
import { runSession } from "./runtime/runner.js";
import { SessionManager } from "./runtime/session_manager.js";
import {
  formatImprovementDetail,
  formatImprovementMutation,
  formatImproveApply,
  formatImprovePreview,
  formatImproveRecords,
  formatImproveStatus,
  SelfImprovementGovernor
} from "./runtime/self_improvement.js";
import { formatSkillCandidate, formatSkillCheckResult, formatSkillMigrationResult, formatSkillPromotionPreview, formatSkillSelectionExplanation, SkillManager } from "./runtime/skill_manager.js";
import { formatStatusReport, getStatusReport } from "./runtime/status_report.js";
import { formatSessionChoices, formatStartOverview, recommendStartSession, sessionFromChoice } from "./runtime/start_flow.js";
import { formatGatewayStatus, formatGatewayStopResult, formatGatewayUnlockResult, restartGateway, startGateway, stopGateway, unlockStaleGateway } from "./runtime/gateway_supervisor.js";
import { checkTelegramGateway, formatTelegramCheck, startTelegramGateway, unlockStaleTelegramGateway } from "./runtime/telegram_gateway.js";
import { getToolCatalogEntry, isToolId, toolCatalog, toolNameValues } from "./runtime/tool_catalog.js";
import { ToolRegistry } from "./runtime/tool_registry.js";
import { formatShellApprovalList, formatShellApprovalPreview, ShellApprovalLedger } from "./runtime/shell_approval.js";
import { memoryScopeSchema, memoryTierSchema } from "./runtime/types.js";
import type { MemoryScope, MemoryTier, SessionMetadata, ToolName } from "./runtime/types.js";
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
  ToolAcquisitionManager,
  type ActiveToolRecord
} from "./runtime/tool_acquisition.js";
import {
  formatToolGrowthActivation,
  formatToolGrowthCancelled,
  formatToolGrowthRejected,
  formatToolGrowthReview,
  formatToolGrowthRoutine,
  formatToolGrowthStart,
  formatToolGrowthTest,
  ToolGrowthManager
} from "./runtime/tool_growth.js";
import { COSIA_VERSION } from "./runtime/version.js";
import { readText } from "./runtime/fs_utils.js";
import { requireWorkspaceRoot, workspaceRootForInit } from "./runtime/workspace.js";

const program = new Command();

program
  .name("cosia")
  .description("COSIA: Codex-Oriented Self-Improving Agent Runtime CLI MVP")
  .version(COSIA_VERSION);

program
  .command("status")
  .option("--provider <provider>", "Model provider smoke check: default, codex-cli, openai-compatible, or mock", "default")
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

const providerCommand = program.command("provider").description("Inspect model providers.");

const configCommand = program.command("config").description("Inspect and migrate runtime configuration.");

configCommand
  .command("show")
  .description("Show merged and effective runtime configuration.")
  .action(async () => {
    await main(async (workspaceRoot) => {
      const rawPolicy = await readRawPolicy(workspaceRoot);
      console.log(await formatConfigShow(workspaceRoot, rawPolicy));
    });
  });

configCommand
  .command("check")
  .description("Validate runtime configuration and secret-like values.")
  .action(async () => {
    await main(async (workspaceRoot) => {
      const rawPolicy = await readRawPolicy(workspaceRoot);
      console.log(await formatConfigCheck(workspaceRoot, rawPolicy));
    });
  });

configCommand
  .command("migrate")
  .option("--from-policy", "Split legacy runtime settings from codex/POLICY.json.", false)
  .option("--yes", "Apply migration. Without this, only preview.", false)
  .description("Preview or apply runtime config split migration.")
  .action(async (options: { fromPolicy: boolean; yes: boolean }) => {
    await main(async (workspaceRoot) => {
      if (!options.fromPolicy) {
        throw new Error("Only --from-policy migration is supported.");
      }
      const result = options.yes
        ? await applyRuntimeConfigMigration(workspaceRoot)
        : await buildRuntimeConfigMigration(workspaceRoot);
      console.log(result.preview);
      if (options.yes) {
        await new PolicyManager(workspaceRoot).syncMarkdown();
        console.log("Applied runtime config migration.");
      }
    });
  });

providerCommand
  .command("list")
  .description("List configured model providers.")
  .action(async () => {
    await main(async (workspaceRoot) => {
      const policy = await new PolicyManager(workspaceRoot).loadPolicy();
      console.log("Provider              Type               Default  Enabled  Timeout  Retry  MaxPrompt  Model  BaseUrl  API Key Env");
      for (const item of listProviders(policy)) {
        console.log([
          item.id.padEnd(21),
          String(item.type ?? (item.builtIn ? "built-in" : "-")).padEnd(18),
          String(item.isDefault).padEnd(7),
          String(item.enabled).padEnd(7),
          String(item.timeoutMs ?? "-").padEnd(7),
          String(item.structuredRetryCount ?? "-").padEnd(5),
          String(item.maxPromptChars ?? "-").padEnd(9),
          String(item.modelConfigured ?? "-").padEnd(5),
          String(item.baseUrlConfigured ?? "-").padEnd(7),
          item.apiKeyEnv ?? (item.builtIn ? "built-in" : "-")
        ].join("  "));
      }
    });
  });

providerCommand
  .command("check")
  .argument("<provider-id>")
  .description("Check a provider configuration and auth status.")
  .action(async (providerId: string) => {
    await main(async (workspaceRoot) => {
      const policy = await new PolicyManager(workspaceRoot).loadPolicy();
      const result = await checkProvider(providerId, workspaceRoot, policy);
      console.log(`Provider: ${result.id}`);
      console.log(`Status: ${result.ok ? "ok" : "failed"}`);
      console.log(`Message: ${result.message}`);
      if (result.reason) {
        console.log(`Reason: ${result.reason}`);
      }
      if (result.hint) {
        console.log(`Hint: ${result.hint}`);
      }
    });
  });

const gateway = program.command("gateway").description("Manage COSIA external gateway connectors.");

gateway
  .command("start")
  .option("--connector <connector>", "Connector to start. v0.26.1 supports telegram.")
  .option("--model-provider <provider>", "Model provider for gateway chat messages.")
  .option("--once", "Process one update batch and exit.", false)
  .description("Start the COSIA gateway supervisor.")
  .action(async (options: { connector?: string; modelProvider?: string; once: boolean }) => {
    await main(async (workspaceRoot) => {
      if (options.connector && options.connector !== "telegram") {
        throw new Error(`Unsupported gateway connector: ${options.connector}`);
      }
      await startGateway(workspaceRoot, {
        connector: options.connector as "telegram" | undefined,
        modelProvider: options.modelProvider,
        once: options.once
      });
    });
  });

gateway
  .command("stop")
  .option("--timeout-ms <ms>", "Milliseconds to wait for cooperative shutdown.", "10000")
  .description("Request cooperative gateway shutdown.")
  .action(async (options: { timeoutMs: string }) => {
    await main(async (workspaceRoot) => {
      console.log(formatGatewayStopResult(await stopGateway(workspaceRoot, {
        timeoutMs: parseIntegerOption(options.timeoutMs, "--timeout-ms")
      })));
    });
  });

gateway
  .command("restart")
  .option("--connector <connector>", "Connector to restart. v0.26.1 supports telegram.")
  .option("--model-provider <provider>", "Model provider for gateway chat messages.")
  .option("--timeout-ms <ms>", "Milliseconds to wait for cooperative shutdown.", "10000")
  .option("--once", "After stopping, process one update batch and exit.", false)
  .description("Cooperatively stop and then start the gateway supervisor.")
  .action(async (options: { connector?: string; modelProvider?: string; timeoutMs: string; once: boolean }) => {
    await main(async (workspaceRoot) => {
      if (options.connector && options.connector !== "telegram") {
        throw new Error(`Unsupported gateway connector: ${options.connector}`);
      }
      await restartGateway(workspaceRoot, {
        connector: options.connector as "telegram" | undefined,
        modelProvider: options.modelProvider,
        timeoutMs: parseIntegerOption(options.timeoutMs, "--timeout-ms"),
        once: options.once
      });
    });
  });

gateway
  .command("status")
  .option("--json", "Print structured JSON gateway status.", false)
  .description("Show gateway connector state.")
  .action(async (options: { json: boolean }) => {
    await main(async (workspaceRoot) => {
      console.log(await formatGatewayStatus(workspaceRoot, { json: options.json }));
    });
  });

gateway
  .command("unlock")
  .option("--stale-only", "Only remove stale gateway process locks.", false)
  .description("Remove a stale top-level gateway process lock.")
  .action(async (options: { staleOnly: boolean }) => {
    await main(async (workspaceRoot) => {
      console.log(formatGatewayUnlockResult(await unlockStaleGateway(workspaceRoot, { staleOnly: options.staleOnly })));
    });
  });

const telegram = gateway.command("telegram").description("Manage the Telegram remote console connector.");

telegram
  .command("check")
  .description("Check Telegram connector policy, token env, allowlist, and getMe.")
  .action(async () => {
    await main(async (workspaceRoot) => {
      console.log(formatTelegramCheck(await checkTelegramGateway(workspaceRoot)));
    });
  });

telegram
  .command("start")
  .option("--provider <provider>", "Provider for Telegram chat messages.")
  .option("--once", "Process one update batch and exit.", false)
  .description("Debug: start Telegram long polling directly. Normal use: cosia gateway start.")
  .action(async (options: { provider?: string; once: boolean }) => {
    await main(async (workspaceRoot) => {
      await startTelegramGateway(workspaceRoot, {
        providerId: options.provider,
        once: options.once,
        command: "cosia gateway telegram start"
      });
    });
  });

telegram
  .command("unlock")
  .option("--stale-only", "Only remove stale gateway process locks.", false)
  .description("Remove a stale Telegram gateway process lock.")
  .action(async (options: { staleOnly: boolean }) => {
    await main(async (workspaceRoot) => {
      const result = await unlockStaleTelegramGateway(workspaceRoot, { staleOnly: options.staleOnly });
      console.log([
        "Telegram gateway unlock",
        `Removed: ${result.removed}`,
        `Reason: ${result.reason}`
      ].join("\n"));
    });
  });

const mvp = program.command("mvp").description("MVP acceptance helpers.");

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

const improveCommand = program.command("improve").description("Inspect and apply governed self-improvement candidates.");

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

const commandCommand = program.command("command").description("Inspect runtime command metadata.");
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
  .description("Show session metadata and recent context memory.")
  .action(async (sessionId: string, options: { tail: string }) => {
    await main(async (workspaceRoot) => {
      const sessions = new SessionManager(workspaceRoot);
      const metadata = await sessions.loadSession(sessionId);
      const policy = await new PolicyManager(workspaceRoot).loadPolicy();
      const contextStatus = await sessions.contextStatus(sessionId, {
        warningChars: policy.promptBudget.contextWarningChars,
        criticalChars: policy.promptBudget.contextCriticalChars
      });
      console.log(JSON.stringify(metadata, null, 2));
      console.log(`\n# CONTEXT STATUS\n`);
      console.log(formatContextStatus(contextStatus));
      if (contextStatus.level !== "ok" || contextStatus.compactRecommended) {
        console.log(contextMaintenanceHint(sessionId));
      }
      const tail = await sessions.contextTail(sessionId, Number.parseInt(options.tail, 10));
      console.log("\n# CONTEXT TAIL\n");
      console.log(tail || "No context memory.");
    });
  });

session
  .command("summarize")
  .argument("<session-id>")
  .option("--content <summary>", "Compact session summary")
  .option("--from-context", "Generate a summary proposal from budgeted context.", false)
  .option("--provider <provider>", "Model provider for --from-context")
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
      const providerId = options.provider ?? policy.model.defaultProvider;
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
  .description("Show readable prompt budget manifests for a session.")
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
  .description("Scan generic workspace facts and review zero-base capability proposals.")
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
  .description("Create, apply, cancel, or inspect one-shot user-approved shell command previews.")
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
  .description("List, draft, review, activate, or run policy-gated tools.")
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
          })));
          return;
        }
        if (action === "review") {
          console.log(formatToolGrowthReview(growth.list({ all: options.all })));
          return;
        }
        if (action === "show") {
          if (!extraId) throw new Error("Usage: cosia tool grow show <routine-id>");
          const routine = growth.get(extraId);
          const candidate = routine.selectedCandidateId ? acquisition.getCandidate(routine.selectedCandidateId) : undefined;
          console.log(formatToolGrowthRoutine(routine, candidate));
          return;
        }
        if (action === "test") {
          if (!extraId) throw new Error("Usage: cosia tool grow test <routine-id> --yes");
          console.log(formatToolGrowthTest(await growth.test(extraId, { yes: options.yes })));
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
          console.log(formatToolGrowthStart(await growth.retry(extraId, { providerId: options.provider })));
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
        console.log(`Next: cosia provider check ${report.providerId}`);
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
  .option("--provider <provider>", "Model provider: codex-cli, openai-compatible, or mock")
  .option("--provider-timeout-ms <ms>", "Override provider call timeout in milliseconds")
  .option("--approve-overwrite", "Allow interactive overwrite approval prompts", false)
  .option("--require-tools", "Require at least one read_file or search_files call before final.", false)
  .option("--skill <skill-id...>", "Manually include one or more global skills.")
  .description("Run a session turn.")
  .action(async (options: { session: string; prompt: string; agent?: string; provider?: string; providerTimeoutMs?: string; approveOverwrite: boolean; requireTools: boolean; skill?: string[] }) => {
    await main(async (workspaceRoot) => {
      const { withSessionLock } = await import("./runtime/gateway_locks.js");
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
  .option("--provider <provider>", "Model provider: codex-cli, openai-compatible, or mock")
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

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});

async function main(fn: (workspaceRoot: string) => Promise<void>, options: { allowUninitialized?: boolean } = {}): Promise<void> {
  try {
    const workspaceRoot = options.allowUninitialized
      ? await workspaceRootForInit(process.cwd())
      : await requireWorkspaceRoot(process.cwd());
    await fn(workspaceRoot);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

function resolveResetMode(options: { state: boolean; factory: boolean }): ResetMode {
  if (options.state === options.factory) {
    throw new Error("Choose exactly one reset mode: --state or --factory.");
  }
  return options.factory ? "factory" : "state";
}

async function askOnce(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

async function createStartSession(workspaceRoot: string, goal: string): Promise<SessionMetadata> {
  const trimmedGoal = goal.trim();
  if (!trimmedGoal) {
    throw new Error("A session goal is required.");
  }
  const policy = await new PolicyManager(workspaceRoot).loadPolicy();
  const agentId = policy.agents.defaultAgentId;
  if (!agentId) {
    throw new Error("No default agent is configured. Run `cosia agent bootstrap` first.");
  }
  await new AgentManager(workspaceRoot).loadAgent(agentId);
  const session = await new SessionManager(workspaceRoot).createSession(agentId, trimmedGoal);
  console.log(`Created session: ${session.id}`);
  return session;
}

function parseIntegerOption(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function parseNumberOption(value: string, name: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

type ToolCliOptions = {
  args?: string;
  path?: string;
  staged: boolean;
  maxCount?: string;
  fromCapability?: string;
  request?: string;
  provider: string;
  agent?: string;
  reason?: string;
  yes: boolean;
  all: boolean;
};

function normalizeCliToolId(value: string): ToolName {
  const candidate = value.replace(/-/g, "_");
  return isToolId(candidate) ? candidate : value;
}

function parseCliToolArgs(toolId: ToolName, options: ToolCliOptions): Record<string, unknown> {
  const args = options.args ? parseJsonObjectOption(options.args, "args") : {};
  if (options.path !== undefined) {
    args.path = options.path;
  }
  if (options.staged) {
    args.staged = true;
  }
  if (options.maxCount !== undefined) {
    args.maxCount = parseIntegerOption(options.maxCount, "max-count");
  }
  if (Object.keys(args).length === 0) {
    return {};
  }
  return args;
}

function parseJsonObjectOption(value: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Invalid --${name} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid --${name}: expected a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function formatToolCatalog(activeTools: ActiveToolRecord[] = []): string {
  const grouped = new Map<string, ToolName[]>();
  for (const id of toolNameValues) {
    const entry = getToolCatalogEntry(id);
    const group = entry.category === "core" ? "core" : entry.extensionId;
    grouped.set(group, [...(grouped.get(group) ?? []), id]);
  }
  const lines = ["COSIA Tool Catalog", ""];
  for (const [group, ids] of grouped) {
    lines.push(group === "core" ? "Core Runtime Tools" : `Bundled Extension Tools: ${group}`);
    lines.push("Tool                 Permission       Exposure   Default  Description");
    for (const id of ids) {
      const entry = toolCatalog[id as keyof typeof toolCatalog];
      lines.push(`${id.padEnd(20)} ${entry.permission.padEnd(16)} ${entry.exposure.padEnd(10)} ${String(entry.defaultEnabled).padEnd(8)} ${entry.description}`);
    }
    lines.push("");
  }
  lines.push("Run:");
  lines.push("  cosia tool run <tool-id> --args \"{...}\"");
  lines.push("  cosia shell preview --command \"<command>\" --reason \"<reason>\"");
  lines.push("  cosia tool draft --from-capability <capability-id>");
  lines.push("  cosia tool grow --request \"<request>\" --provider mock");
  lines.push("  cosia tool candidate review");
  lines.push("  cosia tool activate <candidate-id> --agent <agent-id> --yes");
  lines.push("  cosia tool blueprint list");
  if (activeTools.length) {
    lines.push("");
    lines.push("Workspace Active Tools");
    lines.push("Tool                 Status       Permission       Exposure   Agents");
    for (const tool of activeTools) {
      lines.push(`${tool.id.padEnd(20)} ${tool.status.padEnd(12)} ${tool.permission.padEnd(16)} ${tool.exposure.padEnd(10)} ${tool.targetAgentIds.join(",") || "-"}`);
    }
  }
  lines.push("");
  lines.push("Zero-base capability flow:");
  lines.push("  cosia capability scan --request \"<request>\"");
  lines.push("  cosia capability plan --request \"<request>\"");
  lines.push("  cosia capability facts --latest");
  lines.push("  cosia capability review");
  return lines.join("\n");
}

async function resolveMemoryTierOptions(
  workspaceRoot: string,
  options: { tier?: string; scope?: string; ownerId?: string },
  requireTier: boolean
): Promise<{ tier?: MemoryTier; scope?: MemoryScope; ownerId?: string | null }> {
  if (options.tier && options.scope) {
    throw new Error("Use either --tier or deprecated --scope, not both.");
  }
  if (!options.tier && !options.scope) {
    if (requireTier) {
      throw new Error("Memory tier is required. Use --tier core, --tier agent, or --tier session.");
    }
    return { ownerId: options.ownerId };
  }
  const scope = options.scope ? memoryScopeSchema.parse(options.scope) : undefined;
  const tier = options.tier
    ? memoryTierSchema.parse(options.tier)
    : scope === "session"
      ? "session"
      : scope === "agent"
        ? "agent"
        : "core";
  if (scope) {
    console.error(`[cosia] warning: --scope is deprecated; using tier '${tier}' with legacy scope '${scope}'.`);
  }
  if (tier === "agent") {
    if (!options.ownerId) {
      throw new Error("--owner-id is required for agent memory.");
    }
    await new AgentManager(workspaceRoot).loadAgent(options.ownerId);
  }
  if (tier === "session") {
    if (!options.ownerId) {
      throw new Error("--owner-id is required for session memory.");
    }
    await new SessionManager(workspaceRoot).loadSession(options.ownerId);
  }
  return {
    tier,
    scope,
    ownerId: tier === "core" ? options.ownerId ?? null : options.ownerId
  };
}

async function resolveBootstrapOptions(options: {
  id?: string;
  name?: string;
  role?: string;
  voice?: string;
  priorities?: string;
  boundaries?: string;
}): Promise<{
  id: string;
  name: string;
  role: string;
  voice: string;
  priorities: string;
  boundaries: string;
}> {
  if (options.id && options.name && options.role && options.voice) {
    return {
      id: options.id,
      name: options.name,
      role: options.role,
      voice: options.voice,
      priorities: options.priorities ?? "",
      boundaries: options.boundaries ?? ""
    };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const id = options.id ?? (await rl.question("Agent id: ")).trim();
    const name = options.name ?? (await rl.question("Display name: ")).trim();
    const role = options.role ?? (await rl.question("Role: ")).trim();
    const voice = options.voice ?? (await rl.question("Voice: ")).trim();
    const priorities = options.priorities ?? (await rl.question("Priorities (comma-separated, optional): ")).trim();
    const boundaries = options.boundaries ?? (await rl.question("Boundaries (comma-separated, optional): ")).trim();
    if (!id || !name || !role || !voice) {
      throw new Error("Agent id, name, role, and voice are required.");
    }
    return { id, name, role, voice, priorities, boundaries };
  } finally {
    rl.close();
  }
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatPromptManifest(manifest: PromptManifest): string {
  const lines = [
    `Run: ${manifest.runId ?? "legacy/no-run-id"}`,
    `Agent: ${manifest.agentId ?? "legacy/unknown"}`,
    `Model step: ${manifest.modelStep ?? "unknown"}`,
    `Timestamp: ${manifest.timestamp}`,
    `Prompt chars: ${manifest.promptChars}/${manifest.maxPromptChars}`,
    `Target chars: ${manifest.targetPromptChars}`,
    `Estimated tokens: ${manifest.estimatedTokens}`,
    `Overflowed: ${manifest.overflowed}`,
    "Blocks:"
  ];
  for (const block of manifest.blocks) {
    lines.push(`- ${block.title} [${block.source}] ${block.retainedChars}/${block.originalChars} chars${block.truncated ? " truncated" : ""}`);
  }
  if (manifest.skillSelections?.length) {
    lines.push("Skills:");
    for (const skill of manifest.skillSelections) {
      lines.push(`- ${skill.skillId} ${skill.selected ? "selected" : "omitted"} by:${skill.selectedBy} score:${skill.finalScore} trigger:${skill.triggerScore} pref:${skill.preferredBonus} weight:${skill.weightBonus} triggers:${skill.matchedTriggers.join(",") || "none"} ${skill.retainedChars}/${skill.originalChars} chars${skill.truncated ? " truncated" : ""}${skill.omittedReason ? ` reason:${skill.omittedReason}` : ""}`);
    }
  }
  if (manifest.context) {
    lines.push("Context:");
    lines.push(`- chars:${manifest.context.chars} health:${manifest.context.healthLevel} summaryPlaceholder:${manifest.context.summaryIsPlaceholder} compactRecommended:${manifest.context.compactRecommended}`);
  }
  return lines.join("\n");
}

async function printSessionList(workspaceRoot: string, sessions: SessionMetadata[]): Promise<void> {
  const agents = await new AgentManager(workspaceRoot).listAgents();
  const knownAgentIds = new Set(agents.map((agent) => agent.id));
  for (const item of sessions) {
    const assigned = item.assignedAgentId ?? "none";
    const assignmentStatus = item.assignedAgentId
      ? knownAgentIds.has(item.assignedAgentId)
        ? "assigned"
        : "orphan"
      : "unassigned";
    console.log(`${item.id}\t${assigned}\t${assignmentStatus}\t${item.status}\t${item.updatedAt}\t${item.goal}`);
  }
}

function formatContextHealth(health: { sessionId: string; chars: number; warningChars: number; criticalChars: number; level: string }): string {
  return `${health.sessionId} ${health.level} ${health.chars} chars (warning:${health.warningChars}, critical:${health.criticalChars})`;
}

function formatContextStatus(status: {
  sessionId: string;
  chars: number;
  warningChars: number;
  criticalChars: number;
  level: string;
  runEntryCount: number;
  archiveEntryCount: number;
  summaryIsPlaceholder: boolean;
  compactRecommended: boolean;
}): string {
  return [
    `Session: ${status.sessionId}`,
    `Context: ${status.level} ${status.chars} chars (warning:${status.warningChars}, critical:${status.criticalChars})`,
    `Run entries: ${status.runEntryCount}`,
    `Archived entries: ${status.archiveEntryCount}`,
    `Summary placeholder: ${status.summaryIsPlaceholder}`,
    `Compact recommended: ${status.compactRecommended}`
  ].join("\n");
}

function formatContextCompactResult(result: {
  applied: boolean;
  blocked: boolean;
  movedAt?: string;
  message: string;
  contextCharsBefore: number;
  contextCharsAfter: number;
  keptRuns: number;
  archivedRuns: number;
  summaryIsPlaceholder: boolean;
}): string {
  const lines = [
    result.message,
    `Applied: ${result.applied}`,
    `Blocked: ${result.blocked}`,
    `Kept runs: ${result.keptRuns}`,
    `Archived runs: ${result.archivedRuns}`,
    `Context chars: ${result.contextCharsBefore} -> ${result.contextCharsAfter}`,
    `Summary placeholder: ${result.summaryIsPlaceholder}`
  ];
  if (result.movedAt) {
    lines.push(`Moved at: ${result.movedAt}`);
  }
  return lines.join("\n");
}

function contextCriticalHint(sessionId: string): string {
  return contextMaintenanceHint(sessionId);
}

function contextMaintenanceHint(sessionId: string): string {
  return [
    "Suggested context maintenance:",
    `- cosia session context status ${sessionId}`,
    `- cosia session prompt ${sessionId} --latest`,
    `- cosia session summarize ${sessionId} --content \"<summary>\"`,
    `- cosia session summarize ${sessionId} --from-context --provider <provider>`,
    `- cosia session context compact ${sessionId} --keep-last 5 --reason \"<reason>\"`,
    `- cosia session context undo-last ${sessionId} --reason \"<reason>\"`
  ].join("\n");
}

async function generateSessionSummary(
  workspaceRoot: string,
  session: SessionMetadata,
  providerId: string,
  options: { timeoutMs?: number; contextChars: number }
): Promise<string> {
  const sessions = new SessionManager(workspaceRoot);
  const policy = await new PolicyManager(workspaceRoot).loadPolicy();
  const source = await sessions.summarySource(session.id, options.contextChars);
  let providerIdForFailure = providerId;
  try {
    const provider = createProvider(providerId, workspaceRoot, {
      policy,
      timeoutMs: options.timeoutMs
    });
    providerIdForFailure = provider.id;
    if (provider.id !== "mock") {
      const auth = await provider.checkAuth();
      if (!auth.ok) {
        throw new ProviderError(auth.reason ?? "auth_failed", `Model provider auth failed: ${auth.message}`, {
          hint: auth.hint
        });
      }
    }
    const output = await provider.complete({
      sessionId: session.id,
      prompt: buildSessionSummaryPrompt(session, source)
    });
    if (output.step.type !== "final") {
      throw new ProviderError("malformed_agent_step", "Summary provider returned a tool_call; expected final.");
    }
    return output.step.content.trim();
  } catch (error) {
    throw new Error(formatProviderFailure(error, providerIdForFailure));
  }
}

function buildSessionSummaryPrompt(
  session: SessionMetadata,
  source: {
    existingSummary: string;
    summaryIsPlaceholder: boolean;
    contextTail: string;
    contextChars: number;
    retainedContextChars: number;
    runEntryCount: number;
  }
): string {
  return `Return only one valid JSON object. Do not wrap it in Markdown.

You are updating COSIA's SESSION_SUMMARY.md for a single session.
Return a concise durable summary of the session so far.
Preserve goals, important decisions, current state, blockers, and next actions.
Do not invent facts outside the provided context.
Do not call tools.

AgentStep final schema:
{"type":"final","content":"...","memoryCandidates":[],"skillCandidates":[]}

Session:
- id: ${session.id}
- goal: ${session.goal}
- status: ${session.status}
- assigned agent: ${session.assignedAgentId ?? "none"}

Existing summary (${source.summaryIsPlaceholder ? "placeholder" : "user-written"}):
${source.existingSummary}

Context source:
- total chars: ${source.contextChars}
- retained chars: ${source.retainedContextChars}
- run entries: ${source.runEntryCount}

Context tail:
${source.contextTail}
`;
}

async function runCliTool(workspaceRoot: string, name: ToolName, args: Record<string, unknown>): Promise<void> {
  const result = await new ToolRegistry().execute(name, args, {
    workspaceRoot,
    allowedTools: [name],
    sourceChannel: "cli"
  });
  console.log(result.content);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function readRawPolicy(workspaceRoot: string): Promise<unknown> {
  return JSON.parse(await readText(join(workspaceRoot, "codex", "POLICY.json"))) as unknown;
}
