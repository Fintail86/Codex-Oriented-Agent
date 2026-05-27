import { execFile } from "node:child_process";
import type { Command } from "commander";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager, formatAgentRecommendation } from "../src/runtime/agent_manager.js";
import { createCliProgram } from "../src/cli_program.js";
import { CapabilityPlanner, EnvironmentDiscovery, capabilityScanJson, normalizeCapabilityProposal, stableJsonStringify } from "../src/runtime/capability.js";
import { applyReset, formatResetResult, previewReset, repairDoctor } from "../src/runtime/doctor.js";
import { initProject } from "../src/runtime/init_project.js";
import { calculateMemoryScore, formatMemoryConflicts, MemoryManager, normalizeMemoryText } from "../src/runtime/memory_manager.js";
import { formatMvpChecklist } from "../src/runtime/mvp_checklist.js";
import { modelInstructionForRetry, parseModelOutput } from "../src/runtime/model/model_provider.js";
import { ProviderError } from "../src/runtime/model/provider_errors.js";
import { checkProvider, createProvider, listProviders, resolveProviderSelection } from "../src/runtime/model/provider_registry.js";
import { OpenAICompatibleProvider, type FetchLike } from "../src/runtime/model/providers/openai_compatible_provider.js";
import { formatPolicyAuditEvents, PolicyAuditLog } from "../src/runtime/policy_audit.js";
import { applyPendingApproval, cancelPendingApproval, formatPendingApprovals, getPendingApprovalSummary } from "../src/runtime/pending_approvals.js";
import { normalizePolicy, PolicyManager, policyConfigSchema } from "../src/runtime/policy_manager.js";
import { buildRuntimeConfigMigration, deepMerge, formatConfigCheck, formatConfigShow, runtimeLocalPath, runtimePrivatePath, secretsPrivatePath } from "../src/runtime/runtime_config.js";
import { argvPlanSlotNames, buildCliArgv } from "../src/runtime/cli_argv_planner.js";
import { translateCommandTags } from "../src/runtime/command_tag_translator.js";
import { runtimeCommandDefinitions } from "../src/runtime/runtime_command_catalog.js";
import { setCosiaCliExecutorForTests } from "../src/runtime/runtime_command_model_tools.js";
import { CodexAmendmentLedger } from "../src/runtime/codex_amendment.js";
import { buildPrompt, buildPromptBundle } from "../src/runtime/prompt_builder.js";
import { classifyMemoryCandidate, detectSecrets } from "../src/runtime/risk_classifier.js";
import { chunkTelegramMessage } from "../src/runtime/gateway_format.js";
import { handleGatewayActivity } from "../src/runtime/gateway_runtime.js";
import { gatewayProcessLockPath, sessionLockPath, withSessionLock } from "../src/runtime/gateway_locks.js";
import { formatGatewayStatus, gatewayStopRequestPath, restartGateway, startGateway, stopGateway, unlockStaleGateway, writeGatewayStopRequest } from "../src/runtime/gateway_supervisor.js";
import { pathExists } from "../src/runtime/fs_utils.js";
import { formatChatHelp, runChatRepl } from "../src/runtime/repl.js";
import { formatReviewInbox, ReviewInboxService } from "../src/runtime/review_inbox.js";
import { runSession } from "../src/runtime/runner.js";
import { SelfImprovementGovernor } from "../src/runtime/self_improvement.js";
import { formatLastTurnDebug, SessionManager } from "../src/runtime/session_manager.js";
import { assessShellRisk, buildShellApprovalRecord, ShellApprovalLedger } from "../src/runtime/shell_approval.js";
import { calculateSkillTriggerMatch, SkillManager } from "../src/runtime/skill_manager.js";
import { recommendStartSession, sessionFromChoice } from "../src/runtime/start_flow.js";
import { getStatusReport } from "../src/runtime/status_report.js";
import { classifyRuntimeBoundaryChange, classifyWritePathBoundary } from "../src/runtime/system_boundary.js";
import { codexTemplates } from "../src/runtime/templates.js";
import { RunJobLedger } from "../src/runtime/run_jobs.js";
import {
  checkTelegramGateway,
  clearTelegramWebhook,
  formatTelegramCheck,
  formatTelegramWebhookClear,
  formatTelegramWebhookStatus,
  getTelegramWebhookStatus,
  inspectTelegramGatewayState,
  loadTelegramGatewayState,
  processTelegramUpdate,
  repairTelegramGatewayState,
  resetTelegramGatewayState,
  saveTelegramGatewayState,
  startTelegramGateway,
  telegramActivityFromCallback,
  telegramActivityFromMessage
} from "../src/runtime/telegram_gateway.js";
import { loadPrivateSecrets, savePrivateSecrets } from "../src/runtime/private_config.js";
import { formatSupportedProviders, oauthHandlerForProvider, validateProviderProfileAddOptions } from "../src/runtime/provider_onboarding.js";
import { addProviderProfile, listProviderProfileSummaries, missingProviderProfileHint, useProviderProfile } from "../src/runtime/provider_profiles.js";
import {
  addTelegramChatId,
  addTelegramMutationUserId,
  addTelegramUserId,
  enableTelegramConnector,
  removeTelegramMutationUserId,
  removeTelegramUserId,
  setTelegramGroupMode,
  setTelegramToken
} from "../src/runtime/telegram_connector_config.js";
import { ToolRegistry } from "../src/runtime/tool_registry.js";
import {
  ToolAcquisitionManager,
  candidateContentHash,
  formatToolCandidate,
  formatToolDraftResult,
  listEffectiveActiveModelToolIds,
  type ToolCandidateRecord
} from "../src/runtime/tool_acquisition.js";
import {
  ToolGrowthManager,
  formatToolGrowthReview,
  formatToolGrowthRoutine,
  formatToolGrowthStart
} from "../src/runtime/tool_growth.js";
import type { ModelProvider } from "../src/runtime/types.js";
import { findWorkspaceRoot, requireWorkspaceRoot } from "../src/runtime/workspace.js";

const tempRoots: string[] = [];
const execFileAsync = promisify(execFile);
const TELEGRAM_FIXTURE_PRIVATE_ID = "111111111";
const TELEGRAM_FIXTURE_BOT_USERNAME = "CosiaFixtureBot";

function captureWritable(): { stream: Writable; read: () => string } {
  let text = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        text += chunk.toString();
        callback();
      }
    }),
    read: () => text
  };
}

function collectCommanderCommandPaths(command: Command, prefix: string[] = []): string[][] {
  const paths: string[][] = [];
  for (const child of command.commands) {
    const path = [...prefix, child.name()];
    paths.push(path);
    paths.push(...collectCommanderCommandPaths(child, path));
  }
  return paths;
}

afterEach(async () => {
  setCosiaCliExecutorForTests(undefined);
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cosia-"));
  tempRoots.push(root);
  return root;
}

async function initializedWorkspace(): Promise<string> {
  const root = await workspace();
  await initProject(root);
  return root;
}

async function waitForCondition(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await predicate()).toBe(true);
}

async function writeRuntimeLocal(root: string, value: unknown): Promise<void> {
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(runtimePrivatePath(root), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function configuredOpenAIProvider(fetchImpl: FetchLike, overrides: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}): OpenAICompatibleProvider {
  process.env.COSIA_TEST_KEY = process.env.COSIA_TEST_KEY ?? "test-key";
  return new OpenAICompatibleProvider({
    enabled: true,
    baseUrl: "https://example.invalid",
    model: "test-model",
    apiKeyEnv: "COSIA_TEST_KEY",
    endpointPath: "/chat/completions",
    timeoutMs: 1000,
    structuredRetryCount: 1,
    maxPromptChars: 60000,
    fetchImpl,
    ...overrides
  });
}

export {
  execFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
  join,
  tmpdir,
  DatabaseSync,
  PassThrough,
  Writable,
  promisify,
  describe,
  expect,
  it,
  AgentManager,
  formatAgentRecommendation,
  createCliProgram,
  CapabilityPlanner,
  EnvironmentDiscovery,
  capabilityScanJson,
  normalizeCapabilityProposal,
  stableJsonStringify,
  applyReset,
  formatResetResult,
  previewReset,
  repairDoctor,
  initProject,
  calculateMemoryScore,
  formatMemoryConflicts,
  MemoryManager,
  normalizeMemoryText,
  formatMvpChecklist,
  modelInstructionForRetry,
  parseModelOutput,
  ProviderError,
  checkProvider,
  createProvider,
  listProviders,
  resolveProviderSelection,
  OpenAICompatibleProvider,
  formatPolicyAuditEvents,
  PolicyAuditLog,
  applyPendingApproval,
  cancelPendingApproval,
  formatPendingApprovals,
  getPendingApprovalSummary,
  normalizePolicy,
  PolicyManager,
  policyConfigSchema,
  buildRuntimeConfigMigration,
  deepMerge,
  formatConfigCheck,
  formatConfigShow,
  runtimeLocalPath,
  runtimePrivatePath,
  secretsPrivatePath,
  argvPlanSlotNames,
  buildCliArgv,
  translateCommandTags,
  runtimeCommandDefinitions,
  setCosiaCliExecutorForTests,
  CodexAmendmentLedger,
  buildPrompt,
  buildPromptBundle,
  classifyMemoryCandidate,
  detectSecrets,
  chunkTelegramMessage,
  handleGatewayActivity,
  gatewayProcessLockPath,
  sessionLockPath,
  withSessionLock,
  formatGatewayStatus,
  gatewayStopRequestPath,
  restartGateway,
  startGateway,
  stopGateway,
  unlockStaleGateway,
  writeGatewayStopRequest,
  pathExists,
  formatChatHelp,
  runChatRepl,
  formatReviewInbox,
  ReviewInboxService,
  runSession,
  SelfImprovementGovernor,
  formatLastTurnDebug,
  SessionManager,
  assessShellRisk,
  buildShellApprovalRecord,
  ShellApprovalLedger,
  calculateSkillTriggerMatch,
  SkillManager,
  recommendStartSession,
  sessionFromChoice,
  getStatusReport,
  classifyRuntimeBoundaryChange,
  classifyWritePathBoundary,
  codexTemplates,
  RunJobLedger,
  checkTelegramGateway,
  clearTelegramWebhook,
  formatTelegramCheck,
  formatTelegramWebhookClear,
  formatTelegramWebhookStatus,
  getTelegramWebhookStatus,
  inspectTelegramGatewayState,
  loadTelegramGatewayState,
  processTelegramUpdate,
  repairTelegramGatewayState,
  resetTelegramGatewayState,
  saveTelegramGatewayState,
  startTelegramGateway,
  telegramActivityFromCallback,
  telegramActivityFromMessage,
  loadPrivateSecrets,
  savePrivateSecrets,
  formatSupportedProviders,
  oauthHandlerForProvider,
  validateProviderProfileAddOptions,
  addProviderProfile,
  listProviderProfileSummaries,
  missingProviderProfileHint,
  useProviderProfile,
  addTelegramChatId,
  addTelegramMutationUserId,
  addTelegramUserId,
  enableTelegramConnector,
  removeTelegramMutationUserId,
  removeTelegramUserId,
  setTelegramGroupMode,
  setTelegramToken,
  ToolRegistry,
  ToolAcquisitionManager,
  candidateContentHash,
  formatToolCandidate,
  formatToolDraftResult,
  listEffectiveActiveModelToolIds,
  ToolGrowthManager,
  formatToolGrowthReview,
  formatToolGrowthRoutine,
  formatToolGrowthStart,
  findWorkspaceRoot,
  requireWorkspaceRoot,
  execFileAsync,
  TELEGRAM_FIXTURE_PRIVATE_ID,
  TELEGRAM_FIXTURE_BOT_USERNAME,
  captureWritable,
  collectCommanderCommandPaths,
  workspace,
  initializedWorkspace,
  waitForCondition,
  writeRuntimeLocal,
  normalizeText,
  jsonResponse,
  configuredOpenAIProvider
};

export type {
  Command,
  FetchLike,
  ToolCandidateRecord,
  ModelProvider
};
