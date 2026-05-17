import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../src/runtime/agent_manager.js";
import { initProject } from "../src/runtime/init_project.js";
import { MemoryManager } from "../src/runtime/memory_manager.js";
import { parseModelOutput } from "../src/runtime/model/model_provider.js";
import { PolicyAuditLog } from "../src/runtime/policy_audit.js";
import { PolicyManager } from "../src/runtime/policy_manager.js";
import { buildPrompt } from "../src/runtime/prompt_builder.js";
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
    expect(await readFile(join(root, "codex", "POLICY.json"), "utf8")).toContain("\"version\": \"0.3.0\"");
    expect(await readFile(join(root, "sessions", session.id, "POLICY_AUDIT.jsonl"), "utf8")).toBe("");
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
});

describe("status and listing", () => {
  it("reports status for empty and initialized workspaces", async () => {
    const empty = await workspace();
    const emptyReport = await getStatusReport(empty, "mock");
    expect(emptyReport.version).toBe("0.3.0");
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
