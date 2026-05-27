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
  normalizeGatewayTurn,
  appendGatewayDurableTurnEvent,
  createGatewayTurnId,
  loadPendingGatewayDurableTurns,
  gatewayTurnQueuePath,
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
} from "./runtime_test_context.js";

import type {
  Command,
  FetchLike,
  ToolCandidateRecord,
  ModelProvider
} from "./runtime_test_context.js";

describe("status and listing", () => {
  it("reports status for empty and initialized workspaces", async () => {
    const empty = await workspace();
    const emptyReport = await getStatusReport(empty, "mock");
    expect(emptyReport.version).toBe("0.74.0");
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
      tier: "core",
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

  it("translates multilingual command words into canonical runtime command tags", () => {
    expect(translateCommandTags("메모리 승격 대상 있어?").tags).toEqual(expect.arrayContaining(["memory", "candidate"]));
    expect(translateCommandTags("메모리가 상태가 어때?").tags).toEqual(expect.arrayContaining(["memory", "status"]));
    expect(translateCommandTags("권한으로 확인").tags).toEqual(expect.arrayContaining(["auth", "check"]));
    expect(translateCommandTags("게이트웨이 권한 확인").tags).toEqual(expect.arrayContaining(["gateway", "auth", "check"]));
    expect(translateCommandTags("런타임 버전 뭐야?").tags).toEqual(expect.arrayContaining(["runtime", "version"]));
    expect(translateCommandTags("provider status").tags).toEqual(expect.arrayContaining(["provider", "status"]));
    expect(translateCommandTags("memory 상태").tags).toEqual(expect.arrayContaining(["memory", "status"]));

    const weakStatus = translateCommandTags("살아?");
    expect(weakStatus.tags).toEqual(["status"]);
    expect(weakStatus.matches.every((match) => match.weight <= 0.35)).toBe(true);

    const gatewayStatus = translateCommandTags("게이트웨이 살아?");
    expect(gatewayStatus.tags).toEqual(expect.arrayContaining(["gateway", "status"]));
    expect(gatewayStatus.matches.some((match) => match.tag === "gateway" && match.weight === 1)).toBe(true);
    expect(gatewayStatus.matches.some((match) => match.tag === "status" && match.weight <= 0.35)).toBe(true);
  });

  it("exposes a model-facing COSIA command lookup tool without executing commands", async () => {
    const root = await initializedWorkspace();

    const result = await new ToolRegistry().execute("cosia_cli_command_lookup", {
      input: "메모리 승격 대상",
      limit: 5
    }, {
      workspaceRoot: root,
      allowedTools: ["cosia_cli_command_lookup"],
      sourceChannel: "cli"
    });

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.content) as {
      status: string;
      detectedTags: string[];
      candidates: Array<{
        commandId: string;
        cliDisplay: string;
        modelCallable: boolean;
        modelExecutionMode: string;
        tags: string[];
        matchReason: string;
        modelToolHint?: { toolId: string; args?: Record<string, unknown> };
      }>;
      tagMatches: Array<{ alias: string; tag: string; locale: string; weight: number }>;
    };
    expect(parsed.status).toBe("ok");
    expect(parsed.detectedTags).toEqual(expect.arrayContaining(["memory", "candidate"]));
    expect(parsed.detectedTags.some((tag) => /[가-힣]/.test(tag))).toBe(false);
    expect(parsed.tagMatches.some((match) => match.alias === "메모리" && match.tag === "memory")).toBe(true);
    const review = parsed.candidates.find((candidate) => candidate.commandId === "review.memory");
    expect(review).toMatchObject({
      cliDisplay: "cosia review --memory",
      modelCallable: true,
      modelExecutionMode: "execute_read_only",
      modelToolHint: {
        toolId: "review_inbox_read"
      }
    });

    const approval = await new ToolRegistry().execute("cosia_cli_command_lookup", {
      input: "셋다 승인할께",
      limit: 5
    }, {
      workspaceRoot: root,
      allowedTools: ["cosia_cli_command_lookup"],
      sourceChannel: "cli"
    });
    const approvalParsed = JSON.parse(approval.content) as {
      detectedTags: string[];
      candidates: Array<{ commandId: string; cliDisplay: string; safety: string }>;
    };
    expect(approvalParsed.detectedTags).toContain("approve");
    expect(approvalParsed.candidates[0]).toMatchObject({
      commandId: "memory.candidate.promote",
      cliDisplay: "cosia memory candidate promote <candidate-id>",
      safety: "mutation"
    });

    const privateMasterApproval = await new ToolRegistry().execute("cosia_cli_command_lookup", {
      input: "셋다 승인할께",
      limit: 5
    }, {
      workspaceRoot: root,
      allowedTools: ["cosia_cli_command_lookup"],
      sourceChannel: "gateway",
      gatewayActor: {
        connector: "telegram",
        chatId: TELEGRAM_FIXTURE_PRIVATE_ID,
        chatType: "private",
        userId: TELEGRAM_FIXTURE_PRIVATE_ID
      },
      gatewayRole: "master"
    });
    const privateMasterParsed = JSON.parse(privateMasterApproval.content) as {
      candidates: Array<{ commandId: string; privateMasterCliOverrideAvailable: boolean }>;
    };
    expect(privateMasterParsed.candidates[0]).toMatchObject({
      commandId: "memory.candidate.promote",
      privateMasterCliOverrideAvailable: true
    });

    const version = await new ToolRegistry().execute("cosia_cli_command_lookup", {
      input: "런타임 버전 뭐야?",
      limit: 5
    }, {
      workspaceRoot: root,
      allowedTools: ["cosia_cli_command_lookup"],
      sourceChannel: "cli"
    });
    const versionParsed = JSON.parse(version.content) as {
      detectedTags: string[];
      candidates: Array<{ commandId: string }>;
    };
    expect(versionParsed.detectedTags).toEqual(expect.arrayContaining(["runtime", "version"]));
    expect(versionParsed.candidates[0]).toMatchObject({ commandId: "status.show" });
  });

  it("catalogs representative CLI commands with typed argv plans", () => {
    const ids = new Set(runtimeCommandDefinitions.map((definition) => definition.commandId));
    for (const commandId of [
      "status.show",
      "provider.profile.check",
      "gateway.auth.set_master",
      "gateway.telegram.check",
      "review.list",
      "memory.candidate.promote",
      "memory.search",
      "tool.grow.review",
      "codex.amendment.apply"
    ]) {
      expect(ids.has(commandId)).toBe(true);
    }
    for (const definition of runtimeCommandDefinitions) {
      expect(definition.cliDisplay).toMatch(/^cosia |^\//);
      expect(definition).not.toHaveProperty("argvTemplate");
      expect(Array.isArray(definition.commandPath)).toBe(true);
      expect(Array.isArray(definition.argvPlan)).toBe(true);
      for (const token of definition.argvPlan) {
        expect(["literal", "positional", "option", "booleanFlag"]).toContain(token.kind);
      }
      const declaredArgs = new Set([
        ...(definition.argsSchema.required ?? []),
        ...(definition.argsSchema.optional ?? [])
      ]);
      for (const slotName of argvPlanSlotNames(definition)) {
        expect(declaredArgs.has(slotName)).toBe(true);
      }
      expect((definition.tags ?? []).length).toBeGreaterThan(0);
      expect((definition.tags ?? []).some((tag) => /[가-힣]/.test(tag))).toBe(false);
    }

    const catalogPaths = new Set(runtimeCommandDefinitions.map((definition) => definition.commandPath.join(" ")));
    for (const path of collectCommanderCommandPaths(createCliProgram())) {
      expect(catalogPaths.has(path.join(" "))).toBe(true);
    }
  });

  it("builds typed CLI argv plans without shell strings or ad-hoc templates", () => {
    const memorySearch = runtimeCommandDefinitions.find((definition) => definition.commandId === "memory.search");
    expect(memorySearch).toBeDefined();
    expect(buildCliArgv(memorySearch!, {
      query: "폭스",
      tier: "core",
      limit: 5,
      showScore: true
    })).toEqual(["memory", "search", "--query", "폭스", "--tier", "core", "--limit", "5", "--show-score"]);
    expect(buildCliArgv(memorySearch!, {
      query: "폭스",
      showScore: false
    })).toEqual(["memory", "search", "--query", "폭스"]);

    const gatewayAuthCheck = runtimeCommandDefinitions.find((definition) => definition.commandId === "gateway.auth.check");
    expect(gatewayAuthCheck).toBeDefined();
    expect(buildCliArgv(gatewayAuthCheck!, {
      connector: "telegram",
      chatId: "111111111",
      userId: "222222222"
    })).toEqual(["gateway", "auth", "check", "telegram", "--chat-id", "111111111", "--user-id", "222222222"]);
  });

  it("executes only allowlisted read-only runtime commands through fixed COSIA CLI argv", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Runtime command model surface");
    const seenArgv: string[][] = [];
    setCosiaCliExecutorForTests(async (argv) => {
      seenArgv.push(argv);
      return {
        exitCode: 0,
        stdout: "Review Inbox\nPending: 1 (1 memory, 0 skill)",
        stderr: ""
      };
    });

    const result = await new ToolRegistry().execute("cosia_runtime_command", {
      commandId: "review.memory",
      args: {}
    }, {
      workspaceRoot: root,
      allowedTools: ["cosia_runtime_command"],
      sessionId: session.id,
      agentId: "cosia-agent",
      sourceChannel: "cli"
    });

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.content) as { status: string; commandId: string; stdout: string; argv: string[] };
    expect(parsed).toMatchObject({ status: "ok", commandId: "review.memory" });
    expect(parsed.stdout).toContain("Review Inbox");
    expect(parsed.argv).toEqual(["review", "--memory"]);
    expect(seenArgv).toEqual([["review", "--memory"]]);
  });

  it("executes memory.search with the real CLI option shape", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Runtime command memory search");
    const seenArgv: string[][] = [];
    setCosiaCliExecutorForTests(async (argv) => {
      seenArgv.push(argv);
      return {
        exitCode: 0,
        stdout: "mem_123\t[core/note] score:1.00 tokens:폭스\t사용자는 자신을 폭스라고 부른다.",
        stderr: ""
      };
    });

    const result = await new ToolRegistry().execute("cosia_runtime_command", {
      commandId: "memory.search",
      args: {
        query: "폭스",
        tier: "core",
        limit: 5,
        showScore: true
      }
    }, {
      workspaceRoot: root,
      allowedTools: ["cosia_runtime_command"],
      sessionId: session.id,
      agentId: "cosia-agent",
      sourceChannel: "cli"
    });

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.content) as { status: string; commandId: string; stdout: string; argv: string[] };
    expect(parsed).toMatchObject({ status: "ok", commandId: "memory.search" });
    expect(parsed.stdout).toContain("mem_123");
    expect(parsed.argv).toEqual(["memory", "search", "--query", "폭스", "--tier", "core", "--limit", "5", "--show-score"]);
    expect(seenArgv).toEqual([["memory", "search", "--query", "폭스", "--tier", "core", "--limit", "5", "--show-score"]]);
  });

  it("returns needs_input for missing structured runtime command args", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Runtime command needs input");

    const result = await new ToolRegistry().execute("cosia_runtime_command", {
      commandId: "memory.search",
      args: {}
    }, {
      workspaceRoot: root,
      allowedTools: ["cosia_runtime_command"],
      sessionId: session.id,
      agentId: "cosia-agent",
      sourceChannel: "cli"
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({
      status: "needs_input",
      commandId: "memory.search",
      missingArgs: ["query"]
    });
  });

  it("blocks CLI strings and non-model-callable commands from the model-facing runtime command surface", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Runtime command blocks");
    const registry = new ToolRegistry();
    const ctx = {
      workspaceRoot: root,
      allowedTools: ["cosia_runtime_command"],
      sessionId: session.id,
      agentId: "cosia-agent",
      sourceChannel: "cli" as const
    };

    const cliString = await registry.execute("cosia_runtime_command", {
      commandId: "cosia review",
      args: {}
    }, ctx);
    expect(cliString.ok).toBe(false);
    expect(JSON.parse(cliString.content)).toMatchObject({
      status: "blocked",
      reason: "cli_string_not_allowed"
    });

    const shell = await registry.execute("cosia_runtime_command", {
      commandId: "gateway.auth.set_master",
      args: { connector: "telegram", userId: "123" }
    }, ctx);
    expect(shell.ok).toBe(false);
    expect(JSON.parse(shell.content)).toMatchObject({
      status: "blocked",
      reason: "not_model_callable"
    });
  });

  it("applies Gateway role gates to model-facing command tools", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Gateway runtime command role gate");
    setCosiaCliExecutorForTests(async (argv) => ({
      exitCode: 0,
      stdout: `argv=${argv.join(" ")}`,
      stderr: ""
    }));
    const gatewayActor = {
      connector: "telegram",
      chatId: "chat-1",
      chatType: "private",
      userId: "user-1"
    };

    const guestResult = await new ToolRegistry().execute("cosia_runtime_command", {
      commandId: "review.list",
      args: {}
    }, {
      workspaceRoot: root,
      allowedTools: ["cosia_runtime_command"],
      sessionId: session.id,
      agentId: "cosia-agent",
      sourceChannel: "gateway",
      gatewayActor,
      gatewayRole: "guest"
    });
    expect(guestResult.ok).toBe(false);
    expect(guestResult.content).toContain("role guest is below required role admin");

    const adminResult = await new ToolRegistry().execute("cosia_runtime_command", {
      commandId: "review.list",
      args: {}
    }, {
      workspaceRoot: root,
      allowedTools: ["cosia_runtime_command"],
      sessionId: session.id,
      agentId: "cosia-agent",
      sourceChannel: "gateway",
      gatewayActor,
      gatewayRole: "admin"
    });
    expect(adminResult.ok).toBe(true);
    expect(JSON.parse(adminResult.content)).toMatchObject({
      status: "ok",
      commandId: "review.list"
    });

    const privateMasterCtx = {
      workspaceRoot: root,
      allowedTools: ["cosia_runtime_command"],
      sessionId: session.id,
      agentId: "cosia-agent",
      sourceChannel: "gateway" as const,
      gatewayActor: {
        connector: "telegram",
        chatId: TELEGRAM_FIXTURE_PRIVATE_ID,
        chatType: "private",
        userId: TELEGRAM_FIXTURE_PRIVATE_ID
      },
      gatewayRole: "master" as const
    };
    const privateMasterDiscard = await new ToolRegistry().execute("cosia_runtime_command", {
      commandId: "review.discard",
      args: { target: "eeb6b7ef", reason: "duplicate style candidate" }
    }, privateMasterCtx);
    expect(privateMasterDiscard.ok).toBe(true);
    expect(JSON.parse(privateMasterDiscard.content)).toMatchObject({
      status: "ok",
      commandId: "review.discard",
      safety: "mutation",
      privateMasterCliOverride: true,
      argv: ["memory", "candidate", "discard", "eeb6b7ef", "--reason", "duplicate style candidate"]
    });

    const privateMasterPromote = await new ToolRegistry().execute("cosia_runtime_command", {
      commandId: "memory.candidate.promote",
      args: { candidateId: "40a12b4f" }
    }, privateMasterCtx);
    expect(privateMasterPromote.ok).toBe(true);
    expect(JSON.parse(privateMasterPromote.content)).toMatchObject({
      status: "ok",
      commandId: "memory.candidate.promote",
      safety: "mutation",
      privateMasterCliOverride: true,
      argv: ["memory", "candidate", "promote", "40a12b4f"]
    });

    const privateMasterBoundary = await new ToolRegistry().execute("cosia_runtime_command", {
      commandId: "gateway.auth.set_master",
      args: { connector: "telegram", userId: TELEGRAM_FIXTURE_PRIVATE_ID }
    }, privateMasterCtx);
    expect(privateMasterBoundary.ok).toBe(true);
    expect(JSON.parse(privateMasterBoundary.content)).toMatchObject({
      status: "ok",
      commandId: "gateway.auth.set_master",
      safety: "system_boundary",
      privateMasterCliOverride: true,
      argv: ["gateway", "auth", "set-master", "telegram", TELEGRAM_FIXTURE_PRIVATE_ID]
    });

    const privateMasterShell = await new ToolRegistry().execute("cosia_runtime_command", {
      commandId: "shell.run",
      args: { command: "node --version" }
    }, privateMasterCtx);
    expect(privateMasterShell.ok).toBe(true);
    expect(JSON.parse(privateMasterShell.content)).toMatchObject({
      status: "ok",
      commandId: "shell.run",
      safety: "dangerous",
      privateMasterCliOverride: true,
      argv: ["shell", "run", "--command", "node --version"]
    });

    const nonDirectMasterBoundary = await new ToolRegistry().execute("cosia_runtime_command", {
      commandId: "gateway.auth.set_master",
      args: { connector: "telegram", userId: TELEGRAM_FIXTURE_PRIVATE_ID }
    }, {
      ...privateMasterCtx,
      gatewayActor: {
        connector: "telegram",
        chatId: "group-1",
        chatType: "group",
        userId: TELEGRAM_FIXTURE_PRIVATE_ID
      }
    });
    expect(nonDirectMasterBoundary.ok).toBe(false);
    expect(JSON.parse(nonDirectMasterBoundary.content)).toMatchObject({
      status: "blocked",
      reason: "gateway_role_denied"
    });
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
    expect(policy.gateway.authorization.chats).toMatchObject([{ connector: "telegram", chatId: "123" }]);
    expect(policy.gateway.authorization.roleBindings).toEqual([]);
    expect(policy.gateway.authorization.masterUser).toMatchObject({ connector: "telegram", userId: "42" });
    expect(policy.connectors.telegram.groupMode).toBe("allowed_users");
    expect(JSON.stringify(policy.connectors.telegram)).not.toContain("secrettelegram");
    expect(await readFile(runtimePrivatePath(root), "utf8")).not.toContain("secrettelegram");
    expect(await readFile(secretsPrivatePath(root), "utf8")).toContain("secrettelegram");

    const check = await checkTelegramGateway(root, {
      fetchImpl: async (url) => {
        if (String(url).endsWith("/getWebhookInfo")) {
          return jsonResponse({ ok: true, result: { url: "", pending_update_count: 0 } });
        }
        return jsonResponse({ ok: true, result: { id: 1, username: "cosia_test_bot" } });
      }
    });
    expect(check).toMatchObject({
      ok: true,
      tokenStatus: "configured via private secret",
      authChatCount: 1,
      masterConfigured: true,
      adminBindings: 0,
      groupMode: "allowed_users",
      allowedUpdates: ["message", "callback_query"]
    });
    expect(formatTelegramCheck(check)).not.toContain("secrettelegram");
    expect(formatTelegramCheck(check)).toContain("Group mode: allowed_users");
    expect(formatTelegramCheck(check)).toContain("Allowed updates: message, callback_query");
    expect(formatTelegramCheck(check)).toContain("Webhook: none");

    await removeTelegramUserId(root, "42");
    await removeTelegramMutationUserId(root, "42");
    const updated = await new PolicyManager(root).loadPolicy();
    expect(updated.gateway.authorization.roleBindings).toEqual([]);
    expect(updated.gateway.authorization.masterUser).toBeUndefined();
  });

  it("detects Telegram webhook conflicts and clears webhook only with explicit yes", async () => {
    const root = await initializedWorkspace();
    await enableTelegramConnector(root, true);
    await addTelegramChatId(root, "123");
    await setTelegramToken(root, "1234567890:AAsecrettelegramtokenvalue");
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ url: String(url), body });
      if (String(url).endsWith("/getMe")) {
        return jsonResponse({ ok: true, result: { id: 1, username: "cosia_test_bot" } });
      }
      if (String(url).endsWith("/getWebhookInfo")) {
        return jsonResponse({
          ok: true,
          result: {
            url: "https://example.test/cosia-hook",
            pending_update_count: 3,
            allowed_updates: ["message"]
          }
        });
      }
      if (String(url).endsWith("/deleteWebhook")) {
        return jsonResponse({ ok: true, result: true });
      }
      return jsonResponse({ ok: false, description: "unknown" }, 404);
    };

    const check = await checkTelegramGateway(root, { fetchImpl });
    expect(check).toMatchObject({
      ok: false,
      reason: "webhook_conflict",
      webhookUrl: "https://example.test/cosia-hook",
      allowedUpdates: ["message", "callback_query"]
    });
    expect(formatTelegramCheck(check)).toContain("webhook clear --yes");
    expect(formatTelegramCheck(check)).not.toContain("AAsecrettelegram");

    const status = await getTelegramWebhookStatus(root, { fetchImpl });
    expect(formatTelegramWebhookStatus(status)).toContain("Webhook: https://example.test/cosia-hook");
    expect(formatTelegramWebhookStatus(status)).toContain("Pending updates: 3");

    const beforePreviewCalls = requests.length;
    const preview = await clearTelegramWebhook(root, { fetchImpl });
    expect(preview).toMatchObject({ applied: false, cleared: false });
    expect(requests).toHaveLength(beforePreviewCalls);
    expect(formatTelegramWebhookClear(preview)).toContain("webhook clear --yes");

    const cleared = await clearTelegramWebhook(root, { yes: true, fetchImpl });
    expect(cleared).toMatchObject({ applied: true, cleared: true });
    const deleteRequest = requests.find((request) => request.url.endsWith("/deleteWebhook"));
    expect(deleteRequest?.body).toMatchObject({ drop_pending_updates: false });
    expect(formatTelegramWebhookClear(cleared)).not.toContain("AAsecrettelegram");
  });

  it("surfaces Telegram migrate_to_chat_id guidance without changing auth", async () => {
    const root = await initializedWorkspace();
    await enableTelegramConnector(root, true);
    await setTelegramToken(root, "1234567890:AAsecrettelegramtokenvalue");
    const status = await getTelegramWebhookStatus(root, {
      fetchImpl: async () => jsonResponse({
        ok: false,
        error_code: 400,
        description: "Bad Request: group chat was upgraded to a supergroup chat",
        parameters: { migrate_to_chat_id: -100123 }
      }, 400)
    });

    expect(status).toMatchObject({ ok: false, status: "failed" });
    expect(status.hint).toContain("allow-chat telegram -100123");
    const policy = await new PolicyManager(root).loadPolicy();
    expect(policy.gateway.authorization.chats).toEqual([]);
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
    expect(sent.map((message) => message.text).join("\n")).toContain("not registered");
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
    expect(ownerGateOutput).toContain("Gateway authorization gate");
    expect(ownerGateOutput).toContain("cosia gateway auth set-role telegram 7 guest --chat-id 123");
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
    expect(state.chats["123"]).toBeUndefined();
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

  it("normalizes Telegram messages and callbacks into Gateway activities", () => {
    const slash = telegramActivityFromMessage({
      chat: { id: -100123, type: "supergroup" },
      from: { id: 42, username: "fox", first_name: "Fox" },
      message_thread_id: 777,
      text: "/status@Kumi_coais_bot"
    }, "/status", 11);
    expect(slash).toMatchObject({
      type: "slash_command",
      connector: "telegram",
      sourceUpdateId: 11,
      text: "/status",
      actor: {
        connector: "telegram",
        chatId: "-100123",
        chatType: "supergroup",
        userId: "42",
        username: "fox",
        displayName: "Fox"
      },
      replyTarget: {
        connector: "telegram",
        chatId: "-100123",
        messageThreadId: 777
      }
    });

    const plain = telegramActivityFromMessage({
      chat: { id: 123, type: "private" },
      from: { id: 42 },
      text: "쿠미?"
    }, "쿠미?", 12);
    expect(plain.type).toBe("plain_message");
    expect(plain.replyTarget).toMatchObject({ connector: "telegram", chatId: "123" });

    const whoami = telegramActivityFromMessage({
      chat: { id: 123, type: "private" },
      from: { id: 42 },
      text: "/whoami"
    }, "/whoami", 13);
    expect(whoami.type).toBe("whoami");

    const callback = telegramActivityFromCallback({
      id: "cb1",
      from: { id: 42, username: "fox" },
      message: {
        chat: { id: -100123, type: "supergroup" },
        message_thread_id: 777
      },
      data: "review:show:eeb6b7ef"
    }, 14);
    expect(callback).toMatchObject({
      type: "callback_action",
      callbackData: "review:show:eeb6b7ef",
      replyTarget: {
        connector: "telegram",
        chatId: "-100123",
        messageThreadId: 777
      }
    });
  });

  it("handles GatewayActivity in core without a raw Telegram update", async () => {
    const root = await initializedWorkspace();
    const policy = await new PolicyManager(root).loadPolicy();
    const result = await handleGatewayActivity({
      workspaceRoot: root,
      policy,
      connectorDescriptor: {
        id: "test",
        displayName: "Test",
        normalizeAddressedCommand: (text: string) => text.trim(),
        formatBootstrapHints: () => [],
        callbackNamespaces: {},
        messageDefaults: {
          messageChunkChars: 3500,
          sendPacingMs: 0,
          typingRefreshMs: 0
        }
      },
      activity: {
        type: "whoami",
        connector: "test",
        text: "/whoami",
        actor: {
          connector: "test",
          chatId: "chat-1",
          chatType: "private",
          userId: "user-1",
          username: "fox",
          displayName: "Fox"
        },
        replyTarget: {
          connector: "test",
          chatId: "chat-1"
        }
      },
      actor: {
        connector: "test",
        chatId: "chat-1",
        chatType: "private",
        userId: "user-1",
        username: "fox",
        displayName: "Fox"
      },
      chatState: { providerId: "mock" },
      providerId: "mock",
      owner: "test",
      replyTarget: {
        connector: "test",
        chatId: "chat-1"
      }
    });

    expect(result.output).toContain("Gateway identity");
    expect(result.output).toContain("Connector: test");
    expect(result.output).toContain("Chat id: chat-1");
    expect(result.state).toEqual({ providerId: "mock" });
  });

  it("normalizes Gateway turns with secret-like risk flags for durable storage decisions", async () => {
    const root = await initializedWorkspace();
    const policy = await new PolicyManager(root).loadPolicy();
    const normalized = normalizeGatewayTurn({
      workspaceRoot: root,
      policy,
      connectorDescriptor: {
        id: "test",
        displayName: "Test",
        normalizeAddressedCommand: (text: string) => text.trim(),
        formatBootstrapHints: () => [],
        callbackNamespaces: {},
        messageDefaults: {
          messageChunkChars: 3500,
          sendPacingMs: 0,
          typingRefreshMs: 0
        }
      },
      activity: {
        type: "plain_message",
        connector: "test",
        text: "token=abcd1234",
        actor: {
          connector: "test",
          chatId: "chat-1",
          chatType: "private",
          userId: "user-1"
        },
        replyTarget: {
          connector: "test",
          chatId: "chat-1"
        }
      },
      actor: {
        connector: "test",
        chatId: "chat-1",
        chatType: "private",
        userId: "user-1"
      },
      chatState: { providerId: "mock" },
      providerId: "mock",
      owner: "test",
      replyTarget: {
        connector: "test",
        chatId: "chat-1"
      }
    });

    expect(normalized.pipelineStage).toBe("normalize_turn");
    expect(normalized.riskFlags?.secretLikeInput).toBe(true);
    expect(normalized.activity.riskFlags?.secretLikeInput).toBe(true);
  });

  it("stores only non-secret queued turns in the durable turn queue", async () => {
    const root = await initializedWorkspace();
    const turnId = createGatewayTurnId();
    const activity = {
      type: "plain_message" as const,
      connector: "telegram",
      text: "hello",
      actor: {
        connector: "telegram",
        chatId: "123",
        chatType: "private",
        userId: "42"
      },
      replyTarget: {
        connector: "telegram",
        chatId: "123"
      },
      riskFlags: {
        secretLikeInput: false
      }
    };

    await appendGatewayDurableTurnEvent(root, {
      turnId,
      connector: "telegram",
      sessionId: "session_test",
      activity,
      replyTarget: activity.replyTarget,
      riskFlags: activity.riskFlags,
      createdAt: "2026-05-27T00:00:00.000Z",
      status: "queued"
    });
    const secretResult = await appendGatewayDurableTurnEvent(root, {
      turnId: createGatewayTurnId(),
      connector: "telegram",
      sessionId: "session_secret",
      activity: {
        ...activity,
        text: "api_key=sk-test-secret-secret",
        riskFlags: { secretLikeInput: true }
      },
      replyTarget: activity.replyTarget,
      riskFlags: { secretLikeInput: true },
      createdAt: "2026-05-27T00:00:00.000Z",
      status: "queued"
    });

    expect(secretResult).toEqual({ stored: false, reason: "secret_like" });
    const pending = await loadPendingGatewayDurableTurns(root, { nowMs: Date.parse("2026-05-27T00:10:00.000Z") });
    expect(pending.pending.map((turn) => turn.turnId)).toEqual([turnId]);
    expect(await readFile(gatewayTurnQueuePath(root), "utf8")).toContain(turnId);
  });

  it("keeps read-only Telegram tool calls in the foreground", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Foreground read-only tool");
    const policy = await new PolicyManager(root).loadPolicy();
    const gatewayPolicy = {
      ...policy,
      connectors: {
        telegram: {
          ...policy.connectors.telegram,
          enabled: true,
          allowedChatIds: ["123"],
          allowedUserIds: ["42"],
          mutationUserIds: ["42"],
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
        text: "[MOCK_TOOL_CALL:search_files:COSIA] hello"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    await waitForCondition(() => sent.some((message) => message.text.includes(`Mock response for ${session.id}.`)));
    expect(sent.some((message) => message.text.includes("작업을 시작했어."))).toBe(false);
    expect(await new RunJobLedger(root).list({ includeTerminal: true })).toEqual([]);
  });

  it("promotes Telegram session runs to jobs after the model selects a background-worthy tool", async () => {
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
          mutationUserIds: ["42"],
          defaultProvider: "mock"
        }
      }
    };
    const sent: Array<{ chatId: string; text: string; options?: { replyMarkup?: unknown; messageThreadId?: number | string } }> = [];
    const sender = {
      sendMessage: async (chatId: string, text: string, options?: { replyMarkup?: unknown; messageThreadId?: number | string }) => {
        sent.push({ chatId, text, options });
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
        text: "[MOCK_TOOL_CALL:shell_request:node --version] hello"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    await waitForCondition(() => sent.some((message) => message.text.includes("작업을 시작했어.")));
    const jobMessage = sent.find((message) => message.text.includes("작업을 시작했어."));
    const jobId = jobMessage?.text.match(/Job: (job_[a-f0-9]+)/)?.[1];
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

  it("does not create a Telegram run job for a normal final-only conversation", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "Foreground gateway chat");
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
    const sent: Array<{ chatId: string; text: string; options?: { replyMarkup?: unknown; messageThreadId?: number | string } }> = [];
    const sender = {
      sendMessage: async (chatId: string, text: string, options?: { replyMarkup?: unknown; messageThreadId?: number | string }) => {
        sent.push({ chatId, text, options });
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
        text: "쿠미?"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });

    await waitForCondition(() => sent.some((message) => message.text.includes(`Mock response for ${session.id}.`)));
    expect(sent.some((message) => message.text.includes("작업을 시작했어."))).toBe(false);
    expect(await new RunJobLedger(root).list({ includeTerminal: true })).toEqual([]);
  });

  it("runs different Telegram sessions concurrently without blocking the update intake loop", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const slowSession = await sessions.createSession("cosia-agent", "Slow session");
    const fastSession = await sessions.createSession("cosia-agent", "Fast session");
    const policy = await new PolicyManager(root).loadPolicy();
    const gatewayPolicy = {
      ...policy,
      connectors: {
        telegram: {
          ...policy.connectors.telegram,
          enabled: true,
          allowedChatIds: ["123", "456"],
          allowedUserIds: ["42"],
          defaultProvider: "mock"
        }
      }
    };
    const sent: Array<{ chatId: string; text: string; options?: { messageThreadId?: number | string } }> = [];
    const sender = {
      sendMessage: async (chatId: string, text: string, options?: { messageThreadId?: number | string }) => {
        sent.push({ chatId, text, options });
      }
    };
    const state = {
      chats: {
        "123": {
          providerId: "mock",
          activeSessionId: slowSession.id
        },
        "456": {
          providerId: "mock",
          activeSessionId: fastSession.id
        }
      },
      failureCount: 0,
      updatedAt: new Date().toISOString()
    };

    await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 1,
      message: {
        chat: { id: 123 },
        from: { id: 42, username: "fox" },
        text: "[MOCK_SLOW_FINAL] slow"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent).toEqual([]);

    await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 2,
      message: {
        chat: { id: 456 },
        from: { id: 42, username: "fox" },
        text: "fast"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });

    await waitForCondition(() => sent.some((message) => message.text.includes(`Mock response for ${fastSession.id}.`)));
    expect(sent[0]?.chatId).toBe("456");
    expect(sent[0]?.text).toContain(`Mock response for ${fastSession.id}.`);
    await waitForCondition(() => sent.some((message) => message.text.includes(`Mock response for ${slowSession.id}.`)));
    expect(sent.some((message) => message.text.includes("작업을 시작했어."))).toBe(false);
  });

  it("keeps Telegram messages for the same session in FIFO order", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("cosia-agent", "FIFO session");
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
    const state = {
      chats: {
        "123": {
          providerId: "mock",
          activeSessionId: session.id
        }
      },
      failureCount: 0,
      updatedAt: new Date().toISOString()
    };

    await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 1,
      message: {
        chat: { id: 123 },
        from: { id: 42, username: "fox" },
        text: "[MOCK_SLOW_FINAL][MOCK_FINAL:first]"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 2,
      message: {
        chat: { id: 123 },
        from: { id: 42, username: "fox" },
        text: "[MOCK_FINAL:second]"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });

    await waitForCondition(() => sent.length >= 2);
    expect(sent[0]?.text).toContain("first");
    expect(sent[1]?.text).toContain("second");
  });

  it("captures the target session when a Telegram turn is enqueued", async () => {
    const root = await initializedWorkspace();
    const sessions = new SessionManager(root);
    const firstSession = await sessions.createSession("cosia-agent", "Captured session");
    const secondSession = await sessions.createSession("cosia-agent", "Future session");
    const policy = await new PolicyManager(root).loadPolicy();
    const gatewayPolicy = {
      ...policy,
      connectors: {
        telegram: {
          ...policy.connectors.telegram,
          enabled: true,
          allowedChatIds: ["123"],
          allowedUserIds: ["42"],
          mutationUserIds: ["42"],
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
    let state: Awaited<ReturnType<typeof loadTelegramGatewayState>> = {
      chats: {
        "123": {
          providerId: "mock",
          activeSessionId: firstSession.id
        }
      },
      failureCount: 0,
      updatedAt: new Date().toISOString()
    };

    state = await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 1,
      message: {
        chat: { id: 123 },
        from: { id: 42, username: "fox" },
        text: "[MOCK_SLOW_FINAL] first turn"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    state = await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 2,
      message: {
        chat: { id: 123 },
        from: { id: 42, username: "fox" },
        text: `/use ${secondSession.id}`
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(state.chats["123"]?.activeSessionId).toBe(secondSession.id);
    state = await processTelegramUpdate(root, gatewayPolicy, sender, state, {
      update_id: 3,
      message: {
        chat: { id: 123 },
        from: { id: 42, username: "fox" },
        text: "second turn"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });

    await waitForCondition(() => sent.some((message) => message.text.includes(`Mock response for ${secondSession.id}.`)));
    await waitForCondition(() => sent.some((message) => message.text.includes(`Mock response for ${firstSession.id}.`)));
    expect(sent.find((message) => message.text.includes(`Mock response for ${firstSession.id}.`))).toBeTruthy();
    expect(sent.find((message) => message.text.includes(`Mock response for ${secondSession.id}.`))).toBeTruthy();
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
    const sent: Array<{ chatId: string; text: string; options?: { replyMarkup?: unknown; messageThreadId?: number | string } }> = [];
    const sender = {
      sendMessage: async (chatId: string, text: string, options?: { replyMarkup?: unknown; messageThreadId?: number | string }) => {
        sent.push({ chatId, text, options });
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
    expect(sent.at(-1)?.text).toContain("cosia gateway auth set-master telegram 42");
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
    expect(sent.at(-1)?.text).toContain("COSIA 0.74.0");

    state = await processTelegramUpdate(root, readOnlyGroupPolicy, sender, state, {
      update_id: 19,
      message: {
        chat: { id: -100, type: "supergroup" },
        message_thread_id: 777,
        from: { id: 42, username: "fox" },
        text: "/status"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("COSIA 0.74.0");
    expect(sent.at(-1)?.options?.messageThreadId).toBe(777);

    const masterMentionPolicy = {
      ...readOnlyGroupPolicy,
      connectors: {
        telegram: {
          ...readOnlyGroupPolicy.connectors.telegram,
          mutationUserIds: ["42"]
        }
      }
    };
    state = await processTelegramUpdate(root, masterMentionPolicy, sender, state, {
      update_id: 20,
      message: {
        chat: { id: -100, type: "group" },
        from: { id: 42, username: "fox" },
        text: `@${TELEGRAM_FIXTURE_BOT_USERNAME} /new Mentioned group session`
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("Created and selected session");

    state = await processTelegramUpdate(root, masterMentionPolicy, sender, state, {
      update_id: 21,
      message: {
        chat: { id: -100, type: "group" },
        from: { id: 42, username: "fox" },
        text: `/new@${TELEGRAM_FIXTURE_BOT_USERNAME} Suffixed group session`
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("Created and selected session");

    state = await processTelegramUpdate(root, masterMentionPolicy, sender, state, {
      update_id: 22,
      message: {
        chat: { id: -100, type: "group" },
        from: { id: 42, username: "fox" },
        text: `@${TELEGRAM_FIXTURE_BOT_USERNAME}/new Mention-prefix group session`
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("Created and selected session");

    state = await processTelegramUpdate(root, masterMentionPolicy, sender, state, {
      update_id: 23,
      message: {
        chat: { id: -100, type: "group" },
        from: { id: 42, username: "fox" },
        text: `@${TELEGRAM_FIXTURE_BOT_USERNAME} new Bare mentioned group session`
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("Created and selected session");

    const sentBeforeUnknownGroupNatural = sent.length;
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
        from: { id: 77, username: "unknown" },
        text: "그냥 대화해줘"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.length).toBe(sentBeforeUnknownGroupNatural);

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
    expect(sent.at(-1)?.text).toContain("Required role: master");

    const allowedGroupPolicy = {
      ...policy,
      connectors: {
        telegram: {
          ...policy.connectors.telegram,
          enabled: true,
          allowedChatIds: ["-100"],
          allowedUserIds: ["42"],
          mutationUserIds: ["42"],
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
    await waitForCondition(() => sent.some((message) => message.text.includes("[PREVIEW] File overwrite requires approval.")));
    state = await loadTelegramGatewayState(root);
    expect(await readFile(stylePath, "utf8")).toBe(originalStyle);

    state = await processTelegramUpdate(root, allowedGroupPolicy, sender, state, {
      update_id: 6,
      message: {
        chat: { id: -100, type: "group" },
        from: { id: 43, username: "notmaster" },
        text: "/apply"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });
    expect(sent.at(-1)?.text).toContain("not registered");
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
    expect(sent.at(-1)?.text).toContain("did not provide a user id");
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

  it("best-effort acknowledges Telegram callback queries before handling them", async () => {
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
    const sent: string[] = [];
    const sender = {
      sendMessage: async (_chatId: string, text: string) => {
        sent.push(text);
      },
      answerCallbackQuery: async () => {
        throw new Error("callback ack network failure");
      }
    };

    await processTelegramUpdate(root, gatewayPolicy, sender, {
      chats: {},
      failureCount: 0,
      updatedAt: new Date().toISOString()
    }, {
      update_id: 1,
      callback_query: {
        id: "callback-1",
        data: "review:refresh",
        from: { id: 42, username: "fox" },
        message: {
          chat: { id: 123, type: "private" }
        }
      }
    }, {
      providerId: "mock",
      owner: "test"
    });

    expect(sent.join("\n")).toContain("Review Inbox");
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
          mutationUserIds: ["42"],
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
        from: { id: 42, username: "fox" },
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
          mutationUserIds: ["42"],
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
        from: { id: 42, username: "fox" },
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
        from: { id: 42, username: "fox" },
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

    expect(sent.at(-1)?.text).toContain("COSIA 0.74.0");
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
          mutationUserIds: ["42"],
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
        from: { id: 42, username: "fox" },
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

    await waitForCondition(async () => Boolean((await loadTelegramGatewayState(root)).chats["123"]?.currentToolGrowthRoutineId));
    state = await loadTelegramGatewayState(root);
    const routineId = state.chats["123"]?.currentToolGrowthRoutineId;
    expect(routineId).toMatch(/^grow_/);
    expect(state.chats["123"]?.pendingToolGrowthRequest).toBeUndefined();
    const routineMessage = sent.find((message) => message.text.includes(`Tool growth routine created: ${routineId}`))?.text;
    expect(routineMessage).toContain("좋아. 방금 제안한 도구 생성 루틴을 시작할게.");
    expect(routineMessage).toContain(`Tool growth routine created: ${routineId}`);
    expect(routineMessage).toContain("read-only memory promotion queue inspector");
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
          mutationUserIds: ["42"],
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
        text: "[MOCK_WRITE_ONLY:agents/cosia-agent/STYLE.md]"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });

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
        from: { id: 42, username: "fox" },
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
          mutationUserIds: ["42"],
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
        text: "[MOCK_WRITE_ONLY:codex/RULES.md]"
      }
    }, {
      providerId: "mock",
      owner: "test"
    });

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
        from: { id: 42, username: "fox" },
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

    await waitForCondition(() => sent.some((message) => message.text.includes("[PARTIAL SUCCESS] 도구 조회는 성공했지만 LLM 최종 응답이 timeout")));
    expect(sent.at(-1)?.text).toContain("Memory pending:");
    const jobs = await new RunJobLedger(root).list({ includeTerminal: true });
    expect(jobs).toEqual([]);
  });

  it("reports recovery guidance instead of raw JSON parse errors for malformed Telegram gateway state", async () => {
    const root = await initializedWorkspace();
    await mkdir(join(root, ".cosia-gateway", "telegram"), { recursive: true });
    await writeFile(join(root, ".cosia-gateway", "telegram", "state.json"), "", "utf8");

    await expect(loadTelegramGatewayState(root)).rejects.toThrow("Telegram gateway state is not valid JSON");
    await expect(loadTelegramGatewayState(root)).rejects.toThrow("cosia gateway telegram reset-state --yes");
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
          allowedUserIds: ["42"],
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
      if (String(url).endsWith("/getWebhookInfo")) {
        return jsonResponse({ ok: true, result: { url: "", pending_update_count: 0 } });
      }
      if (String(url).endsWith("/getUpdates")) {
        return jsonResponse({
          ok: true,
          result: [{
            update_id: 11,
            message: {
              message_thread_id: 777,
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
    expect(getUpdatesRequest?.body.allowed_updates).toEqual(["message", "callback_query"]);
    const chatActionRequest = requests.find((request) => request.url.endsWith("/sendChatAction"));
    expect(chatActionRequest?.body).toMatchObject({
      chat_id: "123",
      message_thread_id: 777,
      action: "typing"
    });
    const sendMessageRequest = requests.find((request) => request.url.endsWith("/sendMessage"));
    expect(sendMessageRequest?.body).toMatchObject({
      chat_id: "123",
      message_thread_id: 777
    });
    const state = await loadTelegramGatewayState(root);
    expect(state.nextOffset).toBe(12);
    expect(state.chats["123"]).toBeUndefined();
    expect(await pathExists(join(root, ".cosia-gateway", "telegram", "process.lock"))).toBe(false);
    expect(await pathExists(gatewayProcessLockPath(root))).toBe(false);
  });

  it("retries Telegram send calls once when Bot API returns retry_after", async () => {
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
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    let sendMessageAttempts = 0;
    const fetchImpl: FetchLike = async (url) => {
      if (String(url).endsWith("/getMe")) {
        return jsonResponse({ ok: true, result: { id: 1, username: "cosia_test_bot" } });
      }
      if (String(url).endsWith("/getWebhookInfo")) {
        return jsonResponse({ ok: true, result: { url: "", pending_update_count: 0 } });
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
      if (String(url).endsWith("/sendChatAction")) {
        return jsonResponse({ ok: true, result: true });
      }
      if (String(url).endsWith("/sendMessage")) {
        sendMessageAttempts += 1;
        if (sendMessageAttempts === 1) {
          return jsonResponse({
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry later",
            parameters: { retry_after: 0 }
          }, 429);
        }
        return jsonResponse({ ok: true, result: { message_id: 2 } });
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

    expect(sendMessageAttempts).toBe(2);
    const state = await loadTelegramGatewayState(root);
    expect(state.nextOffset).toBe(2);
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
          allowedChatIds: ["123"],
          allowedUserIds: ["42"],
          mutationUserIds: ["42"]
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
      if (String(url).endsWith("/getWebhookInfo")) {
        return jsonResponse({ ok: true, result: { url: "", pending_update_count: 0 } });
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
    expect(jobs).toEqual([]);
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
      if (String(url).endsWith("/getWebhookInfo")) {
        return jsonResponse({ ok: true, result: { url: "", pending_update_count: 0 } });
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
      if (String(url).endsWith("/getWebhookInfo")) {
        return jsonResponse({ ok: true, result: { url: "", pending_update_count: 0 } });
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
    expect(state.chats["123"]).toBeUndefined();
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
