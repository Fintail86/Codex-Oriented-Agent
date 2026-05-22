import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager, formatAgentRecommendation } from "../src/runtime/agent_manager.js";
import { applyReset, formatResetResult, previewReset, repairDoctor } from "../src/runtime/doctor.js";
import { initProject } from "../src/runtime/init_project.js";
import { calculateMemoryScore, formatMemoryConflicts, MemoryManager, normalizeMemoryText } from "../src/runtime/memory_manager.js";
import { formatMvpChecklist } from "../src/runtime/mvp_checklist.js";
import { modelInstructionForRetry, parseModelOutput } from "../src/runtime/model/model_provider.js";
import { ProviderError } from "../src/runtime/model/provider_errors.js";
import { checkProvider, createProvider, listProviders } from "../src/runtime/model/provider_registry.js";
import { OpenAICompatibleProvider, type FetchLike } from "../src/runtime/model/providers/openai_compatible_provider.js";
import { formatPolicyAuditEvents, PolicyAuditLog } from "../src/runtime/policy_audit.js";
import { normalizePolicy, PolicyManager, policyConfigSchema } from "../src/runtime/policy_manager.js";
import { buildRuntimeConfigMigration, deepMerge, formatConfigCheck, formatConfigShow, runtimeLocalPath } from "../src/runtime/runtime_config.js";
import { buildPrompt, buildPromptBundle } from "../src/runtime/prompt_builder.js";
import { classifyMemoryCandidate, detectSecrets } from "../src/runtime/risk_classifier.js";
import { chunkTelegramMessage } from "../src/runtime/gateway_format.js";
import { gatewayProcessLockPath, sessionLockPath, withSessionLock } from "../src/runtime/gateway_locks.js";
import { formatGatewayStatus, gatewayStopRequestPath, restartGateway, startGateway, stopGateway, unlockStaleGateway, writeGatewayStopRequest } from "../src/runtime/gateway_supervisor.js";
import { pathExists } from "../src/runtime/fs_utils.js";
import { interpretHashCommand, validateInterpreterResult } from "../src/runtime/command_interpreter.js";
import { parseHashCommand, retrieveCommandCandidates } from "../src/runtime/command_intent.js";
import { formatChatHelp, runChatRepl } from "../src/runtime/repl.js";
import { formatReviewInbox, ReviewInboxService } from "../src/runtime/review_inbox.js";
import { runSession } from "../src/runtime/runner.js";
import { SessionManager } from "../src/runtime/session_manager.js";
import { calculateSkillTriggerMatch, SkillManager } from "../src/runtime/skill_manager.js";
import { recommendStartSession, sessionFromChoice } from "../src/runtime/start_flow.js";
import { getStatusReport } from "../src/runtime/status_report.js";
import { codexTemplates } from "../src/runtime/templates.js";
import { checkTelegramGateway, loadTelegramGatewayState, processTelegramUpdate, saveTelegramGatewayState, startTelegramGateway } from "../src/runtime/telegram_gateway.js";
import { ToolRegistry } from "../src/runtime/tool_registry.js";
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
      "git_status",
      "git_diff",
      "git_log",
      "npm_test",
      "npm_typecheck"
    ]));
    expect(session.id).toMatch(/^session_\d{8}_001$/);
    expect(session.assignedAgentId).toBe("architect-agent");
    const sessionJson = JSON.parse(await readFile(join(root, "sessions", session.id, "session.json"), "utf8")) as Record<string, unknown>;
    expect(sessionJson.assignedAgentId).toBe("architect-agent");
    expect(sessionJson.agentId).toBeUndefined();
    expect(await readFile(join(root, "codex", "SECURITY.md"), "utf8")).toContain("SECURITY");
    const policyJson = await readFile(join(root, "codex", "POLICY.json"), "utf8");
    expect(policyJson).toContain("\"version\": \"0.27.3\"");
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
    expect(runtimeDefaults.tools.bundled.git_status.enabled).toBe(true);
    expect(runtimeDefaults.tools.bundled.npm_test.enabled).toBe(true);
    const cosiaAgent = await agents.loadAgent("cosia-agent");
    expect(cosiaAgent.identity.role).toContain("Default COSIA agent");
    const cosiaManifestPath = join(root, "agents", "cosia-agent", "manifest.json");
    const cosiaManifestJson = JSON.parse(await readFile(cosiaManifestPath, "utf8")) as { allowedTools: string[] };
    cosiaManifestJson.allowedTools = cosiaManifestJson.allowedTools.filter((tool) => tool !== "git_log");
    await writeFile(cosiaManifestPath, `${JSON.stringify(cosiaManifestJson, null, 2)}\n`, "utf8");
    expect((await agents.loadAgent("cosia-agent")).allowedTools).not.toContain("git_log");
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
    expect(prompt).toContain("npm_typecheck");

    const policy = await new PolicyManager(root).loadPolicy();
    policy.disabledPermissions = [...policy.disabledPermissions, "project_check"];
    const projectCheckDisabledPrompt = await buildPrompt({ workspaceRoot: root, agent, session, userPrompt: "Hello", policy });
    expect(projectCheckDisabledPrompt).not.toContain("npm_typecheck");
    expect(projectCheckDisabledPrompt).toContain("git_status");
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
  it("denies writes outside the workspace and denies overwrite without approval", async () => {
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
    expect(overwrite.ok).toBe(false);
    expect(overwrite.content).toContain("Overwrite denied");
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

  it("runs readonly git tools and blocks git diff paths outside the workspace", async () => {
    const root = await initializedWorkspace();
    await execFileAsync("git", ["init"], { cwd: root });
    await writeFile(join(root, "tracked.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
    await writeFile(join(root, "tracked.txt"), `base\n${"changed\n".repeat(2500)}TAIL\n`, "utf8");
    const registry = new ToolRegistry();

    const status = await registry.execute("git_status", {}, {
      workspaceRoot: root,
      allowedTools: ["git_status"]
    });
    expect(status.ok).toBe(true);
    expect(status.content).toContain("tracked.txt");

    const diff = await registry.execute("git_diff", { path: "tracked.txt" }, {
      workspaceRoot: root,
      allowedTools: ["git_diff"]
    });
    expect(diff.ok).toBe(true);
    expect(diff.content).toContain("[COSIA: tool output truncated");
    expect(diff.content).toContain("TAIL");

    const outside = await registry.execute("git_diff", { path: "../outside.txt" }, {
      workspaceRoot: root,
      allowedTools: ["git_diff"]
    });
    expect(outside.ok).toBe(false);
    expect(outside.content).toContain("outside workspace");

    const log = await registry.execute("git_log", { maxCount: 99 }, {
      workspaceRoot: root,
      allowedTools: ["git_log"]
    });
    expect(log.ok).toBe(false);
    expect(log.content).toContain("Exit code");
  });

  it("gates bundled git tools through runtime config, agent allowlists, and policy permissions", async () => {
    const root = await initializedWorkspace();
    await execFileAsync("git", ["init"], { cwd: root });
    const registry = new ToolRegistry();

    await writeRuntimeLocal(root, {
      tools: {
        bundled: {
          git_status: {
            enabled: false
          }
        }
      }
    });
    const disabledAudit: unknown[] = [];
    const disabled = await registry.execute("git_status", {}, {
      workspaceRoot: root,
      allowedTools: ["git_status"],
      policyAudit: async (event) => {
        disabledAudit.push(event);
      }
    });
    expect(disabled.ok).toBe(false);
    expect(disabled.content).toContain("disabled by runtime config");
    expect(JSON.stringify(disabledAudit)).toContain("tool.config_disabled");

    const notAllowed = await registry.execute("git_status", {}, {
      workspaceRoot: root,
      allowedTools: []
    });
    expect(notAllowed.ok).toBe(false);
    expect(notAllowed.content).toContain("not allowed for this agent");

    await writeRuntimeLocal(root, {
      tools: {
        bundled: {
          git_status: {
            enabled: true
          }
        }
      }
    });
    const policyPath = join(root, "codex", "POLICY.json");
    const rawPolicy = JSON.parse(await readFile(policyPath, "utf8")) as { disabledPermissions: string[] };
    rawPolicy.disabledPermissions = [...rawPolicy.disabledPermissions, "read_only"];
    await writeFile(policyPath, `${JSON.stringify(rawPolicy, null, 2)}\n`, "utf8");
    const permissionDisabled = await registry.execute("git_status", {}, {
      workspaceRoot: root,
      allowedTools: ["git_status"]
    });
    expect(permissionDisabled.ok).toBe(false);
    expect(permissionDisabled.content).toContain("Permission is disabled by policy: read_only");
  });

  it("runs npm scripts only when package scripts exist", async () => {
    const root = await initializedWorkspace();
    const registry = new ToolRegistry();
    const missing = await registry.execute("npm_typecheck", {}, {
      workspaceRoot: root,
      allowedTools: ["npm_typecheck"]
    });
    expect(missing.ok).toBe(false);
    expect(missing.content).toContain("script not found");

    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: {
        typecheck: "node --version"
      }
    }), "utf8");
    const result = await registry.execute("npm_typecheck", {}, {
      workspaceRoot: root,
      allowedTools: ["npm_typecheck"]
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("v");

    const policyPath = join(root, "codex", "POLICY.json");
    const rawPolicy = JSON.parse(await readFile(policyPath, "utf8")) as { disabledPermissions: string[] };
    rawPolicy.disabledPermissions = [...rawPolicy.disabledPermissions, "project_check"];
    await writeFile(policyPath, `${JSON.stringify(rawPolicy, null, 2)}\n`, "utf8");
    const permissionDisabled = await registry.execute("npm_typecheck", {}, {
      workspaceRoot: root,
      allowedTools: ["npm_typecheck"]
    });
    expect(permissionDisabled.ok).toBe(false);
    expect(permissionDisabled.content).toContain("Permission is disabled by policy: project_check");
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
    expect(await formatConfigShow(root, rawPolicy)).toContain("tools.bundled.git_status.enabled");
  });

  it("validates bundled tool runtime config and migrates legacy bundled policy tools", async () => {
    const root = await initializedWorkspace();
    await writeRuntimeLocal(root, {
      tools: {
        bundled: {
          git_status: {
            enabled: "false"
          }
        }
      }
    });
    expect(await formatConfigCheck(root)).toContain("Schema: failed");

    await writeRuntimeLocal(root, {
      tools: {
        bundled: {
          git_status: {
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
    expect(migration.runtimeLocal.tools?.bundled?.git_status?.enabled).toBe(false);
    expect(migration.runtimeLocal.tools?.bundled?.npm_test?.enabled).toBe(false);
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

  it("discovers a COSIA workspace from nested directories and fails clearly outside one", async () => {
    const root = await initializedWorkspace();
    const nested = join(root, "tmp", "nested");
    await mkdir(nested, { recursive: true });

    expect(await findWorkspaceRoot(nested)).toBe(root);

    const outside = await workspace();
    await expect(requireWorkspaceRoot(outside)).rejects.toThrow("COSIA workspace not found");
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

    await runSession(root, {
      sessionId: session.id,
      prompt: "[MOCK_SKILL_CANDIDATE] propose a git skill",
      providerId: "mock"
    });

    const skills = new SkillManager(root);
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
    expect(listed.some((provider) => provider.id === "codex-cli" && provider.isDefault)).toBe(true);
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
      choices: [{ message: { content: '{"type":"tool_call","tool":"git_status","args":{}}' } }]
    }));
    expect((await toolProvider.complete({ prompt: "status", sessionId: "s" })).step).toMatchObject({ type: "tool_call", tool: "git_status" });
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

    const skillCandidates = new SkillManager(root).listCandidates();
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
    expect(overwriteAudit.some((event) => event.eventType === "approval_required" && event.ruleId === "write.overwrite_approval_required")).toBe(true);
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

  it("runs new readonly tools through the model tool loop and policy audit", async () => {
    const root = await initializedWorkspace();
    await execFileAsync("git", ["init"], { cwd: root });
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Inspect git status");

    const content = await runSession(root, {
      sessionId: session.id,
      prompt: "[MOCK_TOOL_CALL:git_status]",
      providerId: "mock"
    });

    expect(content).toContain(session.id);
    const audit = await new PolicyAuditLog(root).list(session.id, 10);
    expect(audit.some((event) => event.eventType === "tool_decision" && event.allowed && event.tool === "git_status")).toBe(true);
  });
});

describe("status and listing", () => {
  it("reports status for empty and initialized workspaces", async () => {
    const empty = await workspace();
    const emptyReport = await getStatusReport(empty, "mock");
    expect(emptyReport.version).toBe("0.27.4");
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
    expect(output.read()).toContain("COSIA chat commands");
    expect(output.read()).toContain(`Session: ${session.id}`);
    expect(output.read()).toContain("# SESSION SUMMARY");
    expect(output.read()).toContain("Context:");
    expect(errorOutput.read()).toContain("Type /help for commands");
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

  it("parses hash natural command arguments deterministically", () => {
    expect(parseHashCommand("#show status")).toMatchObject({
      type: "matched",
      commandId: "status.show"
    });
    expect(parseHashCommand("#show review")).toMatchObject({
      type: "matched",
      commandId: "review.list"
    });
    expect(parseHashCommand("#리뷰 3번 디스카드해 이유는 중복")).toMatchObject({
      type: "matched",
      commandId: "review.discard",
      args: { target: "3", reason: "중복" }
    });
    expect(parseHashCommand("#리뷰 b5038e0e 디스카드해 이유는 중복")).toMatchObject({
      type: "matched",
      commandId: "review.discard",
      args: { target: "b5038e0e", reason: "중복" }
    });
    expect(parseHashCommand("#메모리 검색 required provider")).toMatchObject({
      type: "matched",
      commandId: "memory.search",
      args: { query: "required provider" }
    });
    expect(parseHashCommand("#memory search required provider")).toMatchObject({
      type: "matched",
      commandId: "memory.search",
      args: { query: "required provider" }
    });
    expect(parseHashCommand("#컨플릭트 메모리 전부 디스카드해")).toMatchObject({
      type: "needs_input",
      commandId: "review.discard_conflicts"
    });
    expect(parseHashCommand("#컨플릭트 메모리 전부 디스카드해 사유는 테스트 중복")).toMatchObject({
      type: "matched",
      commandId: "review.discard_conflicts",
      args: { reason: "테스트 중복" }
    });
    expect(parseHashCommand("#리뷰 3번 디스카드해 사유는 중복")).toMatchObject({
      type: "matched",
      commandId: "review.discard",
      args: { target: "3", reason: "중복" }
    });
    expect(parseHashCommand("#discard all conflicting memories because duplicate")).toMatchObject({
      type: "matched",
      commandId: "review.discard_conflicts",
      args: { reason: "duplicate" }
    });
    expect(parseHashCommand("#메모리 정리")).toMatchObject({
      type: "ambiguous"
    });
  });

  it("retrieves command candidates and validates LLM command interpreter output", async () => {
    const root = await initializedWorkspace();
    const policy = await new PolicyManager(root).loadPolicy();
    const candidates = retrieveCommandCandidates("#please discard duplicate conflicting memories because duplicate");
    expect(candidates.map((candidate) => candidate.commandId)).toContain("review.discard_conflicts");

    let capturedPrompt = "";
    const interpreted = await interpretHashCommand({
      input: "#please discard duplicate conflicting memories because duplicate",
      candidates,
      workspaceRoot: root,
      providerId: "mock",
      policy,
      sessionId: "session-test",
      completePrompt: async (prompt) => {
        capturedPrompt = prompt;
        return JSON.stringify({
          type: "matched",
          commandId: "review.discard_conflicts",
          confidence: "high",
          args: { reason: "duplicate" }
        });
      }
    });

    expect(interpreted).toMatchObject({
      type: "matched",
      commandId: "review.discard_conflicts",
      args: { reason: "duplicate" }
    });
    expect(capturedPrompt).toContain("Return ONLY raw JSON.");
    expect(capturedPrompt).toContain("Do not wrap in ```json.");
    expect(capturedPrompt).toContain("review.discard_conflicts");
    expect(capturedPrompt).not.toContain("doctor.reset");

    expect(validateInterpreterResult(JSON.stringify({
      type: "matched",
      commandId: "doctor.reset",
      confidence: "high",
      args: {}
    }), candidates)).toMatchObject({
      type: "ambiguous"
    });
  });

  it("uses user command trigger overrides before built-in Korean triggers", async () => {
    const root = await initializedWorkspace();
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "command_triggers.ko.json"), JSON.stringify({
      "status.show": ["상태 커스텀"],
      "review.list": ["상태"]
    }), "utf8");

    expect(retrieveCommandCandidates("#상태 커스텀", 8, root)[0].commandId).toBe("status.show");
    expect(retrieveCommandCandidates("#상태", 8, root)[0].commandId).toBe("review.list");
  });

  it("retries malformed command interpreter JSON once", async () => {
    const root = await initializedWorkspace();
    const policy = await new PolicyManager(root).loadPolicy();
    const candidates = retrieveCommandCandidates("#please show current workspace status");
    let attempts = 0;
    let retryPrompt = "";
    const interpreted = await interpretHashCommand({
      input: "#please show current workspace status",
      candidates,
      workspaceRoot: root,
      providerId: "mock",
      policy,
      sessionId: "session-test",
      completePrompt: async (prompt) => {
        attempts += 1;
        retryPrompt = prompt;
        return attempts === 1
          ? "not-json"
          : JSON.stringify({
              type: "matched",
              commandId: "status.show",
              confidence: "high",
              args: {}
            });
      }
    });

    expect(attempts).toBe(2);
    expect(retryPrompt).toContain("You returned invalid JSON.");
    expect(retryPrompt).toContain("not-json");
    expect(interpreted).toMatchObject({
      type: "matched",
      commandId: "status.show"
    });
  });

  it("handles hash natural commands with pending preview, cancellation, expiration, and escape", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Hash command REPL test");
    const memory = new MemoryManager(root);
    memory.addMemory({
      tier: "core",
      kind: "note",
      content: "Hash command conflict content."
    });
    const [candidate] = await memory.appendCandidates([{
      tier: "core",
      kind: "note",
      content: "hash command conflict content",
      importance: 3,
      confidence: 0.8
    }], session, "run-hash", "cosia-agent");
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
        "#상태 보여줘",
        "#show status",
        "#리뷰 보여줘",
        "#memory search required provider",
        "#컨플릭트 메모리 전부 디스카드해 이유는 중복",
        "#대기중인 작업 보여줘",
        "#취소",
        "#컨플릭트 메모리 전부 디스카드해 이유는 중복"
      ]) {
        input.write(`${line}\n`);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await waitForOutput("Pending command cancelled.");
      await waitForOutputCount("Run #적용 to proceed", 2);
      fakeNow += 5 * 60 * 1000 + 1;
      input.write("#적용\n");
      await waitForOutput("[EXPIRED]");
      for (const line of [
        "#컨플릭트 메모리 전부 디스카드해 이유는 중복",
        "#적용",
        "\\#상태 보여줘",
        "/exit"
      ]) {
        input.write(`${line}\n`);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      input.end();
    };
    await feedInput();
    const result = await resultPromise;

    expect(result).toMatchObject({ turns: 1, endedBy: "exit" });
    const text = output.read();
    expect(text).toContain("COSIA");
    expect(text).toContain("Review Inbox");
    expect(text).toContain("[PREVIEW]");
    expect(text).toContain("Pending command: review.discard_conflicts");
    expect(text).toContain("[EXPIRED]");
    expect(text).toContain("[SUCCESS] Discarded 1 memory candidates.");
    expect(text).toContain("Mock response");
    expect((await new MemoryManager(root).getCandidate(candidate.id)).record?.status).toBe("discarded");
    expect(formatChatHelp()).toContain("Natural commands");
  });

  it("prints MVP acceptance checklist and documents expected outcomes", async () => {
    const checklist = formatMvpChecklist();
    expect(checklist).toContain("COSIA MVP Acceptance Checklist");
    expect(checklist).toContain("[ ] 1. Environment and build");
    expect(checklist).toContain("mock: regression only");
    expect(checklist).toContain("codex-cli: required MVP acceptance provider");
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
      defaultProvider: "codex-cli"
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

  it("processes Telegram updates with allowlist checks, state, chunks, and hash commands", async () => {
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
          defaultProvider: "mock",
          messageChunkChars: 120
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
        chat: { id: 999 },
        text: "/status"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("Unauthorized");
    expect(state.chats["999"]).toBeUndefined();

    state = await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 2,
      message: {
        chat: { id: 123 },
        text: "#상태 보여줘"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(state.chats["123"]).toBeDefined();
    expect(sent.some((message) => message.chatId === "123" && message.text.includes("COSIA"))).toBe(true);

    const sentBeforeBatch = sent.length;
    state = await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 3,
      message: {
        chat: { id: 123 },
        text: "/help\n/sessions\n#상태 보여줘"
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
              text: "/status"
            }
          }]
        });
      }
      if (String(url).endsWith("/sendMessage")) {
        return jsonResponse({ ok: true, result: { message_id: 1 } });
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
    const state = await loadTelegramGatewayState(root);
    expect(state.nextOffset).toBe(12);
    expect(state.chats["123"]).toBeDefined();
    expect(await pathExists(join(root, ".cosia-gateway", "telegram", "process.lock"))).toBe(false);
    expect(await pathExists(gatewayProcessLockPath(root))).toBe(false);
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
      requested: false
    });
    expect(await pathExists(gatewayStopRequestPath(root))).toBe(false);
    expect(await unlockStaleGateway(root, { staleOnly: true })).toMatchObject({
      removed: true
    });
    expect(await pathExists(gatewayProcessLockPath(root))).toBe(false);
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
