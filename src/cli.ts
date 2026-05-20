#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import {
  AgentManager,
  formatAgentDeleteResult,
  formatAgentRecommendation
} from "./runtime/agent_manager.js";
import { initProject } from "./runtime/init_project.js";
import { formatMemoryConflicts, formatMemoryReviewSummary, MemoryManager } from "./runtime/memory_manager.js";
import { checkProvider, listProviders } from "./runtime/model/provider_registry.js";
import { formatPolicyAuditEvents, PolicyAuditLog } from "./runtime/policy_audit.js";
import { formatPolicySummary, PolicyManager } from "./runtime/policy_manager.js";
import { loadPromptStaticBlocks, type PromptManifest } from "./runtime/prompt_builder.js";
import { runSession } from "./runtime/runner.js";
import { SessionManager } from "./runtime/session_manager.js";
import { formatSkillCandidate, formatSkillCheckResult, formatSkillMigrationResult, formatSkillPromotionPreview, formatSkillSelectionExplanation, SkillManager } from "./runtime/skill_manager.js";
import { getStatusReport } from "./runtime/status_report.js";
import { ToolRegistry } from "./runtime/tool_registry.js";
import { memoryScopeSchema, memoryTierSchema } from "./runtime/types.js";
import type { MemoryScope, MemoryTier, SessionMetadata, ToolName } from "./runtime/types.js";
import { COSIA_VERSION } from "./runtime/version.js";
import { requireWorkspaceRoot, workspaceRootForInit } from "./runtime/workspace.js";

const program = new Command();

program
  .name("cosia")
  .description("COSIA: Codex-Oriented Self-Improving Agent Runtime CLI MVP")
  .version(COSIA_VERSION);

program
  .command("status")
  .option("--provider <provider>", "Model provider smoke check: default, codex-cli, openai-compatible, or mock", "default")
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
      console.log(`Context warnings: ${report.contextWarningCount}`);
      console.log(`Context critical: ${report.contextCriticalCount}`);
      if (report.largestContext) {
        console.log(`Largest context: ${formatContextHealth(report.largestContext)}`);
      }
      console.log(`Provider: ${report.providerId} (${report.providerOk ? "ok" : "failed"})`);
      console.log(`Provider message: ${report.providerMessage}`);
      if (report.providerReason) {
        console.log(`Provider reason: ${report.providerReason}`);
      }
      if (report.providerHint) {
        console.log(`Provider hint: ${report.providerHint}`);
      }
    });
  });

const providerCommand = program.command("provider").description("Inspect model providers.");

providerCommand
  .command("list")
  .description("List configured model providers.")
  .action(async () => {
    await main(async (workspaceRoot) => {
      const policy = await new PolicyManager(workspaceRoot).loadPolicy();
      console.log("Provider              Type               Default  Enabled  Timeout  Retry  MaxPrompt  Model  BaseUrl  API Key Env");
      for (const item of listProviders(policy)) {
        console.log([
          item.id.padEnd(21),
          String(item.type ?? (item.builtIn ? "built-in" : "-")).padEnd(18),
          String(item.isDefault).padEnd(7),
          String(item.enabled).padEnd(7),
          String(item.timeoutMs ?? "-").padEnd(7),
          String(item.structuredRetryCount ?? "-").padEnd(5),
          String(item.maxPromptChars ?? "-").padEnd(9),
          String(item.modelConfigured ?? "-").padEnd(5),
          String(item.baseUrlConfigured ?? "-").padEnd(7),
          item.apiKeyEnv ?? (item.builtIn ? "built-in" : "-")
        ].join("  "));
      }
    });
  });

providerCommand
  .command("check")
  .argument("<provider-id>")
  .description("Check a provider configuration and auth status.")
  .action(async (providerId: string) => {
    await main(async (workspaceRoot) => {
      const policy = await new PolicyManager(workspaceRoot).loadPolicy();
      const result = await checkProvider(providerId, workspaceRoot, policy);
      console.log(`Provider: ${result.id}`);
      console.log(`Status: ${result.ok ? "ok" : "failed"}`);
      console.log(`Message: ${result.message}`);
      if (result.reason) {
        console.log(`Reason: ${result.reason}`);
      }
      if (result.hint) {
        console.log(`Hint: ${result.hint}`);
      }
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
  .option("--template <template>", "Agent template: cosia or architect", "architect")
  .description("Create an agent from a template.")
  .action(async (agentId: string, options: { template: string }) => {
    await main(async (workspaceRoot) => {
      const manager = new AgentManager(workspaceRoot);
      const manifest = await manager.createAgent(agentId, options.template);
      console.log(`Created agent ${manifest.id}`);
    });
  });

agent
  .command("list")
  .description("List agents.")
  .action(async () => {
    await main(async (workspaceRoot) => {
      const policy = await new PolicyManager(workspaceRoot).loadPolicy();
      const agents = await new AgentManager(workspaceRoot).listAgents();
      if (!agents.length) {
        console.log("No agents. Run `cosia agent bootstrap` to create one.");
        return;
      }
      for (const item of agents) {
        const marker = item.id === policy.agents.defaultAgentId ? "default" : "available";
        console.log(`${item.id}\t${marker}\t${item.name}\t${item.identity.role}`);
      }
    });
  });

agent
  .command("show")
  .argument("<agent-id>")
  .description("Show agent identity, selection triggers, tools, and skill preferences.")
  .action(async (agentId: string) => {
    await main(async (workspaceRoot) => {
      const agent = await new AgentManager(workspaceRoot).loadAgent(agentId);
      console.log(JSON.stringify({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        identity: agent.identity,
        selectionTriggers: agent.selectionTriggers,
        allowedTools: agent.allowedTools,
        preferredSkills: agent.preferredSkills,
        blockedSkills: agent.blockedSkills,
        skillWeights: agent.skillWeights
      }, null, 2));
    });
  });

const agentDefault = agent.command("default").description("Manage the default agent.");

agentDefault
  .command("show")
  .description("Show the current default agent.")
  .action(async () => {
    await main(async (workspaceRoot) => {
      const policy = await new PolicyManager(workspaceRoot).loadPolicy();
      console.log(policy.agents.defaultAgentId ?? "No default agent. Run `cosia agent bootstrap` to create one.");
    });
  });

agentDefault
  .command("set")
  .argument("<agent-id>")
  .description("Set the default agent.")
  .action(async (agentId: string) => {
    await main(async (workspaceRoot) => {
      await new AgentManager(workspaceRoot).loadAgent(agentId);
      await new PolicyManager(workspaceRoot).setDefaultAgent(agentId);
      console.log(`Default agent set to ${agentId}`);
    });
  });

agent
  .command("bootstrap")
  .option("--id <agent-id>", "Agent id")
  .option("--name <name>", "Display name")
  .option("--role <role>", "Agent role")
  .option("--voice <voice>", "Agent voice")
  .option("--priorities <items>", "Comma-separated priorities")
  .option("--boundaries <items>", "Comma-separated boundaries")
  .description("Create a new guided agent and set it as the default.")
  .action(async (options: { id?: string; name?: string; role?: string; voice?: string; priorities?: string; boundaries?: string }) => {
    await main(async (workspaceRoot) => {
      const answers = await resolveBootstrapOptions(options);
      const manager = new AgentManager(workspaceRoot);
      const manifest = await manager.bootstrapAgent({
        id: answers.id,
        name: answers.name,
        role: answers.role,
        voice: answers.voice,
        priorities: splitList(answers.priorities),
        boundaries: splitList(answers.boundaries)
      });
      await new PolicyManager(workspaceRoot).setDefaultAgent(manifest.id);
      console.log(`Bootstrapped agent ${manifest.id}`);
      console.log(`Default agent set to ${manifest.id}`);
    });
  });

agent
  .command("delete")
  .argument("<agent-id>")
  .option("--yes", "Actually delete the agent.", false)
  .option("--force", "Allow deleting agents referenced by sessions.", false)
  .option("--allow-empty", "Allow deleting the default or last agent.", false)
  .description("Preview or delete an agent.")
  .action(async (agentId: string, options: { yes: boolean; force: boolean; allowEmpty: boolean }) => {
    await main(async (workspaceRoot) => {
      const policyManager = new PolicyManager(workspaceRoot);
      const policy = await policyManager.loadPolicy();
      const result = await new AgentManager(workspaceRoot).deleteAgent(agentId, {
        yes: options.yes,
        force: options.force,
        allowEmpty: options.allowEmpty,
        defaultAgentId: policy.agents.defaultAgentId
      });
      if (result.changed && result.isDefault) {
        await policyManager.setDefaultAgent(null);
      }
      if (result.changed) {
        const archived = new MemoryManager(workspaceRoot).archiveOwnerMemories("agent", agentId, `Agent deleted: ${agentId}`);
        if (archived) {
          console.log(`Archived ${archived} agent memory record(s).`);
        }
      }
      console.log(formatAgentDeleteResult(result));
      if (result.changed && result.isDefault) {
        console.log("No default agent is configured. Run `cosia agent bootstrap` to create one.");
      }
    });
  });

agent
  .command("recommend")
  .requiredOption("--prompt <prompt>", "Current request")
  .option("--goal <goal>", "Optional session goal", "")
  .option("--explain", "Show deterministic scoring table.", false)
  .description("Recommend an agent for a prompt without changing session state.")
  .action(async (options: { prompt: string; goal: string; explain: boolean }) => {
    await main(async (workspaceRoot) => {
      const policy = await new PolicyManager(workspaceRoot).loadPolicy();
      const rows = await new AgentManager(workspaceRoot).recommendAgent({
        prompt: options.prompt,
        goal: options.goal,
        defaultAgentId: policy.agents.defaultAgentId
      });
      if (options.explain) {
        console.log(formatAgentRecommendation(rows));
      } else {
        console.log(rows[0]?.agentId ?? "No agents. Run `cosia agent bootstrap` to create one.");
      }
    });
  });

agent
  .command("sessions")
  .argument("<agent-id>")
  .description("List sessions currently assigned to an agent.")
  .action(async (agentId: string) => {
    await main(async (workspaceRoot) => {
      await new AgentManager(workspaceRoot).loadAgent(agentId);
      const sessions = await new SessionManager(workspaceRoot).listSessions({ agentId });
      if (!sessions.length) {
        console.log(`No sessions assigned to ${agentId}.`);
        return;
      }
      await printSessionList(workspaceRoot, sessions);
    });
  });

const session = program.command("session").description("Manage sessions.");

session
  .command("create")
  .option("--agent <agent-id>", "Agent id. Defaults to policy agents.defaultAgentId.")
  .requiredOption("--goal <goal>", "Session goal")
  .description("Create a session for an agent.")
  .action(async (options: { agent?: string; goal: string }) => {
    await main(async (workspaceRoot) => {
      const agents = new AgentManager(workspaceRoot);
      const policy = await new PolicyManager(workspaceRoot).loadPolicy();
      const agentId = options.agent ?? policy.agents.defaultAgentId;
      if (!agentId) {
        throw new Error("No default agent is configured. Run `cosia agent bootstrap` or pass --agent <agent-id>.");
      }
      await agents.loadAgent(agentId);
      const sessions = new SessionManager(workspaceRoot);
      const metadata = await sessions.createSession(agentId, options.goal);
      console.log(metadata.id);
    });
  });

session
  .command("list")
  .option("--agent <agent-id>", "Only show sessions assigned to this agent.")
  .description("List sessions.")
  .action(async (options: { agent?: string }) => {
    await main(async (workspaceRoot) => {
      const sessions = await new SessionManager(workspaceRoot).listSessions({ agentId: options.agent });
      if (!sessions.length) {
        console.log("No sessions.");
        return;
      }
      await printSessionList(workspaceRoot, sessions);
    });
  });

session
  .command("assign")
  .argument("<session-id>")
  .requiredOption("--agent <agent-id>", "Agent id to assign.")
  .description("Assign a session to an existing agent.")
  .action(async (sessionId: string, options: { agent: string }) => {
    await main(async (workspaceRoot) => {
      await new AgentManager(workspaceRoot).loadAgent(options.agent);
      const metadata = await new SessionManager(workspaceRoot).assignAgent(sessionId, options.agent);
      console.log(`Assigned ${metadata.id} to ${metadata.assignedAgentId}`);
    });
  });

session
  .command("unassign")
  .argument("<session-id>")
  .description("Remove a session's assigned agent.")
  .action(async (sessionId: string) => {
    await main(async (workspaceRoot) => {
      const metadata = await new SessionManager(workspaceRoot).assignAgent(sessionId, null);
      console.log(`Unassigned ${metadata.id}`);
    });
  });

session
  .command("archive")
  .argument("<session-id>")
  .requiredOption("--reason <reason>", "Archive reason")
  .description("Archive a session and its session-tier memories.")
  .action(async (sessionId: string, options: { reason: string }) => {
    await main(async (workspaceRoot) => {
      const sessions = new SessionManager(workspaceRoot);
      const metadata = await sessions.archiveSession(sessionId);
      const archived = new MemoryManager(workspaceRoot).archiveOwnerMemories("session", sessionId, `Session archived: ${options.reason}`);
      console.log(`Archived session ${metadata.id}`);
      console.log(`Archived ${archived} session memory record(s).`);
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
      const policy = await new PolicyManager(workspaceRoot).loadPolicy();
      const contextHealth = await sessions.contextHealth(sessionId, {
        warningChars: policy.promptBudget.contextWarningChars,
        criticalChars: policy.promptBudget.contextCriticalChars
      });
      console.log(JSON.stringify(metadata, null, 2));
      console.log(`\n# CONTEXT STATUS\n`);
      console.log(formatContextHealth(contextHealth));
      if (contextHealth.level === "critical") {
        console.log(contextCriticalHint(sessionId));
      }
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

session
  .command("prompt")
  .argument("<session-id>")
  .option("--latest", "Show only the latest prompt manifest.", false)
  .option("--limit <n>", "Prompt manifest count", "1")
  .description("Show readable prompt budget manifests for a session.")
  .action(async (sessionId: string, options: { latest: boolean; limit: string }) => {
    await main(async (workspaceRoot) => {
      const sessions = new SessionManager(workspaceRoot);
      await sessions.loadSession(sessionId);
      const limit = options.latest ? 1 : parseIntegerOption(options.limit, "limit");
      const manifests = await sessions.listPromptManifests(sessionId, limit);
      if (!manifests.length) {
        console.log("No prompt manifests.");
        return;
      }
      console.log(manifests.map(formatPromptManifest).join("\n\n"));
    });
  });

const sessionContext = session.command("context").description("Manage session context memory.");

sessionContext
  .command("undo-last")
  .argument("<session-id>")
  .requiredOption("--reason <reason>", "Archive reason")
  .description("Move the latest context run entry into CONTEXT_ARCHIVE.md.")
  .action(async (sessionId: string, options: { reason: string }) => {
    await main(async (workspaceRoot) => {
      const sessions = new SessionManager(workspaceRoot);
      await sessions.loadSession(sessionId);
      const result = await sessions.undoLastContextEntry(sessionId, options.reason);
      console.log(result.message);
      if (result.moved) {
        console.log(`Moved at: ${result.movedAt}`);
        console.log("Archive: CONTEXT_ARCHIVE.md");
      }
    });
  });

const memory = program.command("memory").description("Manage long-term memory.");

memory
  .command("add")
  .option("--tier <tier>", "Memory tier: core, agent, or session")
  .option("--scope <scope>", "Deprecated memory scope alias")
  .requiredOption("--content <content>", "Memory content")
  .option("--kind <kind>", "Memory kind", "note")
  .option("--owner-id <owner-id>", "Owner id")
  .option("--importance <importance>", "Memory importance from 1 to 5", "3")
  .option("--confidence <confidence>", "Memory confidence from 0 to 1", "0.7")
  .description("Add an explicit long-term memory.")
  .action(async (options: { tier?: string; scope?: string; content: string; kind: string; ownerId?: string; importance: string; confidence: string }) => {
    await main(async (workspaceRoot) => {
      const ownership = await resolveMemoryTierOptions(workspaceRoot, options, true);
      const manager = new MemoryManager(workspaceRoot);
      const record = manager.addMemory({
        tier: ownership.tier,
        scope: ownership.scope,
        content: options.content,
        kind: options.kind,
        ownerId: ownership.ownerId ?? undefined,
        importance: parseIntegerOption(options.importance, "importance"),
        confidence: parseNumberOption(options.confidence, "confidence")
      });
      console.log(record.id);
    });
  });

memory
  .command("search")
  .requiredOption("--query <query>", "Search query")
  .option("--tier <tier>", "Filter by memory tier")
  .option("--owner-id <owner-id>", "Filter by owner id")
  .option("--limit <limit>", "Result limit", "8")
  .option("--show-score", "Show memory search scores.", false)
  .description("Search explicit long-term memory.")
  .action(async (options: { query: string; tier?: string; ownerId?: string; limit: string; showScore: boolean }) => {
    await main(async (workspaceRoot) => {
      const manager = new MemoryManager(workspaceRoot);
      const tier = options.tier ? memoryTierSchema.parse(options.tier) : undefined;
      const results = manager.search(options.query, Number.parseInt(options.limit, 10), { tier, ownerId: options.ownerId });
      if (!results.length) {
        console.log("No matches.");
        return;
      }
      for (const result of results) {
        const record = result.record;
        const score = options.showScore ? ` score:${result.score.toFixed(2)} tokens:${result.matchedTokens.join(",") || "none"}` : "";
        console.log(`${record.id}\t[${record.tier}/${record.kind}]${score}\t${record.content}`);
      }
    });
  });

memory
  .command("list")
  .option("--tier <tier>", "Filter by memory tier")
  .option("--owner-id <owner-id>", "Filter by owner id")
  .option("--limit <limit>", "Result limit", "20")
  .option("--all", "Show active and archived memories.", false)
  .description("List latest active long-term memories.")
  .action(async (options: { tier?: string; ownerId?: string; limit: string; all: boolean }) => {
    await main(async (workspaceRoot) => {
      const tier = options.tier ? memoryTierSchema.parse(options.tier) : undefined;
      const records = new MemoryManager(workspaceRoot).listMemories(Number.parseInt(options.limit, 10), options.all, {
        tier,
        ownerId: options.ownerId
      });
      if (!records.length) {
        console.log("No memories.");
        return;
      }
      for (const record of records) {
        console.log(`${record.id}\t${record.status}\t[${record.tier}/${record.kind}]\t${record.content}`);
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
  .option("--tier <tier>", "Memory tier")
  .option("--scope <scope>", "Deprecated memory scope alias")
  .option("--owner-id <owner-id>", "Owner id")
  .option("--importance <importance>", "Memory importance from 1 to 5")
  .option("--confidence <confidence>", "Memory confidence from 0 to 1")
  .description("Update an active long-term memory.")
  .action(async (memoryId: string, options: { content?: string; kind?: string; tier?: string; scope?: string; ownerId?: string; importance?: string; confidence?: string }) => {
    await main(async (workspaceRoot) => {
      const ownership = (options.tier || options.scope || options.ownerId)
        ? await resolveMemoryTierOptions(workspaceRoot, options, false)
        : {};
      const record = new MemoryManager(workspaceRoot).updateMemory(memoryId, {
        content: options.content,
        kind: options.kind,
        tier: ownership.tier,
        scope: ownership.scope,
        ownerId: ownership.ownerId ?? undefined,
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

memory
  .command("promote")
  .argument("<memory-id>")
  .option("--to-tier <tier>", "Target memory tier: agent or core")
  .option("--to-skill-candidate", "Create a skill candidate from core memory.", false)
  .option("--skill-name <name>", "Skill candidate name for --to-skill-candidate")
  .option("--owner-id <owner-id>", "Target owner id")
  .requiredOption("--reason <reason>", "Promotion reason")
  .option("--content <content>", "Promoted or merged content")
  .option("--kind <kind>", "Promoted memory kind")
  .option("--importance <importance>", "Promoted memory importance from 1 to 5")
  .option("--confidence <confidence>", "Promoted memory confidence from 0 to 1")
  .option("--force", "Promote even if conflicts are detected.", false)
  .option("--replace <memory-id>", "Archive an existing target memory and promote this memory.")
  .option("--merge <memory-id>", "Merge this memory into an existing target memory.")
  .description("Promote memory across lifecycle tiers or into a skill candidate.")
  .action(async (memoryId: string, options: {
    toTier?: string;
    toSkillCandidate: boolean;
    skillName?: string;
    ownerId?: string;
    reason: string;
    content?: string;
    kind?: string;
    importance?: string;
    confidence?: string;
    force: boolean;
    replace?: string;
    merge?: string;
  }) => {
    await main(async (workspaceRoot) => {
      const manager = new MemoryManager(workspaceRoot);
      if (options.toSkillCandidate) {
        if (options.toTier) {
          throw new Error("Use either --to-tier or --to-skill-candidate, not both.");
        }
        if (!options.skillName?.trim()) {
          throw new Error("--skill-name is required with --to-skill-candidate.");
        }
        const result = manager.promoteCoreMemoryToSkillCandidate(memoryId, {
          skillName: options.skillName,
          reason: options.reason,
          content: options.content
        });
        console.log(`Skill candidate: ${result.candidate.id}`);
        console.log(`Promotion: ${result.promotion.id}`);
        return;
      }
      if (!options.toTier) {
        throw new Error("Use --to-tier agent|core or --to-skill-candidate.");
      }
      const toTier = memoryTierSchema.parse(options.toTier);
      if (toTier === "session") {
        throw new Error("Memory promotion to session tier is not supported.");
      }
      if (toTier === "agent") {
        await new AgentManager(workspaceRoot).loadAgent(options.ownerId ?? "");
      }
      const record = manager.promoteMemory(memoryId, {
        toTier,
        ownerId: options.ownerId,
        reason: options.reason,
        content: options.content,
        kind: options.kind,
        importance: options.importance ? parseIntegerOption(options.importance, "importance") : undefined,
        confidence: options.confidence ? parseNumberOption(options.confidence, "confidence") : undefined,
        force: options.force,
        replaceMemoryId: options.replace,
        mergeMemoryId: options.merge
      });
      console.log(`Promotion: ${record.id}`);
      console.log(`Target memory: ${record.targetMemoryId}`);
    });
  });

const candidate = memory.command("candidate").description("Review memory candidates.");

const promotion = memory.command("promotion").description("Review automatic memory promotions.");

candidate
  .command("export")
  .option("--jsonl", "Print JSONL export.", false)
  .description("Export memory candidates from the SQLite queue.")
  .action(async (options: { jsonl: boolean }) => {
    await main(async (workspaceRoot) => {
      if (!options.jsonl) {
        throw new Error("Only --jsonl export is supported.");
      }
      process.stdout.write(new MemoryManager(workspaceRoot).exportCandidatesJsonl());
    });
  });

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
        const tier = record?.tier ?? String(candidate.raw.tier ?? candidate.raw.scope ?? "unknown");
        const kind = record?.kind ?? String(candidate.raw.kind ?? "unknown");
        const content = record?.content ?? String(candidate.raw.content ?? JSON.stringify(candidate.raw));
        console.log(`${candidate.displayId}\t${status}\t[${tier}/${kind}]\t${content}`);
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
  .command("export")
  .option("--jsonl", "Print JSONL export.", false)
  .description("Export automatic memory promotions from the SQLite queue.")
  .action(async (options: { jsonl: boolean }) => {
    await main(async (workspaceRoot) => {
      if (!options.jsonl) {
        throw new Error("Only --jsonl export is supported.");
      }
      process.stdout.write(new MemoryManager(workspaceRoot).exportPromotionsJsonl());
    });
  });

promotion
  .command("list")
  .option("--all", "Include reverted promotions.", false)
  .option("--type <type>", "Promotion type: auto or tier", "auto")
  .description("List automatic or tier memory promotions.")
  .action(async (options: { all: boolean; type: string }) => {
    await main(async (workspaceRoot) => {
      const manager = new MemoryManager(workspaceRoot);
      if (options.type === "tier") {
        const records = manager.listTierPromotions(options.all);
        if (!records.length) {
          console.log("No tier promotions.");
          return;
        }
        for (const record of records) {
          const status = record.revertedAt ? "reverted" : "active";
          console.log(`${record.id}\t${status}\t${record.fromTier}->${record.toTier}\t${record.mode}\ttarget:${record.targetMemoryId.slice(0, 8)}`);
        }
        return;
      }
      if (options.type !== "auto") {
        throw new Error("Promotion type must be auto or tier.");
      }
      const records = manager.listPromotions(options.all);
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
  .description("Show one automatic or tier memory promotion.")
  .action(async (promotionId: string) => {
    await main(async (workspaceRoot) => {
      const manager = new MemoryManager(workspaceRoot);
      try {
        console.log(JSON.stringify(manager.getPromotion(promotionId), null, 2));
      } catch {
        console.log(JSON.stringify(manager.getTierPromotion(promotionId), null, 2));
      }
    });
  });

promotion
  .command("revert")
  .argument("<promotion-id>")
  .requiredOption("--reason <reason>", "Revert reason")
  .description("Revert an automatic or tier memory promotion.")
  .action(async (promotionId: string, options: { reason: string }) => {
    await main(async (workspaceRoot) => {
      const manager = new MemoryManager(workspaceRoot);
      try {
        const record = manager.revertPromotion(promotionId, options.reason);
        console.log(`${record.id} reverted`);
      } catch {
        const record = manager.revertTierPromotion(promotionId, options.reason);
        console.log(`${record.id} reverted`);
      }
    });
  });

const skill = program.command("skill").description("Manage global skills and agent skill preferences.");

const skillCandidate = skill.command("candidate").description("Review skill candidates.");

skillCandidate
  .command("list")
  .option("--all", "Show pending, promoted, and discarded candidates.", false)
  .description("List skill candidates.")
  .action(async (options: { all: boolean }) => {
    await main(async (workspaceRoot) => {
      const candidates = new SkillManager(workspaceRoot).listCandidates(options.all);
      if (!candidates.length) {
        console.log("No skill candidates.");
        return;
      }
      for (const candidate of candidates) {
        console.log(formatSkillCandidate(candidate.record));
      }
      console.log("\nTip: skill candidate ids accept unique prefixes.");
    });
  });

skillCandidate
  .command("show")
  .argument("<candidate-id>")
  .description("Show one skill candidate.")
  .action(async (candidateId: string) => {
    await main(async (workspaceRoot) => {
      console.log(JSON.stringify(new SkillManager(workspaceRoot).getCandidate(candidateId).record, null, 2));
    });
  });

skillCandidate
  .command("promote")
  .argument("<candidate-id>")
  .option("--yes", "Apply the promotion after preview.", false)
  .option("--prefer-for <agent-id>", "Add the promoted global skill to one agent's preferredSkills.")
  .option("--confirm-high-risk <phrase>", "Required phrase for high-risk skill promotion.")
  .description("Preview or promote a skill candidate into the global skill toolbox.")
  .action(async (candidateId: string, options: { yes: boolean; preferFor?: string; confirmHighRisk?: string }) => {
    await main(async (workspaceRoot) => {
      const result = new SkillManager(workspaceRoot).promoteCandidate(candidateId, {
        yes: options.yes,
        preferFor: options.preferFor,
        confirmHighRisk: options.confirmHighRisk
      });
      console.log(formatSkillPromotionPreview(result));
    });
  });

skillCandidate
  .command("discard")
  .argument("<candidate-id>")
  .requiredOption("--reason <reason>", "Discard reason")
  .description("Discard a pending skill candidate.")
  .action(async (candidateId: string, options: { reason: string }) => {
    await main(async (workspaceRoot) => {
      const record = new SkillManager(workspaceRoot).discardCandidate(candidateId, options.reason);
      console.log(`${record.id} discarded`);
    });
  });

skillCandidate
  .command("export")
  .option("--jsonl", "Print JSONL export.", false)
  .description("Export skill candidates from SQLite.")
  .action(async (options: { jsonl: boolean }) => {
    await main(async (workspaceRoot) => {
      if (!options.jsonl) {
        throw new Error("Only --jsonl export is supported.");
      }
      process.stdout.write(new SkillManager(workspaceRoot).exportCandidatesJsonl());
    });
  });

skill
  .command("list")
  .option("--agent <agent-id>", "Show one agent's preference view over global skills.")
  .description("List global skills.")
  .action(async (options: { agent?: string }) => {
    await main(async (workspaceRoot) => {
      const manager = new SkillManager(workspaceRoot);
      const skills = manager.listSkills();
      if (!skills.length) {
        console.log("No global skills.");
        return;
      }
      const agent = options.agent ? await new AgentManager(workspaceRoot).loadAgent(options.agent) : undefined;
      for (const item of skills) {
        const state = agent?.blockedSkills.includes(item.id)
          ? "blocked"
          : agent?.preferredSkills.includes(item.id)
            ? "preferred"
            : "available";
        const weight = agent?.skillWeights?.[item.id] ? ` weight:${agent.skillWeights[item.id]}` : "";
        console.log(`${item.id}\t${options.agent ? state : item.riskLevel}${weight}\t${item.manualOnly ? "manual-only" : `triggers:${item.triggers.join(",")}`}\t${item.path}`);
      }
    });
  });

skill
  .command("show")
  .argument("<skill-id>")
  .option("--agent <agent-id>", "Include one agent's preference state.")
  .description("Show one global skill.")
  .action(async (skillId: string, options: { agent?: string }) => {
    await main(async (workspaceRoot) => {
      const manager = new SkillManager(workspaceRoot);
      const skill = manager.getSkill(skillId);
      const agent = options.agent ? await new AgentManager(workspaceRoot).loadAgent(options.agent) : undefined;
      const state = agent
        ? agent.blockedSkills.includes(skill.id)
          ? "blocked"
          : agent.preferredSkills.includes(skill.id)
            ? "preferred"
            : "available"
        : "global";
      console.log(`# ${skill.id}\n\nName: ${skill.name}\nRisk: ${skill.riskLevel}\nTriggers: ${skill.triggers.length ? skill.triggers.join(", ") : "manual-only"}\nState: ${state}\nPath: ${skill.path}\nMetadata: ${skill.metadataPath}\n\n${skill.content}`);
    });
  });

skill
  .command("check")
  .option("--agent <agent-id>", "Check one agent's generated skill preference view.")
  .option("--repair", "Regenerate SKILLS.md when it is missing or stale.", false)
  .description("Validate the global skill mirror and optional agent skill view.")
  .action(async (options: { agent?: string; repair: boolean }) => {
    await main(async (workspaceRoot) => {
      const result = new SkillManager(workspaceRoot).checkSkills(options.agent, options.repair);
      console.log(formatSkillCheckResult(result));
      if (!result.ok) {
        process.exitCode = 1;
      }
    });
  });

skill
  .command("sync")
  .argument("[agent-id]")
  .description("Regenerate global SKILLS.md, or an agent skill preference view when agent-id is provided.")
  .action(async (agentId: string | undefined) => {
    await main(async (workspaceRoot) => {
      const path = new SkillManager(workspaceRoot).syncSkillsIndex(agentId);
      console.log(`Synced ${path}`);
    });
  });

skill
  .command("prefer")
  .argument("<skill-id>")
  .requiredOption("--agent <agent-id>", "Agent id")
  .option("--weight <0-5>", "Optional agent-specific skill weight.")
  .description("Mark a global skill as preferred by an agent.")
  .action(async (skillId: string, options: { agent: string; weight?: string }) => {
    await main(async (workspaceRoot) => {
      new SkillManager(workspaceRoot).preferSkill(
        skillId,
        options.agent,
        options.weight === undefined ? undefined : parseIntegerOption(options.weight, "weight")
      );
      console.log(`Preferred ${skillId} for ${options.agent}`);
    });
  });

skill
  .command("unprefer")
  .argument("<skill-id>")
  .requiredOption("--agent <agent-id>", "Agent id")
  .description("Remove one agent's preference for a global skill.")
  .action(async (skillId: string, options: { agent: string }) => {
    await main(async (workspaceRoot) => {
      new SkillManager(workspaceRoot).unpreferSkill(skillId, options.agent);
      console.log(`Unpreferred ${skillId} for ${options.agent}`);
    });
  });

skill
  .command("block")
  .argument("<skill-id>")
  .requiredOption("--agent <agent-id>", "Agent id")
  .description("Block a global skill for one agent.")
  .action(async (skillId: string, options: { agent: string }) => {
    await main(async (workspaceRoot) => {
      new SkillManager(workspaceRoot).blockSkill(skillId, options.agent);
      console.log(`Blocked ${skillId} for ${options.agent}`);
    });
  });

skill
  .command("unblock")
  .argument("<skill-id>")
  .requiredOption("--agent <agent-id>", "Agent id")
  .description("Unblock a global skill for one agent.")
  .action(async (skillId: string, options: { agent: string }) => {
    await main(async (workspaceRoot) => {
      new SkillManager(workspaceRoot).unblockSkill(skillId, options.agent);
      console.log(`Unblocked ${skillId} for ${options.agent}`);
    });
  });

skill
  .command("select")
  .requiredOption("--agent <agent-id>", "Agent id")
  .requiredOption("--prompt <prompt>", "Current request to score.")
  .option("--goal <goal>", "Session goal for trigger scoring.", "")
  .option("--skill <skill-id...>", "Manually selected skills.")
  .option("--explain", "Print compact selection score table.", false)
  .description("Explain deterministic skill selection for a prompt.")
  .action(async (options: { agent: string; prompt: string; goal: string; skill?: string[]; explain: boolean }) => {
    await main(async (workspaceRoot) => {
      const agent = await new AgentManager(workspaceRoot).loadAgent(options.agent);
      const policy = await new PolicyManager(workspaceRoot).loadPolicy();
      const rows = new SkillManager(workspaceRoot).explainSkillSelection({
        agent,
        sessionGoal: options.goal,
        currentRequest: options.prompt,
        manualSkillIds: options.skill,
        budget: {
          skillMaxItems: policy.promptBudget.skillMaxItems,
          skillMaxChars: policy.promptBudget.skillMaxChars,
          skillItemMaxChars: policy.promptBudget.skillItemMaxChars
        }
      });
      console.log(formatSkillSelectionExplanation(rows));
    });
  });

skill
  .command("migrate")
  .requiredOption("--agent <agent-id>", "Agent id")
  .option("--yes", "Apply the migration after preview.", false)
  .description("Preview or migrate legacy agent-local skills into the global skill toolbox.")
  .action(async (options: { agent: string; yes: boolean }) => {
    await main(async (workspaceRoot) => {
      const result = new SkillManager(workspaceRoot).migrateAgentSkills(options.agent, options.yes);
      console.log(formatSkillMigrationResult(result));
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
  .option("--repair", "Regenerate POLICY.md when it is missing or stale.", false)
  .description("Validate policy JSON and Markdown mirror.")
  .action(async (options: { repair: boolean }) => {
    await main(async (workspaceRoot) => {
      const result = await new PolicyManager(workspaceRoot).checkPolicy(true, options.repair);
      if (result.created.length) {
        console.log(`Created: ${result.created.join(", ")}`);
      }
      if (result.repaired.length) {
        console.log(`Repaired: ${result.repaired.join(", ")}`);
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

const tool = program.command("tool").description("Run policy-gated local tools.");

tool
  .command("git-status")
  .description("Show git status through the Tool Registry.")
  .action(async () => {
    await main(async (workspaceRoot) => {
      await runCliTool(workspaceRoot, "git_status", {});
    });
  });

tool
  .command("git-diff")
  .option("--path <path>", "Workspace path to diff")
  .option("--staged", "Show staged diff", false)
  .description("Show git diff through the Tool Registry.")
  .action(async (options: { path?: string; staged: boolean }) => {
    await main(async (workspaceRoot) => {
      await runCliTool(workspaceRoot, "git_diff", {
        path: options.path,
        staged: options.staged
      });
    });
  });

tool
  .command("git-log")
  .option("--max-count <n>", "Commit count", "20")
  .description("Show git log through the Tool Registry.")
  .action(async (options: { maxCount: string }) => {
    await main(async (workspaceRoot) => {
      await runCliTool(workspaceRoot, "git_log", {
        maxCount: parseIntegerOption(options.maxCount, "max-count")
      });
    });
  });

tool
  .command("npm-test")
  .description("Run npm test through the Tool Registry.")
  .action(async () => {
    await main(async (workspaceRoot) => {
      await runCliTool(workspaceRoot, "npm_test", {});
    });
  });

tool
  .command("npm-typecheck")
  .description("Run npm run typecheck through the Tool Registry.")
  .action(async () => {
    await main(async (workspaceRoot) => {
      await runCliTool(workspaceRoot, "npm_typecheck", {});
    });
  });

program
  .command("run")
  .requiredOption("--session <session-id>", "Session id")
  .requiredOption("--prompt <prompt>", "Current user request")
  .option("--agent <agent-id>", "Agent id for this run. Overrides the session assignment without changing it.")
  .option("--provider <provider>", "Model provider: codex-cli, openai-compatible, or mock")
  .option("--provider-timeout-ms <ms>", "Override provider call timeout in milliseconds")
  .option("--approve-overwrite", "Allow interactive overwrite approval prompts", false)
  .option("--require-tools", "Require at least one read_file or search_files call before final.", false)
  .option("--skill <skill-id...>", "Manually include one or more global skills.")
  .description("Run a session turn.")
  .action(async (options: { session: string; prompt: string; agent?: string; provider?: string; providerTimeoutMs?: string; approveOverwrite: boolean; requireTools: boolean; skill?: string[] }) => {
    await main(async (workspaceRoot) => {
      const content = await runSession(workspaceRoot, {
        sessionId: options.session,
        prompt: options.prompt,
        agentId: options.agent,
        providerId: options.provider,
        providerTimeoutMs: options.providerTimeoutMs ? Number.parseInt(options.providerTimeoutMs, 10) : undefined,
        approveOverwriteFiles: options.approveOverwrite,
        requireTools: options.requireTools,
        manualSkillIds: options.skill,
        onEvent: (message) => console.error(`[cosia] ${message}`)
      });
      console.log(content);
    });
  });

program
  .command("chat")
  .requiredOption("--session <session-id>", "Session id")
  .option("--agent <agent-id>", "Agent id for this chat. Overrides the session assignment without changing it.")
  .option("--provider <provider>", "Model provider: codex-cli, openai-compatible, or mock")
  .option("--provider-timeout-ms <ms>", "Override provider call timeout in milliseconds")
  .option("--approve-overwrite", "Allow interactive overwrite approval prompts", false)
  .option("--require-tools", "Require at least one read_file or search_files call before final.", false)
  .option("--skill <skill-id...>", "Manually include one or more global skills.")
  .description("Enter a simple session REPL.")
  .action(async (options: { session: string; agent?: string; provider?: string; providerTimeoutMs?: string; approveOverwrite: boolean; requireTools: boolean; skill?: string[] }) => {
    await main(async (workspaceRoot) => {
      const sessions = new SessionManager(workspaceRoot);
      const session = await sessions.loadSession(options.session);
      await sessions.ensureSessionSupportFiles(session.id);
      const executingAgentId = options.agent ?? session.assignedAgentId;
      if (!executingAgentId) {
        throw new Error(`Session has no assigned agent. Run \`cosia session assign ${session.id} --agent <agent-id>\` or pass --agent <agent-id>.`);
      }
      const agent = await new AgentManager(workspaceRoot).loadAgent(executingAgentId);
      const policyManager = new PolicyManager(workspaceRoot);
      const policy = await policyManager.loadPolicy();
      if (await policyManager.ensureMarkdownCurrent()) {
        console.error("[cosia] policy mirror synced from POLICY.json");
      }
      const memory = new MemoryManager(workspaceRoot);
      const skills = new SkillManager(workspaceRoot);
      await memory.writeReferenceMemory(session, session.goal, agent.id);
      const staticBlocks = await loadPromptStaticBlocks({ workspaceRoot, agent, session });
      const history: Array<{ prompt: string; response: string }> = [];
      let lastPrompt = session.goal;
      const manualSkills = new Set(options.skill ?? []);

      console.error(`[cosia] chat started: ${session.id}`);
      console.error("[cosia] commands: /status, /memory refresh, /skills list, /skills use <id>, /skills drop <id>, /skills clear, /exit");
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
            console.log(`Assigned agent: ${session.assignedAgentId ?? "none"}`);
            console.log(`Executing agent: ${agent.id}`);
            console.log(`Provider: ${options.provider ?? policy.model.defaultProvider}`);
            console.log(`Prompt budget: ${policy.promptBudget.maxPromptChars} chars`);
            console.log(`Context tail: ${policy.promptBudget.contextTailChars} chars`);
            console.log(`Manual skills: ${manualSkills.size ? [...manualSkills].join(", ") : "none"}`);
            const health = await sessions.contextHealth(session.id, {
              warningChars: policy.promptBudget.contextWarningChars,
              criticalChars: policy.promptBudget.contextCriticalChars
            });
            console.log(`Context status: ${formatContextHealth(health)}`);
            if (health.level === "critical") {
              console.log(contextCriticalHint(session.id));
            }
            console.log(`Turns in this REPL: ${history.length}`);
            continue;
          }
          if (prompt === "/memory refresh") {
            await memory.writeReferenceMemory(session, lastPrompt, agent.id);
            console.error(`[cosia] refreshed REF_MEMORY.md for ${session.id}`);
            continue;
          }
          if (prompt === "/skills list") {
            const globalSkills = skills.listSkills();
            if (!globalSkills.length) {
              console.log("No global skills.");
            } else {
              for (const item of globalSkills) {
                const state = agent.blockedSkills.includes(item.id)
                  ? "blocked"
                  : manualSkills.has(item.id)
                    ? "selected"
                    : agent.preferredSkills.includes(item.id)
                      ? "preferred"
                      : "available";
                const weight = agent.skillWeights?.[item.id] ? ` weight:${agent.skillWeights[item.id]}` : "";
                console.log(`${item.id}\t${state}${weight}\t${item.manualOnly ? "manual-only" : `triggers:${item.triggers.join(",")}`}`);
              }
            }
            continue;
          }
          if (prompt.startsWith("/skills use ")) {
            const skillId = prompt.slice("/skills use ".length).trim();
            const skill = skills.getSkill(skillId);
            if (agent.blockedSkills.includes(skill.id)) {
              throw new Error(`Skill is blocked for ${agent.id}: ${skill.id}`);
            }
            manualSkills.add(skill.id);
            console.error(`[cosia] selected skill ${skill.id}`);
            continue;
          }
          if (prompt.startsWith("/skills drop ")) {
            const skillId = prompt.slice("/skills drop ".length).trim();
            const skill = skills.getSkill(skillId);
            manualSkills.delete(skill.id);
            console.error(`[cosia] dropped skill ${skill.id}`);
            continue;
          }
          if (prompt === "/skills clear") {
            manualSkills.clear();
            console.error("[cosia] cleared manual skills");
            continue;
          }

          let shouldRefreshMemory = false;
          const content = await runSession(workspaceRoot, {
            sessionId: session.id,
            prompt,
            agentId: agent.id,
            providerId: options.provider,
            providerTimeoutMs: options.providerTimeoutMs ? Number.parseInt(options.providerTimeoutMs, 10) : undefined,
            approveOverwriteFiles: options.approveOverwrite,
            requireTools: options.requireTools,
            promptStaticBlocks: staticBlocks,
            manualSkillIds: [...manualSkills],
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
            await memory.writeReferenceMemory(session, prompt, agent.id);
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

async function resolveMemoryTierOptions(
  workspaceRoot: string,
  options: { tier?: string; scope?: string; ownerId?: string },
  requireTier: boolean
): Promise<{ tier?: MemoryTier; scope?: MemoryScope; ownerId?: string | null }> {
  if (options.tier && options.scope) {
    throw new Error("Use either --tier or deprecated --scope, not both.");
  }
  if (!options.tier && !options.scope) {
    if (requireTier) {
      throw new Error("Memory tier is required. Use --tier core, --tier agent, or --tier session.");
    }
    return { ownerId: options.ownerId };
  }
  const scope = options.scope ? memoryScopeSchema.parse(options.scope) : undefined;
  const tier = options.tier
    ? memoryTierSchema.parse(options.tier)
    : scope === "session"
      ? "session"
      : scope === "agent"
        ? "agent"
        : "core";
  if (scope) {
    console.error(`[cosia] warning: --scope is deprecated; using tier '${tier}' with legacy scope '${scope}'.`);
  }
  if (tier === "agent") {
    if (!options.ownerId) {
      throw new Error("--owner-id is required for agent memory.");
    }
    await new AgentManager(workspaceRoot).loadAgent(options.ownerId);
  }
  if (tier === "session") {
    if (!options.ownerId) {
      throw new Error("--owner-id is required for session memory.");
    }
    await new SessionManager(workspaceRoot).loadSession(options.ownerId);
  }
  return {
    tier,
    scope,
    ownerId: tier === "core" ? options.ownerId ?? null : options.ownerId
  };
}

async function resolveBootstrapOptions(options: {
  id?: string;
  name?: string;
  role?: string;
  voice?: string;
  priorities?: string;
  boundaries?: string;
}): Promise<{
  id: string;
  name: string;
  role: string;
  voice: string;
  priorities: string;
  boundaries: string;
}> {
  if (options.id && options.name && options.role && options.voice) {
    return {
      id: options.id,
      name: options.name,
      role: options.role,
      voice: options.voice,
      priorities: options.priorities ?? "",
      boundaries: options.boundaries ?? ""
    };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const id = options.id ?? (await rl.question("Agent id: ")).trim();
    const name = options.name ?? (await rl.question("Display name: ")).trim();
    const role = options.role ?? (await rl.question("Role: ")).trim();
    const voice = options.voice ?? (await rl.question("Voice: ")).trim();
    const priorities = options.priorities ?? (await rl.question("Priorities (comma-separated, optional): ")).trim();
    const boundaries = options.boundaries ?? (await rl.question("Boundaries (comma-separated, optional): ")).trim();
    if (!id || !name || !role || !voice) {
      throw new Error("Agent id, name, role, and voice are required.");
    }
    return { id, name, role, voice, priorities, boundaries };
  } finally {
    rl.close();
  }
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatPromptManifest(manifest: PromptManifest): string {
  const lines = [
    `Run: ${manifest.runId ?? "legacy/no-run-id"}`,
    `Agent: ${manifest.agentId ?? "legacy/unknown"}`,
    `Model step: ${manifest.modelStep ?? "unknown"}`,
    `Timestamp: ${manifest.timestamp}`,
    `Prompt chars: ${manifest.promptChars}/${manifest.maxPromptChars}`,
    `Target chars: ${manifest.targetPromptChars}`,
    `Estimated tokens: ${manifest.estimatedTokens}`,
    `Overflowed: ${manifest.overflowed}`,
    "Blocks:"
  ];
  for (const block of manifest.blocks) {
    lines.push(`- ${block.title} [${block.source}] ${block.retainedChars}/${block.originalChars} chars${block.truncated ? " truncated" : ""}`);
  }
  if (manifest.skillSelections?.length) {
    lines.push("Skills:");
    for (const skill of manifest.skillSelections) {
      lines.push(`- ${skill.skillId} ${skill.selected ? "selected" : "omitted"} by:${skill.selectedBy} score:${skill.finalScore} trigger:${skill.triggerScore} pref:${skill.preferredBonus} weight:${skill.weightBonus} triggers:${skill.matchedTriggers.join(",") || "none"} ${skill.retainedChars}/${skill.originalChars} chars${skill.truncated ? " truncated" : ""}${skill.omittedReason ? ` reason:${skill.omittedReason}` : ""}`);
    }
  }
  return lines.join("\n");
}

async function printSessionList(workspaceRoot: string, sessions: SessionMetadata[]): Promise<void> {
  const agents = await new AgentManager(workspaceRoot).listAgents();
  const knownAgentIds = new Set(agents.map((agent) => agent.id));
  for (const item of sessions) {
    const assigned = item.assignedAgentId ?? "none";
    const assignmentStatus = item.assignedAgentId
      ? knownAgentIds.has(item.assignedAgentId)
        ? "assigned"
        : "orphan"
      : "unassigned";
    console.log(`${item.id}\t${assigned}\t${assignmentStatus}\t${item.status}\t${item.updatedAt}\t${item.goal}`);
  }
}

function formatContextHealth(health: { sessionId: string; chars: number; warningChars: number; criticalChars: number; level: string }): string {
  return `${health.sessionId} ${health.level} ${health.chars} chars (warning:${health.warningChars}, critical:${health.criticalChars})`;
}

function contextCriticalHint(sessionId: string): string {
  return [
    "Context is critical. Suggested next steps:",
    `- cosia session prompt ${sessionId} --latest`,
    `- cosia session summarize ${sessionId} --content \"<summary>\"`,
    `- cosia session context undo-last ${sessionId} --reason \"<reason>\"`
  ].join("\n");
}

async function runCliTool(workspaceRoot: string, name: ToolName, args: Record<string, unknown>): Promise<void> {
  const result = await new ToolRegistry().execute(name, args, {
    workspaceRoot,
    allowedTools: [name]
  });
  console.log(result.content);
  if (!result.ok) {
    process.exitCode = 1;
  }
}
