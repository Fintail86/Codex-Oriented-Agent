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
  legacyEnvironmentScanId,
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
      "cosia_cli_command_lookup",
      "cosia_runtime_command",
      "shell_request"
    ]));
    expect(session.id).toMatch(/^session_\d{8}_001$/);
    expect(session.assignedAgentId).toBe("architect-agent");
    const sessionJson = JSON.parse(await readFile(join(root, "sessions", session.id, "session.json"), "utf8")) as Record<string, unknown>;
    expect(sessionJson.assignedAgentId).toBe("architect-agent");
    expect(sessionJson.agentId).toBeUndefined();
    expect(await readFile(join(root, "codex", "SECURITY.md"), "utf8")).toContain("SECURITY");
    const policyJson = await readFile(join(root, "codex", "POLICY.json"), "utf8");
    expect(policyJson).toContain("\"version\": \"0.65.0\"");
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
    expect(prompt).toContain("call cosia_cli_command_lookup with the user's original request text");
    expect(prompt).toContain("cosia_runtime_command may return needs_input");
    expect(prompt).toContain("ask for permission to start the guided tool-growth routine");
    expect(prompt).toContain("Should I start the tool creation routine?");
    expect(prompt).toContain("If lookup returns only non-callable or safety-blocked command surfaces");
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
