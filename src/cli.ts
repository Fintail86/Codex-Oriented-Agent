#!/usr/bin/env node
import { Command } from "commander";
import { AgentManager } from "./runtime/agent_manager.js";
import { initProject } from "./runtime/init_project.js";
import { MemoryManager } from "./runtime/memory_manager.js";
import { runSession } from "./runtime/runner.js";
import { SessionManager } from "./runtime/session_manager.js";
import { memoryScopeSchema } from "./runtime/types.js";

const program = new Command();

program
  .name("agent-runtime")
  .description("Codex-oriented agent runtime CLI MVP")
  .version("0.1.0");

program
  .command("init")
  .description("Create the default runtime directory structure and Codex templates.")
  .action(async () => {
    await main(async (workspaceRoot) => {
      const created = await initProject(workspaceRoot);
      console.log(`Initialized runtime in ${workspaceRoot}`);
      console.log(created.map((item) => `- ${item}`).join("\n"));
    });
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

program
  .command("run")
  .requiredOption("--session <session-id>", "Session id")
  .requiredOption("--prompt <prompt>", "Current user request")
  .option("--provider <provider>", "Model provider: codex-cli or mock", "codex-cli")
  .option("--approve-overwrite", "Allow interactive overwrite approval prompts", false)
  .description("Run a session turn.")
  .action(async (options: { session: string; prompt: string; provider: string; approveOverwrite: boolean }) => {
    await main(async (workspaceRoot) => {
      const content = await runSession(workspaceRoot, {
        sessionId: options.session,
        prompt: options.prompt,
        providerId: options.provider,
        approveOverwriteFiles: options.approveOverwrite
      });
      console.log(content);
    });
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});

async function main(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  try {
    await fn(process.cwd());
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
