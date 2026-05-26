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
  allowGatewayChat,
  clearGatewayMaster,
  formatGatewayAuthCheck,
  formatGatewayAuthList,
  gatewayAuthSummary,
  removeGatewayChat,
  setGatewayMaster,
  setGatewayRoleBinding,
  unsetGatewayRoleBinding
} from "../runtime/gateway_auth.js";
import {
  checkTelegramGateway,
  clearTelegramWebhook,
  formatTelegramCheck,
  formatTelegramStateInspection,
  formatTelegramStateRepair,
  formatTelegramStateReset,
  formatTelegramWebhookClear,
  formatTelegramWebhookStatus,
  getTelegramWebhookStatus,
  inspectTelegramGatewayState,
  repairTelegramGatewayState,
  resetTelegramGatewayState,
  resolveTelegramToken,
  startTelegramGateway
} from "../runtime/telegram_gateway.js";
import {
  addTelegramChatId,
  addTelegramMutationUserId,
  addTelegramUserId,
  enableTelegramConnector,
  formatTelegramConnectorList,
  removeTelegramChatId,
  removeTelegramMutationUserId,
  removeTelegramUserId,
  setTelegramGroupMode,
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

export function registerGatewayCommands(program: Command): void {
  const gateway = program.command("gateway").description("Manage COSIA external gateway connectors.");

  gateway
    .command("start")
    .option("--connector <connector>", "Connector to start. v0.26.1 supports telegram.")
    .option("--provider-profile <name>", "Temporary provider profile override for gateway chat messages.")
    .option("--once", "Process one update batch and exit.", false)
    .description("Start the COSIA gateway supervisor.")
    .action(async (options: { connector?: string; providerProfile?: string; once: boolean }) => {
      await main(async (workspaceRoot) => {
        if (options.connector && options.connector !== "telegram") {
          throw new Error(`Unsupported gateway connector: ${options.connector}`);
        }
        await startGateway(workspaceRoot, {
          connector: options.connector as "telegram" | undefined,
          providerProfile: options.providerProfile,
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
    .option("--provider-profile <name>", "Temporary provider profile override for gateway chat messages.")
    .option("--timeout-ms <ms>", "Milliseconds to wait for cooperative shutdown.", "10000")
    .option("--once", "After stopping, process one update batch and exit.", false)
    .description("Cooperatively stop and then start the gateway supervisor.")
    .action(async (options: { connector?: string; providerProfile?: string; timeoutMs: string; once: boolean }) => {
      await main(async (workspaceRoot) => {
        if (options.connector && options.connector !== "telegram") {
          throw new Error(`Unsupported gateway connector: ${options.connector}`);
        }
        await restartGateway(workspaceRoot, {
          connector: options.connector as "telegram" | undefined,
          providerProfile: options.providerProfile,
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

  const auth = gateway.command("auth").description("Manage connector-neutral Gateway chat/user authorization.");

  auth
    .command("allow-chat")
    .argument("<connector>")
    .argument("<chat-id>")
    .option("--label <label>", "Optional local label.")
    .description("Allow an external connector chat.")
    .action(async (connector: string, chatId: string, options: { label?: string }) => {
      await main(async (workspaceRoot) => {
        const next = await allowGatewayChat(workspaceRoot, connector, chatId, options.label);
        console.log(`Gateway authorized chats: ${next.chats.length}`);
      });
    });

  auth
    .command("remove-chat")
    .argument("<connector>")
    .argument("<chat-id>")
    .description("Remove an external connector chat and its scoped role bindings.")
    .action(async (connector: string, chatId: string) => {
      await main(async (workspaceRoot) => {
        const next = await removeGatewayChat(workspaceRoot, connector, chatId);
        console.log(`Gateway authorized chats: ${next.chats.length}`);
      });
    });

  auth
    .command("set-master")
    .argument("<connector>")
    .argument("<user-id>")
    .option("--label <label>", "Optional local label.")
    .description("Set the single global Gateway master user.")
    .action(async (connector: string, userId: string, options: { label?: string }) => {
      await main(async (workspaceRoot) => {
        await setGatewayMaster(workspaceRoot, connector, userId, options.label);
        console.log(`Gateway master user: ${connector}:${userId}`);
      });
    });

  auth
    .command("clear-master")
    .description("Clear the global Gateway master user.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        await clearGatewayMaster(workspaceRoot);
        console.log("Gateway master user cleared.");
      });
    });

  auth
    .command("set-role")
    .argument("<connector>")
    .argument("<user-id>")
    .argument("<role>")
    .requiredOption("--chat-id <chat-id>", "Chat id for this scoped role binding.")
    .option("--label <label>", "Optional local label.")
    .description("Set a chat-scoped Gateway role binding. Use set-master for master.")
    .action(async (connector: string, userId: string, role: string, options: { chatId: string; label?: string }) => {
      await main(async (workspaceRoot) => {
        if (role !== "guest" && role !== "admin") {
          throw new Error("Gateway chat-scoped role must be guest or admin. Use `cosia gateway auth set-master` for master.");
        }
        const next = await setGatewayRoleBinding(workspaceRoot, connector, userId, role, options.chatId, options.label);
        console.log(`Gateway role bindings: ${next.roleBindings.length}`);
      });
    });

  auth
    .command("unset-role")
    .argument("<connector>")
    .argument("<user-id>")
    .requiredOption("--chat-id <chat-id>", "Chat id for this scoped role binding.")
    .description("Remove a chat-scoped Gateway role binding.")
    .action(async (connector: string, userId: string, options: { chatId: string }) => {
      await main(async (workspaceRoot) => {
        const next = await unsetGatewayRoleBinding(workspaceRoot, connector, userId, options.chatId);
        console.log(`Gateway role bindings: ${next.roleBindings.length}`);
      });
    });

  auth
    .command("list")
    .description("List Gateway authorization without printing secrets.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        console.log(await formatGatewayAuthList(workspaceRoot));
      });
    });

  auth
    .command("check")
    .argument("<connector>")
    .requiredOption("--chat-id <id>", "External connector chat id.")
    .requiredOption("--user-id <id>", "External connector user id.")
    .option("--chat-type <type>", "private|group|supergroup|channel", "private")
    .description("Check the resolved Gateway role for a connector actor.")
    .action(async (connector: string, options: { chatId: string; userId: string; chatType: string }) => {
      await main(async (workspaceRoot) => {
        console.log(await formatGatewayAuthCheck(workspaceRoot, {
          connector,
          chatId: options.chatId,
          userId: options.userId,
          chatType: options.chatType
        }));
      });
    });

  const telegram = gateway.command("telegram").description("Manage the Telegram remote console connector.");

  telegram
    .command("enable")
    .description("Enable the Telegram gateway connector in private runtime config.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        const config = await enableTelegramConnector(workspaceRoot, true);
        console.log(`Telegram connector enabled: ${config.enabled}`);
      });
    });

  telegram
    .command("disable")
    .description("Disable the Telegram gateway connector in private runtime config.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        const config = await enableTelegramConnector(workspaceRoot, false);
        console.log(`Telegram connector enabled: ${config.enabled}`);
      });
    });

  telegram
    .command("set")
    .argument("<field>")
    .argument("[value]")
    .description("Set Telegram connector fields: chat-id/id, user-id, mutation-user-id, group-mode, token, token-env.")
    .action(async (field: string, value?: string) => {
      await main(async (workspaceRoot) => {
        switch (field) {
          case "chat-id":
          case "id": {
            if (!value) throw new Error(`Usage: cosia gateway telegram set ${field} <chat-id>`);
            await addTelegramChatId(workspaceRoot, value);
            const policy = await new PolicyManager(workspaceRoot).loadPolicy();
            console.log(`Gateway authorized chats: ${gatewayAuthSummary(policy).chatCount}`);
            console.log(`Canonical: cosia gateway auth allow-chat telegram ${value}`);
            break;
          }
          case "user-id": {
            if (!value) throw new Error("Usage: cosia gateway telegram set user-id <user-id>");
            await addTelegramUserId(workspaceRoot, value);
            const policy = await new PolicyManager(workspaceRoot).loadPolicy();
            console.log(`Gateway admin bindings: ${gatewayAuthSummary(policy).adminBindings}`);
            console.log("Compatibility alias: prefer `cosia gateway auth set-role telegram <user-id> admin --chat-id <chat-id>`.");
            break;
          }
          case "mutation-user-id": {
            if (!value) throw new Error("Usage: cosia gateway telegram set mutation-user-id <user-id>");
            await addTelegramMutationUserId(workspaceRoot, value);
            console.log(`Gateway master user: telegram:${value}`);
            console.log("Compatibility alias: prefer `cosia gateway auth set-master telegram <user-id>`.");
            break;
          }
          case "group-mode": {
            if (value !== "read-only" && value !== "read_only" && value !== "allowed-users" && value !== "allowed_users") {
              throw new Error("Usage: cosia gateway telegram set group-mode read-only|allowed-users");
            }
            const normalized = value.replace("-", "_") as "read_only" | "allowed_users";
            const config = await setTelegramGroupMode(workspaceRoot, normalized);
            console.log(`Telegram group mode: ${config.groupMode}`);
            break;
          }
          case "token": {
            if (value) throw new Error("Do not pass Telegram token as an argument. Run `cosia gateway telegram set token` and enter it at the hidden prompt.");
            const token = await promptHidden("Telegram bot token: ");
            await setTelegramToken(workspaceRoot, token);
            console.log("Telegram token stored in private secret store.");
            break;
          }
          case "token-env": {
            if (!value) throw new Error("Usage: cosia gateway telegram set token-env <ENV_NAME>");
            const config = await setTelegramTokenEnv(workspaceRoot, value);
            console.log(`Telegram token env: ${config.tokenEnv}`);
            break;
          }
          default:
            throw new Error("Unsupported Telegram field. Use chat-id, id, user-id, mutation-user-id, group-mode, token, or token-env.");
        }
      });
    });

  telegram
    .command("unset")
    .argument("<field>")
    .argument("[value]")
    .description("Unset Telegram connector fields: chat-id/id, user-id, mutation-user-id, token, token-env.")
    .action(async (field: string, value?: string) => {
      await main(async (workspaceRoot) => {
        switch (field) {
          case "chat-id":
          case "id": {
            if (!value) throw new Error(`Usage: cosia gateway telegram unset ${field} <chat-id>`);
            await removeTelegramChatId(workspaceRoot, value);
            const policy = await new PolicyManager(workspaceRoot).loadPolicy();
            console.log(`Gateway authorized chats: ${gatewayAuthSummary(policy).chatCount}`);
            break;
          }
          case "user-id": {
            if (!value) throw new Error("Usage: cosia gateway telegram unset user-id <user-id>");
            await removeTelegramUserId(workspaceRoot, value);
            const policy = await new PolicyManager(workspaceRoot).loadPolicy();
            console.log(`Gateway admin bindings: ${gatewayAuthSummary(policy).adminBindings}`);
            break;
          }
          case "mutation-user-id": {
            if (!value) throw new Error("Usage: cosia gateway telegram unset mutation-user-id <user-id>");
            await removeTelegramMutationUserId(workspaceRoot, value);
            console.log("Gateway master user cleared when it matched this Telegram user.");
            break;
          }
          case "token":
            await unsetTelegramToken(workspaceRoot);
            console.log("Telegram private token removed.");
            break;
          case "token-env": {
            const config = await unsetTelegramTokenEnv(workspaceRoot);
            console.log(`Telegram token env: ${config.tokenEnv}`);
            break;
          }
          default:
            throw new Error("Unsupported Telegram field. Use chat-id, id, user-id, mutation-user-id, token, or token-env.");
        }
      });
    });

  telegram
    .command("list")
    .description("List Telegram connector settings without printing secrets.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        const policy = await new PolicyManager(workspaceRoot).loadPolicy();
        console.log(formatTelegramConnectorList(policy.connectors.telegram, resolveTelegramToken(workspaceRoot, policy.connectors.telegram), gatewayAuthSummary(policy)));
      });
    });

  telegram
    .command("check")
    .description("Check Telegram connector policy, token env, allowlist, and getMe.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        console.log(formatTelegramCheck(await checkTelegramGateway(workspaceRoot)));
      });
    });

  const telegramWebhook = telegram
    .command("webhook")
    .description("Inspect or clear Telegram webhook settings used by the Bot API.");

  telegramWebhook
    .command("status")
    .description("Show Telegram webhook status. COSIA long polling requires no webhook.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        console.log(formatTelegramWebhookStatus(await getTelegramWebhookStatus(workspaceRoot)));
      });
    });

  telegramWebhook
    .command("clear")
    .option("--yes", "Clear the remote Telegram webhook. Without this, only show a preview.", false)
    .description("Disable Telegram webhook for this bot using deleteWebhook(drop_pending_updates=false).")
    .action(async (options: { yes: boolean }) => {
      await main(async (workspaceRoot) => {
        console.log(formatTelegramWebhookClear(await clearTelegramWebhook(workspaceRoot, {
          yes: options.yes
        })));
      });
    });

  telegram
    .command("state")
    .description("Inspect Telegram gateway runtime state without printing secrets.")
    .action(async () => {
      await main(async (workspaceRoot) => {
        console.log(formatTelegramStateInspection(await inspectTelegramGatewayState(workspaceRoot)));
      });
    });

  telegram
    .command("repair")
    .option("--stale-sessions", "Clear active chat sessions that no longer exist.", false)
    .description("Repair Telegram gateway runtime state without changing connector settings.")
    .action(async (options: { staleSessions: boolean }) => {
      await main(async (workspaceRoot) => {
        console.log(formatTelegramStateRepair(await repairTelegramGatewayState(workspaceRoot, {
          staleSessions: options.staleSessions
        })));
      });
    });

  telegram
    .command("reset-state")
    .option("--yes", "Apply the reset. Without this, only show the safe command.", false)
    .option("--no-preserve-offset", "Also clear the Telegram update offset.", true)
    .description("Reset Telegram runtime chat state while keeping token/chat-id connector settings.")
    .action(async (options: { yes: boolean; preserveOffset: boolean }) => {
      await main(async (workspaceRoot) => {
        if (!options.yes) {
          console.log([
            "Telegram gateway state reset preview",
            "No changes were made.",
            "Apply:",
            "  cosia gateway telegram reset-state --yes"
          ].join("\n"));
          return;
        }
        console.log(formatTelegramStateReset(await resetTelegramGatewayState(workspaceRoot, {
          preserveOffset: options.preserveOffset
        })));
      });
    });

  telegram
    .command("start")
    .option("--provider-profile <name>", "Temporary provider profile override for Telegram chat messages.")
    .option("--once", "Process one update batch and exit.", false)
    .description("Debug: start Telegram long polling directly. Normal use: cosia gateway start.")
    .action(async (options: { providerProfile?: string; once: boolean }) => {
      await main(async (workspaceRoot) => {
        await startTelegramGateway(workspaceRoot, {
          providerId: options.providerProfile,
          once: options.once,
          command: "cosia gateway telegram start"
        });
      });
    });

}
