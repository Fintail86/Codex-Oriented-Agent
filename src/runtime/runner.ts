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
  requireTools?: boolean;
  provider?: ModelProvider;
  providerTimeoutMs?: number;
  onEvent?: (message: string) => void;
};

export async function runSession(workspaceRoot: string, options: RunOptions): Promise<string> {
  const sessions = new SessionManager(workspaceRoot);
  const agents = new AgentManager(workspaceRoot);
  const memory = new MemoryManager(workspaceRoot);
  const tools = new ToolRegistry();
  const session = await sessions.loadSession(options.sessionId);
  const agent = await agents.loadAgent(session.agentId);
  await memory.writeReferenceMemory(session, options.prompt);

  const provider = options.provider ?? createProvider(options.providerId ?? "codex-cli", workspaceRoot, options.providerTimeoutMs);
  if (provider.id !== "mock") {
    const auth = await provider.checkAuth();
    if (!auth.ok) {
      throw new Error(`Model provider auth failed: ${auth.message}`);
    }
  }

  const toolResults: string[] = [];
  const toolNames: string[] = [];
  let hasObservationTool = false;
  let hasReadFile = false;
  let finalContent = "";
  let lastStep: AgentStep | undefined;
  const maxToolCalls = 5;
  const maxModelAttempts = maxToolCalls + 2;
  let toolCallCount = 0;
  const requiresFileRead = Boolean(options.requireTools && asksForActualFiles(options.prompt));

  for (let depth = 0; depth < maxModelAttempts; depth += 1) {
    const remainingToolCalls = Math.max(0, maxToolCalls - toolCallCount);
    const forceFinal = remainingToolCalls === 0;
    options.onEvent?.(`model step ${depth + 1}/${maxModelAttempts}`);
    const prompt = await buildPrompt({
      workspaceRoot,
      agent,
      session,
      userPrompt: options.prompt,
      toolResults,
      requireTools: options.requireTools,
      hasObservationTool,
      requiresFileRead,
      hasReadFile,
      remainingToolCalls,
      forceFinal
    });
    const output = await complete(provider, prompt, session.id);
    lastStep = output.step;
    if (output.step.type === "final") {
      if (options.requireTools && !hasObservationTool) {
        options.onEvent?.("final rejected because require-tools has not observed with read_file/search_files yet");
        toolResults.push(
          "Runtime rejection: current mode is require-tools. You must call read_file or search_files at least once before returning final."
        );
        continue;
      }
      if (requiresFileRead && !hasReadFile) {
        options.onEvent?.("final rejected because current request requires read_file before final");
        toolResults.push(
          "Runtime rejection: the current request asks to inspect actual files. search_files only finds candidate paths; call read_file on a relevant path before returning final."
        );
        continue;
      }
      finalContent = output.step.content;
      await memory.appendCandidates(output.step.memoryCandidates, session);
      break;
    }
    if (forceFinal) {
      options.onEvent?.("tool_call rejected because tool call budget is exhausted");
      toolResults.push(
        "Runtime rejection: tool call budget is exhausted. Return a final answer now using the available tool results. Do not call another tool."
      );
      continue;
    }
    const result = await tools.execute(output.step.tool, output.step.args, {
      workspaceRoot,
      allowedTools: agent.allowedTools,
      approveOverwrite: options.approveOverwriteFiles ? approveOverwrite : async () => false
    });
    toolCallCount += 1;
    options.onEvent?.(`tool ${output.step.tool} ${result.ok ? "ok" : "failed"}`);
    toolNames.push(output.step.tool);
    if ((output.step.tool === "read_file" || output.step.tool === "search_files") && result.ok) {
      hasObservationTool = true;
    }
    if (output.step.tool === "read_file" && result.ok) {
      hasReadFile = true;
    }
    toolResults.push(`Tool: ${output.step.tool}\nArgs: ${JSON.stringify(output.step.args)}\nOK: ${result.ok}\n${result.content}`);
  }

  if (!finalContent) {
    throw new Error(`Run did not produce a final answer after ${maxToolCalls} tool calls. Last step: ${JSON.stringify(lastStep)}`);
  }

  await sessions.appendContext(session.id, contextEntry(options.prompt, finalContent, toolNames));
  await memory.writeReferenceMemory(session, options.prompt);
  return finalContent;
}

async function complete(provider: ModelProvider, prompt: string, sessionId: string) {
  return provider.complete({ prompt, sessionId });
}

function contextEntry(prompt: string, finalContent: string, toolNames: string[]): string {
  return `## Run ${new Date().toISOString()}

Prompt:
${prompt}

Tools:
${toolNames.length ? toolNames.join(", ") : "none"}

Final:
${finalContent}
`;
}

function asksForActualFiles(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return [
    "파일을 보고",
    "실제 파일",
    "파일 기준",
    "파일 내용",
    "파일을 확인",
    "read_file",
    "actual file",
    "actual files",
    "inspect file",
    "inspect files",
    "read the file",
    "read files",
    "from the file",
    "from files"
  ].some((needle) => normalized.includes(needle));
}
