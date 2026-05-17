#!/usr/bin/env node
import { Command } from "commander";
import { AgentManager } from "./runtime/agent_manager.js";
import { initProject } from "./runtime/init_project.js";
import { MemoryManager } from "./runtime/memory_manager.js";
import { PolicyAuditLog } from "./runtime/policy_audit.js";
import { formatPolicySummary, PolicyManager } from "./runtime/policy_manager.js";
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
  .option("--provider <provider>", "Model provider smoke check: codex-cli or mock", "codex-cli")
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

const memory = program.command("memory").description("Manage long-term memory.");

memory
  .command("add")
  .requiredOption("--scope <scope>", "Memory scope")
  .requiredOption("--content <content>", "Memory content")
  .option("--kind <kind>", "Memory kind", "note")
  .option("--owner-id <owner-id>", "Owner id")
  .description("Add an explicit long-term memory.")
  .action(async (options: { scope: string; content: string; kind: string; ownerId?: string }) => {
    await main(async (workspaceRoot) => {
      const manager = new MemoryManager(workspaceRoot);
      const record = manager.addMemory({
        scope: memoryScopeSchema.parse(options.scope),
        content: options.content,
        kind: options.kind,
        ownerId: options.ownerId
      });
      console.log(record.id);
    });
  });

memory
  .command("search")
  .requiredOption("--query <query>", "Search query")
  .option("--limit <limit>", "Result limit", "8")
  .description("Search explicit long-term memory.")
  .action(async (options: { query: string; limit: string }) => {
    await main(async (workspaceRoot) => {
      const manager = new MemoryManager(workspaceRoot);
      const records = manager.search(options.query, Number.parseInt(options.limit, 10));
      if (!records.length) {
        console.log("No matches.");
        return;
      }
      for (const record of records) {
        console.log(`[${record.scope}/${record.kind}] ${record.content}`);
      }
    });
  });

memory
  .command("list")
  .option("--limit <limit>", "Result limit", "20")
  .description("List latest active long-term memories.")
  .action(async (options: { limit: string }) => {
    await main(async (workspaceRoot) => {
      const records = new MemoryManager(workspaceRoot).listMemories(Number.parseInt(options.limit, 10));
      if (!records.length) {
        console.log("No memories.");
        return;
      }
      for (const record of records) {
        console.log(`${record.id}\t[${record.scope}/${record.kind}]\t${record.content}`);
      }
    });
  });

const candidate = memory.command("candidate").description("Review memory candidates.");

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
  .argument("<candidate-id>")
  .description("Promote a pending memory candidate into long-term memory.")
  .action(async (candidateId: string) => {
    await main(async (workspaceRoot) => {
      const record = await new MemoryManager(workspaceRoot).promoteCandidate(candidateId);
      console.log(record.id);
    });
  });

candidate
  .command("discard")
  .argument("<candidate-id>")
  .requiredOption("--reason <reason>", "Discard reason")
  .description("Discard a pending memory candidate.")
  .action(async (candidateId: string, options: { reason: string }) => {
    await main(async (workspaceRoot) => {
      const record = await new MemoryManager(workspaceRoot).discardCandidate(candidateId, options.reason);
      console.log(`${record.id} discarded`);
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
  .description("Show policy audit events for one session.")
  .action(async (options: { session: string; limit: string }) => {
    await main(async (workspaceRoot) => {
      const events = await new PolicyAuditLog(workspaceRoot).list(options.session, Number.parseInt(options.limit, 10));
      if (!events.length) {
        console.log("No policy audit events.");
        return;
      }
      for (const event of events) {
        console.log(JSON.stringify(event));
      }
    });
  });

program
  .command("run")
  .requiredOption("--session <session-id>", "Session id")
  .requiredOption("--prompt <prompt>", "Current user request")
  .option("--provider <provider>", "Model provider: codex-cli or mock", "codex-cli")
  .option("--provider-timeout-ms <ms>", "Per Codex CLI provider call timeout in milliseconds", "120000")
  .option("--approve-overwrite", "Allow interactive overwrite approval prompts", false)
  .option("--require-tools", "Require at least one read_file or search_files call before final.", false)
  .description("Run a session turn.")
  .action(async (options: { session: string; prompt: string; provider: string; providerTimeoutMs: string; approveOverwrite: boolean; requireTools: boolean }) => {
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
