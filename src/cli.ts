#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { AgentManager } from "./runtime/agent_manager.js";
import { initProject } from "./runtime/init_project.js";
import { formatMemoryConflicts, formatMemoryReviewSummary, MemoryManager } from "./runtime/memory_manager.js";
import { formatPolicyAuditEvents, PolicyAuditLog } from "./runtime/policy_audit.js";
import { formatPolicySummary, PolicyManager } from "./runtime/policy_manager.js";
import { loadPromptStaticBlocks } from "./runtime/prompt_builder.js";
import { runSession } from "./runtime/runner.js";
import { SessionManager } from "./runtime/session_manager.js";
import { getStatusReport } from "./runtime/status_report.js";
import { memoryScopeSchema } from "./runtime/types.js";
import { COSIA_VERSION } from "./runtime/version.js";
import { requireWorkspaceRoot, workspaceRootForInit } from "./runtime/workspace.js";

const program = new Command();

program
  .name("cosia")
  .description("COSIA: Codex-Oriented Self-Improving Agent Runtime CLI MVP")
  .version(COSIA_VERSION);

program
  .command("status")
  .option("--provider <provider>", "Model provider smoke check: default, codex-cli, or mock", "default")
  .description("Show workspace, runtime, memory, session, and provider status.")
  .action(async (options: { provider: string }) => {
    await main(async (workspaceRoot) => {
      const report = await getStatusReport(workspaceRoot, options.provider);
      console.log(`COSIA ${report.version}`);
      console.log(`Workspace: ${report.workspaceRoot}`);
      console.log(`Agents: ${report.agentsCount}`);
      console.log(`Sessions: ${report.sessionsCount}`);
      console.log(`Memories: ${report.memoriesCount}`);
      console.log(`Pending candidates: ${report.pendingCandidatesCount}`);
      console.log(`Provider: ${report.providerId} (${report.providerOk ? "ok" : "failed"})`);
      console.log(`Provider message: ${report.providerMessage}`);
    });
  });

program
  .command("init")
  .description("Create the default runtime directory structure and Codex templates.")
  .action(async () => {
    await main(async (workspaceRoot) => {
      const created = await initProject(workspaceRoot);
      console.log(`Initialized runtime in ${workspaceRoot}`);
      console.log(created.map((item) => `- ${item}`).join("\n"));
    }, { allowUninitialized: true });
  });

const agent = program.command("agent").description("Manage agents.");

agent
  .command("create")
  .argument("<agent-id>")
  .option("--template <template>", "Agent template", "architect")
  .description("Create an agent from a template.")
  .action(async (agentId: string, options: { template: string }) => {
    await main(async (workspaceRoot) => {
      const manager = new AgentManager(workspaceRoot);
      const manifest = await manager.createAgent(agentId, options.template);
      console.log(`Created agent ${manifest.id}`);
    });
  });

const session = program.command("session").description("Manage sessions.");

session
  .command("create")
  .requiredOption("--agent <agent-id>", "Agent id")
  .requiredOption("--goal <goal>", "Session goal")
  .description("Create a session for an agent.")
  .action(async (options: { agent: string; goal: string }) => {
    await main(async (workspaceRoot) => {
      const agents = new AgentManager(workspaceRoot);
      await agents.loadAgent(options.agent);
      const sessions = new SessionManager(workspaceRoot);
      const metadata = await sessions.createSession(options.agent, options.goal);
      console.log(metadata.id);
    });
  });

session
  .command("list")
  .description("List sessions.")
  .action(async () => {
    await main(async (workspaceRoot) => {
      const sessions = await new SessionManager(workspaceRoot).listSessions();
      if (!sessions.length) {
        console.log("No sessions.");
        return;
      }
      for (const item of sessions) {
        console.log(`${item.id}\t${item.agentId}\t${item.status}\t${item.updatedAt}\t${item.goal}`);
      }
    });
  });

session
  .command("show")
  .argument("<session-id>")
  .option("--tail <chars>", "Context tail character count", "1200")
  .description("Show session metadata and recent context memory.")
  .action(async (sessionId: string, options: { tail: string }) => {
    await main(async (workspaceRoot) => {
      const sessions = new SessionManager(workspaceRoot);
      const metadata = await sessions.loadSession(sessionId);
      console.log(JSON.stringify(metadata, null, 2));
      const tail = await sessions.contextTail(sessionId, Number.parseInt(options.tail, 10));
      console.log("\n# CONTEXT TAIL\n");
      console.log(tail || "No context memory.");
    });
  });

session
  .command("summarize")
  .argument("<session-id>")
  .requiredOption("--content <summary>", "Compact session summary")
  .description("Write SESSION_SUMMARY.md for a session.")
  .action(async (sessionId: string, options: { content: string }) => {
    await main(async (workspaceRoot) => {
      const sessions = new SessionManager(workspaceRoot);
      await sessions.loadSession(sessionId);
      await sessions.updateSummary(sessionId, options.content);
      console.log(`Updated ${sessionId} SESSION_SUMMARY.md`);
    });
  });

const memory = program.command("memory").description("Manage long-term memory.");

memory
  .command("add")
  .requiredOption("--scope <scope>", "Memory scope")
  .requiredOption("--content <content>", "Memory content")
  .option("--kind <kind>", "Memory kind", "note")
  .option("--owner-id <owner-id>", "Owner id")
  .option("--importance <importance>", "Memory importance from 1 to 5", "3")
  .option("--confidence <confidence>", "Memory confidence from 0 to 1", "0.7")
  .description("Add an explicit long-term memory.")
  .action(async (options: { scope: string; content: string; kind: string; ownerId?: string; importance: string; confidence: string }) => {
    await main(async (workspaceRoot) => {
      const manager = new MemoryManager(workspaceRoot);
      const record = manager.addMemory({
        scope: memoryScopeSchema.parse(options.scope),
        content: options.content,
        kind: options.kind,
        ownerId: options.ownerId,
        importance: parseIntegerOption(options.importance, "importance"),
        confidence: parseNumberOption(options.confidence, "confidence")
      });
      console.log(record.id);
    });
  });

memory
  .command("search")
  .requiredOption("--query <query>", "Search query")
  .option("--limit <limit>", "Result limit", "8")
  .option("--show-score", "Show memory search scores.", false)
  .description("Search explicit long-term memory.")
  .action(async (options: { query: string; limit: string; showScore: boolean }) => {
    await main(async (workspaceRoot) => {
      const manager = new MemoryManager(workspaceRoot);
      const results = manager.search(options.query, Number.parseInt(options.limit, 10));
      if (!results.length) {
        console.log("No matches.");
        return;
      }
      for (const result of results) {
        const record = result.record;
        const score = options.showScore ? ` score:${result.score.toFixed(2)} tokens:${result.matchedTokens.join(",") || "none"}` : "";
        console.log(`${record.id}\t[${record.scope}/${record.kind}]${score}\t${record.content}`);
      }
    });
  });

memory
  .command("list")
  .option("--limit <limit>", "Result limit", "20")
  .option("--all", "Show active and archived memories.", false)
  .description("List latest active long-term memories.")
  .action(async (options: { limit: string; all: boolean }) => {
    await main(async (workspaceRoot) => {
      const records = new MemoryManager(workspaceRoot).listMemories(Number.parseInt(options.limit, 10), options.all);
      if (!records.length) {
        console.log("No memories.");
        return;
      }
      for (const record of records) {
        console.log(`${record.id}\t${record.status}\t[${record.scope}/${record.kind}]\t${record.content}`);
      }
    });
  });

memory
  .command("show")
  .argument("<memory-id>")
  .description("Show one long-term memory.")
  .action(async (memoryId: string) => {
    await main(async (workspaceRoot) => {
      console.log(JSON.stringify(new MemoryManager(workspaceRoot).getMemory(memoryId), null, 2));
    });
  });

memory
  .command("update")
  .argument("<memory-id>")
  .option("--content <content>", "Memory content")
  .option("--kind <kind>", "Memory kind")
  .option("--scope <scope>", "Memory scope")
  .option("--owner-id <owner-id>", "Owner id")
  .option("--importance <importance>", "Memory importance from 1 to 5")
  .option("--confidence <confidence>", "Memory confidence from 0 to 1")
  .description("Update an active long-term memory.")
  .action(async (memoryId: string, options: { content?: string; kind?: string; scope?: string; ownerId?: string; importance?: string; confidence?: string }) => {
    await main(async (workspaceRoot) => {
      const record = new MemoryManager(workspaceRoot).updateMemory(memoryId, {
        content: options.content,
        kind: options.kind,
        scope: options.scope ? memoryScopeSchema.parse(options.scope) : undefined,
        ownerId: options.ownerId,
        importance: options.importance ? parseIntegerOption(options.importance, "importance") : undefined,
        confidence: options.confidence ? parseNumberOption(options.confidence, "confidence") : undefined
      });
      console.log(record.id);
    });
  });

memory
  .command("archive")
  .argument("<memory-id>")
  .requiredOption("--reason <reason>", "Archive reason")
  .description("Archive an active long-term memory.")
  .action(async (memoryId: string, options: { reason: string }) => {
    await main(async (workspaceRoot) => {
      const record = new MemoryManager(workspaceRoot).archiveMemory(memoryId, options.reason);
      console.log(`${record.id} archived`);
    });
  });

const candidate = memory.command("candidate").description("Review memory candidates.");

const promotion = memory.command("promotion").description("Review automatic memory promotions.");

candidate
  .command("list")
  .option("--all", "Show pending, promoted, discarded, and legacy candidates.", false)
  .description("List memory candidates.")
  .action(async (options: { all: boolean }) => {
    await main(async (workspaceRoot) => {
      const candidates = await new MemoryManager(workspaceRoot).listCandidates(options.all);
      if (!candidates.length) {
        console.log("No memory candidates.");
        return;
      }
      for (const candidate of candidates) {
        const record = candidate.record;
        const status = record?.status ?? "legacy";
        const scope = record?.scope ?? String(candidate.raw.scope ?? "unknown");
        const kind = record?.kind ?? String(candidate.raw.kind ?? "unknown");
        const content = record?.content ?? String(candidate.raw.content ?? JSON.stringify(candidate.raw));
        console.log(`${candidate.displayId}\t${status}\t[${scope}/${kind}]\t${content}`);
      }
      console.log("\nTip: candidate ids accept unique prefixes, e.g. `cosia memory candidate show d1ec6de4`.");
    });
  });

candidate
  .command("show")
  .argument("<candidate-id>")
  .description("Show one memory candidate.")
  .action(async (candidateId: string) => {
    await main(async (workspaceRoot) => {
      const candidate = await new MemoryManager(workspaceRoot).getCandidate(candidateId);
      console.log(JSON.stringify(candidate.record ?? candidate.raw, null, 2));
    });
  });

candidate
  .command("promote")
  .argument("[candidate-id]")
  .option("--force", "Promote even if conflicts are detected.", false)
  .option("--replace <memory-id>", "Archive an existing memory and promote this candidate.")
  .option("--merge <memory-id>", "Merge this candidate into an existing memory.")
  .option("--content <content>", "Merged memory content for --merge.")
  .option("--all-low-risk", "Promote all low-risk pending candidates with no conflicts.", false)
  .option("--yes", "Confirm a batch operation.", false)
  .description("Promote a pending memory candidate into long-term memory.")
  .action(async (candidateId: string | undefined, options: { force: boolean; replace?: string; merge?: string; content?: string; allLowRisk: boolean; yes: boolean }) => {
    await main(async (workspaceRoot) => {
      const manager = new MemoryManager(workspaceRoot);
      if (options.allLowRisk) {
        const summary = await manager.promoteAllLowRisk({ yes: options.yes });
        console.log(formatMemoryReviewSummary(summary));
        if (!options.yes) {
          console.log("\nNo changes made. Re-run with --yes to promote these candidates.");
        }
        return;
      }
      if (!candidateId) {
        throw new Error("candidate-id is required unless --all-low-risk is used.");
      }
      const record = await manager.promoteCandidate(candidateId, {
        force: options.force,
        replaceMemoryId: options.replace,
        mergeMemoryId: options.merge,
        mergeContent: options.content
      });
      console.log(record.id);
    });
  });

candidate
  .command("conflicts")
  .argument("<candidate-id>")
  .option("--json", "Print raw JSON conflict records.", false)
  .description("Show memory conflicts for one pending candidate.")
  .action(async (candidateId: string, options: { json: boolean }) => {
    await main(async (workspaceRoot) => {
      const result = await new MemoryManager(workspaceRoot).findCandidateConflicts(candidateId);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(formatMemoryConflicts(result.candidate, result.conflicts));
    });
  });

candidate
  .command("review")
  .option("--latest", "Review pending candidates from the latest run.", false)
  .option("--pending", "Review all pending candidates.", false)
  .description("Show risk and conflict review for memory candidates.")
  .action(async (options: { latest: boolean; pending: boolean }) => {
    await main(async (workspaceRoot) => {
      const manager = new MemoryManager(workspaceRoot);
      const reviews = await manager.reviewPendingCandidates({ latest: options.latest && !options.pending });
      console.log(formatMemoryReviewSummary({
        created: reviews.length,
        autoPromoted: 0,
        pending: reviews.length,
        conflicts: reviews.filter((review) => review.conflicts.length).length,
        reviews
      }));
    });
  });

candidate
  .command("discard")
  .argument("[candidate-id]")
  .requiredOption("--reason <reason>", "Discard reason")
  .option("--all-low-risk", "Discard all low-risk pending candidates with no conflicts.", false)
  .option("--yes", "Confirm a batch operation.", false)
  .description("Discard a pending memory candidate.")
  .action(async (candidateId: string | undefined, options: { reason: string; allLowRisk: boolean; yes: boolean }) => {
    await main(async (workspaceRoot) => {
      const manager = new MemoryManager(workspaceRoot);
      if (options.allLowRisk) {
        const summary = await manager.discardAllLowRisk(options.reason, { yes: options.yes });
        console.log(formatMemoryReviewSummary(summary));
        if (!options.yes) {
          console.log("\nNo changes made. Re-run with --yes to discard these candidates.");
        }
        return;
      }
      if (!candidateId) {
        throw new Error("candidate-id is required unless --all-low-risk is used.");
      }
      const record = await manager.discardCandidate(candidateId, options.reason);
      console.log(`${record.id} discarded`);
    });
  });

promotion
  .command("list")
  .option("--all", "Include reverted promotions.", false)
  .description("List automatic memory promotions.")
  .action(async (options: { all: boolean }) => {
    await main(async (workspaceRoot) => {
      const records = new MemoryManager(workspaceRoot).listPromotions(options.all);
      if (!records.length) {
        console.log("No auto promotions.");
        return;
      }
      for (const record of records) {
        const status = record.revertedAt ? "reverted" : "active";
        console.log(`${record.id}\t${status}\t${record.riskLevel}\tmem:${record.promotedMemoryId.slice(0, 8)}\tcandidate:${record.candidateId.slice(0, 8)}`);
      }
    });
  });

promotion
  .command("show")
  .argument("<promotion-id>")
  .description("Show one automatic memory promotion.")
  .action(async (promotionId: string) => {
    await main(async (workspaceRoot) => {
      console.log(JSON.stringify(new MemoryManager(workspaceRoot).getPromotion(promotionId), null, 2));
    });
  });

promotion
  .command("revert")
  .argument("<promotion-id>")
  .requiredOption("--reason <reason>", "Revert reason")
  .description("Archive the memory created by an automatic promotion.")
  .action(async (promotionId: string, options: { reason: string }) => {
    await main(async (workspaceRoot) => {
      const record = new MemoryManager(workspaceRoot).revertPromotion(promotionId, options.reason);
      console.log(`${record.id} reverted`);
    });
  });

const policy = program.command("policy").description("Inspect and maintain runtime policy.");

policy
  .command("show")
  .description("Show the active policy summary.")
  .action(async () => {
    await main(async (workspaceRoot) => {
      const manager = new PolicyManager(workspaceRoot);
      console.log(formatPolicySummary(await manager.loadPolicy()));
    });
  });

policy
  .command("check")
  .description("Validate policy JSON and Markdown mirror.")
  .action(async () => {
    await main(async (workspaceRoot) => {
      const result = await new PolicyManager(workspaceRoot).checkPolicy(true);
      if (result.created.length) {
        console.log(`Created: ${result.created.join(", ")}`);
      }
      console.log(`POLICY.json: ${result.jsonExists && result.jsonValid ? "ok" : "failed"}`);
      console.log(`POLICY.md: ${result.markdownExists && result.markdownMatches ? "ok" : "failed"}`);
      if (result.errors.length) {
        console.log(result.errors.map((error) => `- ${error}`).join("\n"));
      }
      if (!result.ok) {
        process.exitCode = 1;
      }
    });
  });

policy
  .command("sync")
  .description("Regenerate POLICY.md from POLICY.json.")
  .action(async () => {
    await main(async (workspaceRoot) => {
      await new PolicyManager(workspaceRoot).syncMarkdown();
      console.log("Synced codex/POLICY.md from codex/POLICY.json");
    });
  });

policy
  .command("audit")
  .requiredOption("--session <session-id>", "Session id")
  .option("--limit <limit>", "Result limit", "20")
  .option("--run-id <run-id>", "Show only events from one run id")
  .option("--latest-run", "Show only events from the latest run id", false)
  .option("--json", "Print raw JSON events.", false)
  .description("Show policy audit events for one session.")
  .action(async (options: { session: string; limit: string; runId?: string; latestRun: boolean; json: boolean }) => {
    await main(async (workspaceRoot) => {
      const events = await new PolicyAuditLog(workspaceRoot).list(options.session, {
        limit: Number.parseInt(options.limit, 10),
        runId: options.runId,
        latestRun: options.latestRun
      });
      if (!events.length) {
        console.log("No policy audit events.");
        return;
      }
      if (options.json) {
        for (const event of events) {
          console.log(JSON.stringify(event));
        }
        return;
      }
      console.log(formatPolicyAuditEvents(events));
    });
  });

program
  .command("run")
  .requiredOption("--session <session-id>", "Session id")
  .requiredOption("--prompt <prompt>", "Current user request")
  .option("--provider <provider>", "Model provider: codex-cli or mock")
  .option("--provider-timeout-ms <ms>", "Per Codex CLI provider call timeout in milliseconds", "120000")
  .option("--approve-overwrite", "Allow interactive overwrite approval prompts", false)
  .option("--require-tools", "Require at least one read_file or search_files call before final.", false)
  .description("Run a session turn.")
  .action(async (options: { session: string; prompt: string; provider?: string; providerTimeoutMs: string; approveOverwrite: boolean; requireTools: boolean }) => {
    await main(async (workspaceRoot) => {
      const content = await runSession(workspaceRoot, {
        sessionId: options.session,
        prompt: options.prompt,
        providerId: options.provider,
        providerTimeoutMs: Number.parseInt(options.providerTimeoutMs, 10),
        approveOverwriteFiles: options.approveOverwrite,
        requireTools: options.requireTools,
        onEvent: (message) => console.error(`[cosia] ${message}`)
      });
      console.log(content);
    });
  });

program
  .command("chat")
  .requiredOption("--session <session-id>", "Session id")
  .option("--provider <provider>", "Model provider: codex-cli or mock")
  .option("--provider-timeout-ms <ms>", "Per Codex CLI provider call timeout in milliseconds", "120000")
  .option("--approve-overwrite", "Allow interactive overwrite approval prompts", false)
  .option("--require-tools", "Require at least one read_file or search_files call before final.", false)
  .description("Enter a simple session REPL.")
  .action(async (options: { session: string; provider?: string; providerTimeoutMs: string; approveOverwrite: boolean; requireTools: boolean }) => {
    await main(async (workspaceRoot) => {
      const sessions = new SessionManager(workspaceRoot);
      const session = await sessions.loadSession(options.session);
      await sessions.ensureSessionSupportFiles(session.id);
      const agent = await new AgentManager(workspaceRoot).loadAgent(session.agentId);
      const policy = await new PolicyManager(workspaceRoot).loadPolicy();
      const memory = new MemoryManager(workspaceRoot);
      await memory.writeReferenceMemory(session, session.goal);
      const staticBlocks = await loadPromptStaticBlocks({ workspaceRoot, agent, session });
      const history: Array<{ prompt: string; response: string }> = [];
      let lastPrompt = session.goal;

      console.error(`[cosia] chat started: ${session.id}`);
      console.error("[cosia] commands: /status, /memory refresh, /exit");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        while (true) {
          const line = await rl.question("cosia> ");
          const prompt = line.trim();
          if (!prompt) {
            continue;
          }
          if (prompt === "/exit") {
            console.error(`[cosia] chat ended after ${history.length} turn(s).`);
            console.error(`[cosia] summary hint: cosia session summarize ${session.id} --content "<summary>"`);
            break;
          }
          if (prompt === "/status") {
            console.log(`Session: ${session.id}`);
            console.log(`Agent: ${session.agentId}`);
            console.log(`Provider: ${options.provider ?? policy.model.defaultProvider}`);
            console.log(`Prompt budget: ${policy.promptBudget.maxPromptChars} chars`);
            console.log(`Context tail: ${policy.promptBudget.contextTailChars} chars`);
            console.log(`Turns in this REPL: ${history.length}`);
            continue;
          }
          if (prompt === "/memory refresh") {
            await memory.writeReferenceMemory(session, lastPrompt);
            console.error(`[cosia] refreshed REF_MEMORY.md for ${session.id}`);
            continue;
          }

          let shouldRefreshMemory = false;
          const content = await runSession(workspaceRoot, {
            sessionId: session.id,
            prompt,
            providerId: options.provider,
            providerTimeoutMs: Number.parseInt(options.providerTimeoutMs, 10),
            approveOverwriteFiles: options.approveOverwrite,
            requireTools: options.requireTools,
            promptStaticBlocks: staticBlocks,
            refreshReferenceMemory: false,
            refreshReferenceMemoryAfterRun: false,
            onMemoryReview: (summary) => {
              shouldRefreshMemory = summary.autoPromoted > 0;
            },
            onEvent: (message) => console.error(`[cosia] ${message}`)
          });
          history.push({ prompt, response: content });
          lastPrompt = prompt;
          console.log(content);
          if (shouldRefreshMemory) {
            await memory.writeReferenceMemory(session, prompt);
            console.error("[cosia] refreshed REF_MEMORY.md after memory auto-promotion");
          }
        }
      } finally {
        rl.close();
      }
    });
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});

async function main(fn: (workspaceRoot: string) => Promise<void>, options: { allowUninitialized?: boolean } = {}): Promise<void> {
  try {
    const workspaceRoot = options.allowUninitialized
      ? await workspaceRootForInit(process.cwd())
      : await requireWorkspaceRoot(process.cwd());
    await fn(workspaceRoot);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

function parseIntegerOption(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function parseNumberOption(value: string, name: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}
