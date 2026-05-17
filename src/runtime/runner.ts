import { join } from "node:path";
import { approveOverwrite } from "./approval_gate.js";
import { AgentManager } from "./agent_manager.js";
import { MemoryManager } from "./memory_manager.js";
import { createProvider } from "./model/provider_registry.js";
import { buildPrompt } from "./prompt_builder.js";
import { SessionManager } from "./session_manager.js";
import { ToolRegistry } from "./tool_registry.js";
import type { AgentStep, ModelProvider } from "./types.js";

type RunOptions = {
  sessionId: string;
  prompt: string;
  providerId?: string;
  approveOverwriteFiles?: boolean;
};

export async function runSession(workspaceRoot: string, options: RunOptions): Promise<string> {
  const sessions = new SessionManager(workspaceRoot);
  const agents = new AgentManager(workspaceRoot);
  const memory = new MemoryManager(workspaceRoot);
  const tools = new ToolRegistry();
  const session = await sessions.loadSession(options.sessionId);
  const agent = await agents.loadAgent(session.agentId);
  await memory.writeReferenceMemory(session, options.prompt);

  const provider = createProvider(options.providerId ?? "codex-cli", workspaceRoot);
  if (provider.id !== "mock") {
    const auth = await provider.checkAuth();
    if (!auth.ok) {
      throw new Error(`Model provider auth failed: ${auth.message}`);
    }
  }

  const toolResults: string[] = [];
  let finalContent = "";
  let lastStep: AgentStep | undefined;

  for (let depth = 0; depth < 5; depth += 1) {
    const prompt = await buildPrompt({
      workspaceRoot,
      agent,
      session,
      userPrompt: options.prompt,
      toolResults
    });
    const output = await complete(provider, prompt, session.id);
    lastStep = output.step;
    if (output.step.type === "final") {
      finalContent = output.step.content;
      await memory.appendCandidates(output.step.memoryCandidates, session);
      break;
    }
    const result = await tools.execute(output.step.tool, output.step.args, {
      workspaceRoot,
      allowedTools: agent.allowedTools,
      approveOverwrite: options.approveOverwriteFiles ? approveOverwrite : async () => false
    });
    toolResults.push(`Tool: ${output.step.tool}\nOK: ${result.ok}\n${result.content}`);
  }

  if (!finalContent) {
    throw new Error(`Run did not produce a final answer after 5 tool steps. Last step: ${JSON.stringify(lastStep)}`);
  }

  await sessions.appendContext(session.id, contextEntry(options.prompt, finalContent));
  await memory.writeReferenceMemory(session, options.prompt);
  return finalContent;
}

async function complete(provider: ModelProvider, prompt: string, sessionId: string) {
  return provider.complete({ prompt, sessionId });
}

function contextEntry(prompt: string, finalContent: string): string {
  return `## Run ${new Date().toISOString()}

Prompt:
${prompt}

Final:
${finalContent}
`;
}
