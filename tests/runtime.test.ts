import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../src/runtime/agent_manager.js";
import { initProject } from "../src/runtime/init_project.js";
import { calculateMemoryScore, formatMemoryConflicts, MemoryManager, normalizeMemoryText } from "../src/runtime/memory_manager.js";
import { parseModelOutput } from "../src/runtime/model/model_provider.js";
import { formatPolicyAuditEvents, PolicyAuditLog } from "../src/runtime/policy_audit.js";
import { PolicyManager } from "../src/runtime/policy_manager.js";
import { buildPrompt, buildPromptBundle } from "../src/runtime/prompt_builder.js";
import { classifyMemoryCandidate, detectSecrets } from "../src/runtime/risk_classifier.js";
import { runSession } from "../src/runtime/runner.js";
import { SessionManager } from "../src/runtime/session_manager.js";
import { getStatusReport } from "../src/runtime/status_report.js";
import { ToolRegistry } from "../src/runtime/tool_registry.js";
import type { ModelProvider } from "../src/runtime/types.js";
import { findWorkspaceRoot, requireWorkspaceRoot } from "../src/runtime/workspace.js";

const tempRoots: string[] = [];

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

describe("runtime setup", () => {
  it("creates Codex templates, an agent, and a session", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    const manifest = await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Design the runtime MVP");

    expect(manifest.allowedTools).toEqual(["read_file", "write_file", "search_files"]);
    expect(session.id).toMatch(/^session_\d{8}_architect-agent_001$/);
    expect(await readFile(join(root, "codex", "SECURITY.md"), "utf8")).toContain("SECURITY");
    expect(await readFile(join(root, "codex", "POLICY.json"), "utf8")).toContain("\"version\": \"0.6.1\"");
    expect(await readFile(join(root, "sessions", session.id, "POLICY_AUDIT.jsonl"), "utf8")).toBe("");
    expect(await readFile(join(root, "sessions", session.id, "SESSION_SUMMARY.md"), "utf8")).toContain("SESSION SUMMARY");
    expect(await readFile(join(root, "sessions", session.id, "PROMPT_MANIFEST.jsonl"), "utf8")).toBe("");
    expect(await readFile(join(root, "sessions", session.id, "CONTEXT_ARCHIVE.md"), "utf8")).toContain("CONTEXT ARCHIVE");
    expect(await readFile(join(root, "memory", "auto_promotions.jsonl"), "utf8")).toBe("");
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
      "agents/architect-agent/AGENT.md",
      "agents/architect-agent/LOCAL_RULES.md",
      "sessions/",
      "CURRENT USER REQUEST"
    ];
    let cursor = -1;
    for (const marker of order) {
      const next = prompt.indexOf(marker, cursor + 1);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
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

    await manager.syncMarkdown();
    const synced = await manager.checkPolicy();
    expect(synced.ok).toBe(true);

    await writeFile(join(root, "codex", "POLICY.json"), "{}", "utf8");
    const invalid = await manager.checkPolicy();
    expect(invalid.jsonValid).toBe(false);
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
    expect(ref).toContain("project/decision");
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
    expect(pending[0].record?.sourceAgentId).toBe(session.agentId);

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
      scope: "project" as const,
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
      prompt: "[MOCK_CANDIDATE] auto promote safe memory",
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
});

describe("model parsing and run loop", () => {
  it("parses final and tool_call AgentStep JSON", () => {
    expect(parseModelOutput('{"type":"final","content":"done","memoryCandidates":[]}').step.type).toBe("final");
    expect(parseModelOutput('```json\n{"type":"tool_call","tool":"read_file","args":{"path":"README.md"}}\n```').step.type).toBe("tool_call");
    expect(() => parseModelOutput('{"type":"final"}')).toThrow();
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
    let overwriteCalls = 0;
    const overwriteProvider: ModelProvider = {
      id: "test",
      checkAuth: async () => ({ ok: true, message: "ok" }),
      complete: async () => {
        overwriteCalls += 1;
        if (overwriteCalls === 1) {
          return parseModelOutput('{"type":"tool_call","tool":"write_file","args":{"path":"codex/RULES.md","content":"secret token sk-testsecret123456"}}');
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
});

describe("status and listing", () => {
  it("reports status for empty and initialized workspaces", async () => {
    const empty = await workspace();
    const emptyReport = await getStatusReport(empty, "mock");
    expect(emptyReport.version).toBe("0.6.1");
    expect(emptyReport.agentsCount).toBe(0);
    expect(emptyReport.sessionsCount).toBe(0);
    expect(emptyReport.providerOk).toBe(true);

    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    await sessions.createSession("architect-agent", "List sessions");
    const memory = new MemoryManager(root);
    memory.addMemory({
      scope: "project",
      content: "COSIA status can count memories.",
      kind: "note"
    });

    const report = await getStatusReport(root, "mock");
    expect(report.agentsCount).toBe(1);
    expect(report.sessionsCount).toBe(1);
    expect(report.memoriesCount).toBe(1);
    expect(await sessions.listSessions()).toHaveLength(1);
    expect(memory.listMemories()).toHaveLength(1);
  });
});
