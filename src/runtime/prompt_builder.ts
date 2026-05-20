import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { readText } from "./fs_utils.js";
import type { PolicyConfig } from "./policy_manager.js";
import type { AgentManifest, SessionMetadata } from "./types.js";

type PromptInput = {
  workspaceRoot: string;
  agent: AgentManifest;
  session: SessionMetadata;
  userPrompt: string;
  toolResults?: string[];
  requireTools?: boolean;
  hasObservationTool?: boolean;
  requiresFileRead?: boolean;
  hasReadFile?: boolean;
  policy?: PolicyConfig;
  remainingToolCalls?: number;
  forceFinal?: boolean;
  staticBlocks?: PromptBlock[];
  runId?: string;
  modelStep?: number;
};

export type PromptBlock = {
  title: string;
  content: string;
  required?: boolean;
  source: "static" | "session" | "memory" | "tool" | "runtime" | "request";
};

export type PromptManifestBlock = {
  title: string;
  source: PromptBlock["source"];
  required: boolean;
  originalChars: number;
  retainedChars: number;
  truncated: boolean;
};

export type PromptManifest = {
  runId?: string;
  modelStep?: number;
  timestamp: string;
  sessionId: string;
  maxPromptChars: number;
  safetyMarginChars: number;
  targetPromptChars: number;
  promptChars: number;
  estimatedTokens: number;
  overflowed: boolean;
  blocks: PromptManifestBlock[];
};

export type PromptBuildResult = {
  prompt: string;
  manifest: PromptManifest;
};

const codexFiles = ["SECURITY.md", "POLICY.md", "RULES.md", "SOUL.md", "USER.md"] as const;
const safetyMarginRatio = 0.15;

export async function loadPromptStaticBlocks(input: Pick<PromptInput, "workspaceRoot" | "agent" | "session">): Promise<PromptBlock[]> {
  const blocks: PromptBlock[] = [];
  for (const fileName of codexFiles) {
    blocks.push({
      title: `codex/${fileName}`,
      content: await readText(join(input.workspaceRoot, "codex", fileName)),
      required: fileName === "SECURITY.md" || fileName === "POLICY.md",
      source: "static"
    });
  }
  for (const fileName of ["AGENT.md", "LOCAL_RULES.md"] as const) {
    blocks.push({
      title: `agents/${input.agent.id}/${fileName}`,
      content: await readText(join(input.workspaceRoot, "agents", input.agent.id, fileName)),
      source: "static"
    });
  }
  blocks.push({
    title: `sessions/${input.session.id}/SESSION_RULES.md`,
    content: await readText(join(input.workspaceRoot, "sessions", input.session.id, "SESSION_RULES.md")),
    source: "static"
  });
  return blocks;
}

export async function buildPrompt(input: PromptInput): Promise<string> {
  return (await buildPromptBundle(input)).prompt;
}

export async function buildPromptBundle(input: PromptInput): Promise<PromptBuildResult> {
  const policy = input.policy;
  const budget = policy?.promptBudget ?? {
    maxPromptChars: 60000,
    refMemoryMaxItems: 8,
    contextTailChars: 6000,
    contextWarningChars: 30000,
    contextCriticalChars: 60000,
    toolResultsMaxChars: 12000,
    overflowPolicy: "truncate_low_priority" as const
  };
  const staticBlocks = input.staticBlocks ?? await loadPromptStaticBlocks(input);
  const dynamicBlocks = await loadDynamicBlocks(input, budget);
  const runtimeBlocks = runtimePromptBlocks(input);
  const requestBlock: PromptBlock = {
    title: "CURRENT USER REQUEST",
    content: input.userPrompt,
    required: true,
    source: "request"
  };
  const blocks = [...staticBlocks, ...dynamicBlocks, ...runtimeBlocks, requestBlock];
  const safetyMarginChars = Math.ceil(budget.maxPromptChars * safetyMarginRatio);
  const targetPromptChars = Math.max(1, budget.maxPromptChars - safetyMarginChars);
  return assembleWithBudget(blocks, {
    sessionId: input.session.id,
    runId: input.runId,
    modelStep: input.modelStep,
    maxPromptChars: budget.maxPromptChars,
    safetyMarginChars,
    targetPromptChars
  });
}

export async function appendPromptManifest(workspaceRoot: string, sessionId: string, manifest: PromptManifest): Promise<void> {
  await appendFile(join(workspaceRoot, "sessions", sessionId, "PROMPT_MANIFEST.jsonl"), `${JSON.stringify(manifest)}\n`, "utf8");
}

async function loadDynamicBlocks(
  input: PromptInput,
  budget: NonNullable<PolicyConfig["promptBudget"]>
): Promise<PromptBlock[]> {
  const sessionDir = join(input.workspaceRoot, "sessions", input.session.id);
  const sessionSummary = await readText(join(sessionDir, "SESSION_SUMMARY.md"));
  const refMemory = limitReferenceMemory(await readText(join(sessionDir, "REF_MEMORY.md")), budget.refMemoryMaxItems);
  const contextMemory = tailText(await readText(join(sessionDir, "CONTEXT_MEMORY.md")), budget.contextTailChars, "CONTEXT_MEMORY.md");
  const blocks: PromptBlock[] = [
    {
      title: `sessions/${input.session.id}/SESSION_SUMMARY.md`,
      content: sessionSummary,
      source: "session"
    },
    {
      title: `sessions/${input.session.id}/REF_MEMORY.md`,
      content: refMemory,
      source: "memory"
    },
    {
      title: `sessions/${input.session.id}/CONTEXT_MEMORY.md`,
      content: contextMemory,
      source: "session"
    },
    toolResultsBlock(input.toolResults ?? [], budget.toolResultsMaxChars)
  ];
  return blocks.filter((block) => block.content.trim().length > 0);
}

function runtimePromptBlocks(input: PromptInput): PromptBlock[] {
  const requireToolsText = input.requireTools
    ? `# REQUIRE-TOOLS MODE

This run is in require-tools mode. Before returning a final answer, you must call at least one observation tool: ${observationToolsText(input.policy)}. write_file satisfies this requirement: ${input.policy?.requireTools.writeFileSatisfies ?? false}.${
        input.hasObservationTool
          ? "\n\nThe observation requirement is already satisfied. Use the tool results you have. Prefer returning final now unless the last tool result failed and one more targeted observation is essential."
          : ""
      }`
    : "";
  const fileReadRequirementText = input.requiresFileRead
    ? `# FILE-READ REQUIREMENT

The current request asks to inspect actual files. search_files is only for finding candidate paths. Before final, you must call read_file on at least one relevant file path.${
        input.hasReadFile ? "\n\nThis requirement is already satisfied." : ""
      }`
    : "";
  const loopControlText = `# TOOL LOOP CONTROL

Remaining executable tool calls: ${input.remainingToolCalls ?? 5}.${
    input.forceFinal
      ? "\n\nTool call budget is exhausted. You must return a final answer now using the available tool results. Do not return a tool_call."
      : ""
  }`;

  const blocks: PromptBlock[] = [
    {
      title: "RUNTIME OUTPUT CONTRACT",
      content: outputContract(input.agent.allowedTools),
      required: true,
      source: "runtime"
    },
    {
      title: "REQUIRE-TOOLS MODE",
      content: requireToolsText,
      source: "runtime"
    },
    {
      title: "FILE-READ REQUIREMENT",
      content: fileReadRequirementText,
      source: "runtime"
    },
    {
      title: "TOOL LOOP CONTROL",
      content: loopControlText,
      required: true,
      source: "runtime"
    }
  ];
  return blocks.filter((block) => block.content.trim().length > 0);
}

function assembleWithBudget(
  blocks: PromptBlock[],
  input: Pick<PromptManifest, "sessionId" | "runId" | "modelStep" | "maxPromptChars" | "safetyMarginChars" | "targetPromptChars">
): PromptBuildResult {
  const working = blocks.map((block) => ({
    ...block,
    originalContent: block.content,
    originalChars: block.content.length,
    retainedChars: block.content.length,
    truncated: false
  }));
  let prompt = renderBlocks(working);

  if (prompt.length > input.targetPromptChars) {
    for (let index = working.length - 1; index >= 0 && prompt.length > input.targetPromptChars; index -= 1) {
      const block = working[index];
      if (block.required) {
        continue;
      }
      const excess = prompt.length - input.targetPromptChars;
      const minimum = Math.min(block.content.length, 300);
      const nextLength = Math.max(minimum, block.content.length - excess);
      if (nextLength >= block.content.length) {
        continue;
      }
      block.content = truncateWithMarker(block.content, nextLength, block.title);
      block.retainedChars = block.content.length;
      block.truncated = true;
      prompt = renderBlocks(working);
    }
  }

  const manifest: PromptManifest = {
    runId: input.runId,
    modelStep: input.modelStep,
    timestamp: new Date().toISOString(),
    sessionId: input.sessionId,
    maxPromptChars: input.maxPromptChars,
    safetyMarginChars: input.safetyMarginChars,
    targetPromptChars: input.targetPromptChars,
    promptChars: prompt.length,
    estimatedTokens: estimateTokens(prompt.length),
    overflowed: prompt.length > input.targetPromptChars,
    blocks: working.map((block) => ({
      title: block.title,
      source: block.source,
      required: block.required ?? false,
      originalChars: block.originalChars,
      retainedChars: block.content.length,
      truncated: block.truncated
    }))
  };
  return { prompt, manifest };
}

function renderBlocks(blocks: PromptBlock[]): string {
  return `${blocks.map((block) => `# BEGIN ${block.title}\n${block.content.trim()}\n# END ${block.title}`).join("\n\n")}\n`;
}

function outputContract(allowedTools: string[]): string {
  return `Return only one valid JSON object. Do not wrap it in Markdown.

When the request asks about implementation, files, CLI commands, package metadata, or current project state, inspect actual files before final. A good pattern is search_files first, then read_file on the most relevant path matches such as package.json, README.md, src/cli.ts, src/index.ts, or bin entrypoints.

For a tool call:
{"type":"tool_call","tool":"read_file","args":{"path":"README.md","content":"","query":"","directory":""},"content":"","memoryCandidates":[]}

For a search tool call:
{"type":"tool_call","tool":"search_files","args":{"path":"","content":"","query":"cosia","directory":""},"content":"","memoryCandidates":[]}

For a final answer:
{"type":"final","tool":"read_file","args":{"path":"","content":"","query":"","directory":""},"content":"...","memoryCandidates":[]}

Allowed tools for this agent: ${allowedTools.join(", ")}
Maximum tool loop depth: 5`;
}

function toolResultsBlock(toolResults: string[], maxChars: number): PromptBlock {
  if (!toolResults.length) {
    return {
      title: "TOOL RESULTS",
      content: "",
      source: "tool"
    };
  }
  const content = `# TOOL RESULTS\n\n${toolResults.map((result, index) => `## Result ${index + 1}\n\n${result}`).join("\n\n")}`;
  return {
    title: "TOOL RESULTS",
    content: truncateToolOutput(content, maxChars),
    source: "tool"
  };
}

function limitReferenceMemory(content: string, maxItems: number): string {
  const lines = content.split(/\r?\n/);
  const memoryLines = lines.filter((line) => line.trimStart().startsWith("- [mem:"));
  if (memoryLines.length <= maxItems) {
    return content;
  }
  const nonMemoryLines = lines.filter((line) => !line.trimStart().startsWith("- [mem:"));
  return `${nonMemoryLines.join("\n").trimEnd()}\n${memoryLines.slice(0, maxItems).join("\n")}\n[COSIA: reference memory truncated to top ${maxItems} scored items]\n`;
}

function tailText(content: string, maxChars: number, label: string): string {
  if (content.length <= maxChars) {
    return content;
  }
  const retained = content.slice(content.length - maxChars);
  return `[COSIA: ${label} truncated to latest ${maxChars} chars]\n${retained}`;
}

function truncateToolOutput(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  const marker = `\n[COSIA: tool output truncated, originalChars=${content.length}, retainedChars=${maxChars}, omittedChars=${content.length - maxChars}. Do not infer that omitted output was inspected or problem-free.]`;
  return `${content.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

function truncateWithMarker(content: string, maxChars: number, label: string): string {
  if (content.length <= maxChars) {
    return content;
  }
  const marker = `\n[COSIA: prompt block truncated: ${label}, originalChars=${content.length}, retainedChars=${maxChars}]`;
  return `${content.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function observationToolsText(policy: PolicyConfig | undefined): string {
  const tools = policy?.requireTools.observationTools ?? ["read_file", "search_files"];
  return tools.map((tool) => `\`${tool}\``).join(", ");
}
