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
  classifyToolBudgetCall,
  consumeToolBudget,
  createToolLoopBudget,
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

  it("defaults optional memory candidate metadata without rejecting final answers", () => {
    const output = parseModelOutput(JSON.stringify({
      type: "final",
      content: "좋아, 앞으로 쿠미라고 부르면 돼.",
      memoryCandidates: [{
        tier: "agent",
        ownerId: "cosia-agent",
        content: "사용자는 이 에이전트를 앞으로 '쿠미'라고 부르기로 했다."
      }]
    }));
    expect(output.step).toMatchObject({
      type: "final",
      memoryCandidates: [{
        kind: "note",
        importance: 3,
        confidence: 0.7
      }]
    });
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
    expect(resolveProviderSelection(policy, "mock")).toBe("mock");
    expect(() => resolveProviderSelection(policy, "openrouter")).toThrow("Provider id 'openrouter' is not a runtime selection");

    await addProviderProfile(root, "openrouter-profile", {
      providerId: "openrouter",
      apiKey: "test-openrouter-key",
      model: "openai/gpt-test"
    });
    const withProfile = await new PolicyManager(root).loadPolicy();
    expect(resolveProviderSelection(withProfile, "openrouter-profile")).toBe("openrouter-profile");
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
        candidateTiers: ["core", "agent", "session"]
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

  it("preserves action budget after observation budget is exhausted", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Budget lanes preserve action");
    const events: string[] = [];
    let calls = 0;
    const provider: ModelProvider = {
      id: "test",
      checkAuth: async () => ({ ok: true, message: "ok" }),
      complete: async () => {
        calls += 1;
        if (calls <= 6) {
          return parseModelOutput('{"type":"tool_call","tool":"read_file","args":{"path":"codex/RULES.md"}}');
        }
        if (calls === 7) {
          return parseModelOutput('{"type":"tool_call","tool":"write_file","args":{"path":"notes.txt","content":"action survived observation exhaustion"}}');
        }
        return parseModelOutput('{"type":"final","content":"final after action","memoryCandidates":[]}');
      }
    };

    const content = await runSession(root, {
      sessionId: session.id,
      prompt: "Read too much, then write.",
      provider,
      onEvent: (message) => events.push(message)
    });

    expect(content).toBe("final after action");
    expect(calls).toBe(8);
    expect(events).toContain("tool_call rejected because observation_budget_exhausted");
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("action survived observation exhaustion");
  });

  it("classifies cosia_runtime_command budget lanes from command metadata", async () => {
    const root = await initializedWorkspace();
    expect(classifyToolBudgetCall(root, "cosia_runtime_command", {
      commandId: "review.list",
      args: {}
    })).toMatchObject({
      lane: "observation",
      runtimeCommandId: "review.list",
      runtimeCommandSafety: "read_only"
    });
    expect(classifyToolBudgetCall(root, "cosia_runtime_command", {
      commandId: "review.discard",
      args: { id: "abc12345" }
    })).toMatchObject({
      lane: "action",
      runtimeCommandId: "review.discard",
      runtimeCommandSafety: "mutation"
    });
  });

  it("uses total hard cap as the top-level tool budget brake", async () => {
    const budget = createToolLoopBudget();
    budget.totalHardCapRemaining = 0;
    const decision = consumeToolBudget(budget, {
      lane: "observation",
      reason: "test observation",
      toolName: "read_file"
    });
    expect(decision).toMatchObject({
      allowed: false,
      reason: "total_hard_cap_exhausted"
    });
    expect(budget.observationRemaining).toBeGreaterThan(0);
  });

  it("does not expose observation budget exhaustion as the final answer", async () => {
    const root = await initializedWorkspace();
    const agents = new AgentManager(root);
    await agents.createAgent("architect-agent", "architect");
    const sessions = new SessionManager(root);
    const session = await sessions.createSession("architect-agent", "Budget rejection is internal");
    let calls = 0;
    const provider: ModelProvider = {
      id: "test",
      checkAuth: async () => ({ ok: true, message: "ok" }),
      complete: async (input) => {
        calls += 1;
        if (calls <= 6) {
          return parseModelOutput('{"type":"tool_call","tool":"search_files","args":{"query":"COSIA"}}');
        }
        expect(input.prompt).toContain("observation budget is exhausted");
        return parseModelOutput('{"type":"final","content":"I will stop searching and answer from available results.","memoryCandidates":[]}');
      }
    };

    const content = await runSession(root, {
      sessionId: session.id,
      prompt: "Search until observation budget is exhausted.",
      provider
    });

    expect(content).not.toContain("tool budget");
    expect(content).not.toContain("budget is exhausted");
    expect(content).toContain("available results");
    expect(calls).toBe(7);
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
