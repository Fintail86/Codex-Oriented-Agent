import {
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
  runtimeCommandDefinitions,
  setCosiaCliExecutorForTests,
  CodexAmendmentLedger,
  buildPrompt,
  buildPromptBundle,
  classifyMemoryCandidate,
  detectSecrets,
  chunkTelegramMessage,
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
} from "./runtime_test_context.js";

import type {
  Command,
  FetchLike,
  ToolCandidateRecord,
  ModelProvider
} from "./runtime_test_context.js";

describe("memory", () => {
  it("rejects unsupported legacy memory schemas with reset guidance", async () => {
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
    expect(() => memory.ensureSchema()).toThrow("Unsupported legacy memory database schema");
  });

  it("stores, searches, and writes reference memory", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Design runtime memory");
    const memory = new MemoryManager(root);

    memory.addMemory({
      tier: "core",
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
      tier: "core",
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
      tier: "core",
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
        tier: "core",
        kind: "decision",
        content: "COSIA v0.2 reviews memory candidates before promotion.",
        importance: 4,
        confidence: 0.9
      },
      {
        tier: "session",
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

  it("ignores legacy JSONL candidate and promotion queues", async () => {
    const root = await initializedWorkspace();
    const validCandidate = {
      id: "candidate-jsonl-001",
      status: "pending" as const,
      tier: "core" as const,
      kind: "note",
      content: "Migrated candidate memory",
      importance: 3,
      confidence: 0.8,
      sourceSessionId: "session-jsonl",
      sourceAgentId: "architect-agent",
      createdAt: "2026-05-20T00:00:00.000Z"
    };
    const legacyCandidate = {
      tier: "core",
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
    expect(candidates).toHaveLength(0);
    expect(memory.listPromotions(true)).toHaveLength(0);
    expect(memory.exportCandidatesJsonl()).not.toContain(validCandidate.id);
    expect(memory.exportPromotionsJsonl()).not.toContain(validPromotion.id);
    await expect(readFile(join(root, "memory", "memory_candidates.jsonl.bak"), "utf8")).rejects.toThrow();
    await expect(readFile(join(root, "memory", "queue_migration_report.json"), "utf8")).rejects.toThrow();
  });

  it("blocks conflicting candidate promotion and supports replace resolution", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Resolve memory conflicts");
    const memory = new MemoryManager(root);
    const existing = memory.addMemory({
      tier: "core",
      kind: "decision",
      content: "COSIA v0.4 improves memory ranking.",
      importance: 5,
      confidence: 0.9
    });

    await memory.appendCandidates([{
      tier: "core",
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
      tier: "core",
      kind: "note",
      content: "Memory intelligence ranks durable context.",
      importance: 3,
      confidence: 0.7
    });

    await memory.appendCandidates([
      {
        tier: "core",
        kind: "note",
        content: "Memory intelligence ranks durable context",
        importance: 3,
        confidence: 0.7
      },
      {
        tier: "core",
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
      tier: "session",
      ownerId: session.id,
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
