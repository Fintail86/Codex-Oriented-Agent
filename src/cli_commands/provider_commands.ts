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
import { addProviderProfile, useProviderProfile } from "../runtime/provider_profiles.js";
import { registerProviderProfileCommands } from "./provider_profiles.js";
import {
  authModeFromOptions,
  formatProviderSetupResult,
  formatSupportedProviders,
  listSupportedProviderDescriptors,
  requireProviderDescriptor,
  type ProviderAuthMode
} from "../runtime/provider_onboarding.js";
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

export function registerProviderCommands(program: Command): void {
  const providerCommand = program.command("provider").description("Inspect model providers.");

  providerCommand
    .command("list-supported")
    .description("List supported provider setup paths without selecting a default.")
    .action(() => {
      console.log(formatSupportedProviders());
    });

  providerCommand
    .command("setup")
    .option("--provider <provider-id>", "Provider implementation id to configure.")
    .option("--name <profile-name>", "Provider profile name to create or update.")
    .option("--oauth", "Use provider OAuth mode when supported.", false)
    .option("--api-key", "Prompt for an API key and store it in the private secret store.", false)
    .option("--api-key-env <env-name>", "Read the API key from an environment variable.")
    .option("--model <model-id>", "Model id for providers that require one.")
    .option("--base-url <url>", "Base URL for openai-compatible providers.")
    .option("--use", "Select the created profile as the active provider profile.", false)
    .description("Guided provider profile setup.")
    .action(async (options: {
      provider?: string;
      name?: string;
      oauth: boolean;
      apiKey: boolean;
      apiKeyEnv?: string;
      model?: string;
      baseUrl?: string;
      use: boolean;
    }) => {
      await main(async (workspaceRoot) => {
        const providerId = await resolveSetupProviderId(options.provider);
        const descriptor = requireProviderDescriptor(providerId);
        const name = options.name ?? await askProviderProfileName(descriptor.defaultProfileName);
        const authMode = await resolveSetupAuthMode({
          providerId: descriptor.providerId,
          oauth: options.oauth,
          apiKey: options.apiKey,
          apiKeyEnv: options.apiKeyEnv
        });
        const model = descriptor.requiresModel
          ? options.model ?? await askRequired("Model id: ")
          : options.model;
        const baseUrl = descriptor.requiresBaseUrl
          ? options.baseUrl ?? await askRequired("Base URL: ")
          : options.baseUrl;
        const apiKeyEnv = authMode === "env"
          ? options.apiKeyEnv ?? await askRequired(`API key env [${descriptor.defaultApiKeyEnv ?? "OPENAI_API_KEY"}]: `, descriptor.defaultApiKeyEnv)
          : undefined;
        const apiKey = authMode === "secret"
          ? await promptHidden("API key: ")
          : undefined;
        const profile = await addProviderProfile(workspaceRoot, name, {
          providerId: descriptor.providerId,
          oauth: authMode === "oauth",
          apiKey,
          apiKeyEnv,
          model,
          baseUrl
        });
        if (options.use) {
          await useProviderProfile(workspaceRoot, profile.name);
        }
        console.log(formatProviderSetupResult({
          profileName: profile.name,
          providerId: profile.providerId,
          authMode,
          used: options.use
        }));
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

  registerProviderProfileCommands(providerCommand, { main, promptHidden });
}

async function resolveSetupProviderId(providerId?: string): Promise<string> {
  if (providerId) {
    return providerId;
  }
  console.log(formatSupportedProviders());
  return askRequired("Provider id: ");
}

async function askProviderProfileName(defaultName: string): Promise<string> {
  const value = await askOnce(`Profile name [${defaultName}]: `);
  return value || defaultName;
}

async function resolveSetupAuthMode(options: {
  providerId: string;
  oauth: boolean;
  apiKey: boolean;
  apiKeyEnv?: string;
}): Promise<ProviderAuthMode> {
  const explicit = authModeFromOptions({
    providerId: options.providerId,
    oauth: options.oauth,
    apiKey: options.apiKey ? "__prompt__" : undefined,
    apiKeyEnv: options.apiKeyEnv
  });
  if (explicit) {
    return explicit;
  }
  const descriptor = requireProviderDescriptor(options.providerId);
  if (descriptor.authModes.length === 1) {
    return descriptor.authModes[0];
  }
  const raw = await askRequired(`Auth mode (${descriptor.authModes.map((mode) => mode === "secret" ? "api-key" : mode).join("/")}): `);
  const normalized = raw === "api-key" ? "secret" : raw;
  if (normalized !== "oauth" && normalized !== "secret" && normalized !== "env") {
    throw new Error(`Unsupported auth mode: ${raw}`);
  }
  return normalized;
}

async function askRequired(prompt: string, defaultValue?: string): Promise<string> {
  const value = await askOnce(prompt);
  const resolved = value || defaultValue;
  if (!resolved) {
    throw new Error(`${prompt.trim()} is required.`);
  }
  return resolved;
}
