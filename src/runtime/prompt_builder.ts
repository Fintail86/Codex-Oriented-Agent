import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { readText } from "./fs_utils.js";
import type { PolicyConfig } from "./policy_manager.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./runtime_config.js";
import { SkillManager, type SkillSelectionManifest } from "./skill_manager.js";
import { listEffectiveActiveModelToolIds } from "./tool_acquisition.js";
import { isBundledToolId, toolCatalog } from "./tool_catalog.js";
import type { AgentManifest, SessionMetadata, ToolName } from "./types.js";
import type { GatewayActor, GatewayRole } from "./gateway_auth_types.js";

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
  manualSkillIds?: string[];
  sourceChannel?: "cli" | "repl" | "gateway";
  gatewayActor?: GatewayActor;
  gatewayRole?: GatewayRole;
};

export type PromptBlock = {
  title: string;
  content: string;
  required?: boolean;
  source: "static" | "session" | "memory" | "skill" | "tool" | "runtime" | "request";
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
  agentId?: string;
  maxPromptChars: number;
  safetyMarginChars: number;
  targetPromptChars: number;
  promptChars: number;
  estimatedTokens: number;
  overflowed: boolean;
  blocks: PromptManifestBlock[];
  skillSelections?: SkillSelectionManifest[];
  context?: PromptContextManifest;
};

export type PromptContextManifest = {
  chars: number;
  healthLevel: "ok" | "warning" | "critical";
  summaryIsPlaceholder: boolean;
  compactRecommended: boolean;
};

export type PromptBuildResult = {
  prompt: string;
  manifest: PromptManifest;
};

type DynamicPromptBlocks = PromptBlock[] & {
  skillSelections?: SkillSelectionManifest[];
  context?: PromptContextManifest;
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
  blocks.push({
    title: "AGENT IDENTITY (JSON)",
    content: JSON.stringify(input.agent.identity, null, 2),
    required: true,
    source: "static"
  });
  blocks.push({
    title: "AGENT SUPPLEMENTARY PROFILE",
    content: await readText(join(input.workspaceRoot, "agents", input.agent.id, "AGENT.md")),
    required: true,
    source: "static"
  });
  blocks.push({
    title: "AGENT STYLE",
    content: await readText(join(input.workspaceRoot, "agents", input.agent.id, "STYLE.md")),
    required: true,
    source: "static"
  });
  blocks.push({
    title: "AGENT LOCAL RULES",
    content: await readText(join(input.workspaceRoot, "agents", input.agent.id, "LOCAL_RULES.md")),
    required: true,
    source: "static"
  });
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
    skillMaxItems: 5,
    skillMaxChars: 8000,
    skillItemMaxChars: 2000,
    overflowPolicy: "truncate_low_priority" as const
  };
  const staticBlocks = input.staticBlocks ?? await loadPromptStaticBlocks(input);
  const dynamicBlocks = await loadDynamicBlocks(input, budget);
  const runtimeBlocks = await runtimePromptBlocks(input);
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
    agentId: input.agent.id,
    runId: input.runId,
    modelStep: input.modelStep,
    maxPromptChars: budget.maxPromptChars,
    safetyMarginChars,
    targetPromptChars,
    skillSelections: dynamicBlocks.skillSelections,
    context: dynamicBlocks.context
  });
}

export async function appendPromptManifest(workspaceRoot: string, sessionId: string, manifest: PromptManifest): Promise<void> {
  await appendFile(join(workspaceRoot, "sessions", sessionId, "PROMPT_MANIFEST.jsonl"), `${JSON.stringify(manifest)}\n`, "utf8");
}

async function loadDynamicBlocks(
  input: PromptInput,
  budget: NonNullable<PolicyConfig["promptBudget"]>
): Promise<DynamicPromptBlocks> {
  const sessionDir = join(input.workspaceRoot, "sessions", input.session.id);
  const skillBlock = new SkillManager(input.workspaceRoot).selectSkillPromptBlock({
    agent: input.agent,
    sessionGoal: input.session.goal,
    currentRequest: input.userPrompt,
    manualSkillIds: input.manualSkillIds,
    budget: {
      skillMaxItems: budget.skillMaxItems,
      skillMaxChars: budget.skillMaxChars,
      skillItemMaxChars: budget.skillItemMaxChars
    }
  });
  const sessionSummary = await readText(join(sessionDir, "SESSION_SUMMARY.md"));
  const refMemory = limitReferenceMemory(await readText(join(sessionDir, "REF_MEMORY.md")), budget.refMemoryMaxItems);
  const contextMemoryRaw = await readText(join(sessionDir, "CONTEXT_MEMORY.md"));
  const contextMemory = tailText(contextMemoryRaw, budget.contextTailChars, "CONTEXT_MEMORY.md");
  const blocks: PromptBlock[] = [
    ...(skillBlock ? [{
      title: skillBlock.title,
      content: skillBlock.content,
      source: "skill" as const
    }] : []),
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
  const filtered = blocks.filter((block) => block.content.trim().length > 0) as DynamicPromptBlocks;
  filtered.skillSelections = skillBlock?.manifest ?? [];
  filtered.context = {
    chars: contextMemoryRaw.length,
    healthLevel: contextHealthLevel(contextMemoryRaw.length, budget.contextWarningChars, budget.contextCriticalChars),
    summaryIsPlaceholder: isPlaceholderSessionSummary(sessionSummary),
    compactRecommended: contextMemoryRaw.length >= budget.contextWarningChars && countContextRuns(contextMemoryRaw) > 1
  };
  return filtered;
}

async function runtimePromptBlocks(input: PromptInput): Promise<PromptBlock[]> {
  const runtime = await loadRuntimeConfig(input.workspaceRoot);
  const availableTools = effectiveAvailableModelTools(input.workspaceRoot, input.agent.allowedTools, input.policy, runtime.config);
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
      content: outputContract(),
      required: true,
      source: "runtime"
    },
    {
      title: "ACTIVE TOOL STATE",
      content: activeToolStateText(availableTools),
      required: true,
      source: "runtime"
    },
    ...(input.sourceChannel === "gateway" ? [{
      title: "GATEWAY COMMAND CONTEXT",
      content: gatewayCommandContextText(input),
      required: true,
      source: "runtime" as const
    }] : []),
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

function effectiveAvailableModelTools(
  workspaceRoot: string,
  allowedTools: ToolName[],
  policy: PolicyConfig | undefined,
  runtime: RuntimeConfig
): ToolName[] {
  const catalog = toolCatalog as Record<string, typeof toolCatalog[keyof typeof toolCatalog] | undefined>;
  const catalogTools = allowedTools.filter((tool) => {
    const entry = catalog[tool];
    if (!entry || entry.exposure !== "model") {
      return false;
    }
    if (isBundledToolId(tool)) {
      if (!runtime.tools.bundled[tool]?.enabled) {
        return false;
      }
    } else if (policy) {
      const toolPolicy = policy.tools[tool];
      if (!toolPolicy?.enabled || toolPolicy.permission !== entry.permission) {
        return false;
      }
    }
    return !(policy?.disabledPermissions ?? []).includes(entry.permission);
  });
  return [
    ...catalogTools,
    ...listEffectiveActiveModelToolIds(workspaceRoot, allowedTools, policy)
      .filter((tool) => !catalogTools.includes(tool))
  ];
}

function assembleWithBudget(
  blocks: PromptBlock[],
  input: Pick<PromptManifest, "sessionId" | "agentId" | "runId" | "modelStep" | "maxPromptChars" | "safetyMarginChars" | "targetPromptChars" | "skillSelections" | "context">
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
    agentId: input.agentId,
    maxPromptChars: input.maxPromptChars,
    safetyMarginChars: input.safetyMarginChars,
    targetPromptChars: input.targetPromptChars,
    promptChars: prompt.length,
    estimatedTokens: estimateTokens(prompt.length),
    overflowed: prompt.length > input.targetPromptChars,
    skillSelections: input.skillSelections,
    context: input.context,
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

function outputContract(): string {
  return `Return only one valid JSON object. Do not wrap it in Markdown.

When the request asks about implementation, files, CLI commands, package metadata, or current project state, inspect actual files before final. A good pattern is search_files first, then read_file on the most relevant path matches such as package.json, README.md, src/cli.ts, src/index.ts, or bin entrypoints.

shell_request does not execute commands. It only creates a user-reviewable, one-shot shell approval preview. Do not claim the command has run until execution output is observed after approval. Prefer current active tools and capability proposals before shell_request.

If a tool result says approval is required, overwrite was denied, a pending preview was created, or an operation has not been changed/applied yet, do not claim the requested change is active. State that the change is pending approval or was not applied, and tell the user to use the explicit apply flow when one is available.

Static prompt blocks such as AGENT STYLE, AGENT IDENTITY, AGENT LOCAL RULES, and codex/*.md are prompt-loaded context snapshots. You may answer from them, but do not claim you inspected, checked, or read the underlying file in this run unless a current read_file tool result for that path appears in TOOL RESULTS. If you answer from a static block, name it as prompt-loaded context, not live file inspection.

If the user asks about COSIA CLI, slash, gateway, review, job, session, provider, policy, memory, skill, pending, or tool-growth command surfaces and you do not know the exact surface, call cosia_cli_command_lookup with the user's original request text in the input field when it is active. The runtime detects catalog tag words and returns commandId candidates; the lookup tool does not execute commands and does not mutate runtime state.

If cosia_cli_command_lookup returns a modelToolHint for an active tool, prefer that active tool before saying the runtime surface is unavailable. For example, review and memory-promotion questions should use review_inbox_read when it is active.

If cosia_cli_command_lookup returns a modelCallable command with modelExecutionMode "execute_read_only", you may select one returned commandId and call cosia_runtime_command with commandId and structured args. The runtime maps commandId to a fixed COSIA CLI argv plan and executes it without a shell string. Never pass CLI strings, slash commands, hash commands, or natural-language commands to cosia_runtime_command. cosia_runtime_command may return needs_input; if it does, ask for or infer only the missing structured args and retry when appropriate.

If GATEWAY COMMAND CONTEXT says "Private master direct chat: true", the user is the registered master in a 1:1 gateway chat. In that specific context, cosia_runtime_command may also execute normal non-system CLI mutation commandIds such as memory/review promote or discard when the user explicitly asks for that action. The runtime still blocks dangerous, shell, pending apply/cancel, and system-boundary commands. Do not route memory candidate promotion through cosia apply; use the memory candidate promote commandId.

Do not claim that the tool call budget is exhausted unless the TOOL LOOP CONTROL block explicitly says the budget is exhausted or a current TOOL RESULTS block contains a runtime rejection saying the budget is exhausted. A new user message normally starts with a fresh tool budget. If the user supplies missing structured args for a modelCallable read-only command, call the command instead of saying you cannot retry because of a previous turn's budget.

If lookup returns only non-callable or safety-blocked command surfaces, tell the user the exact slash or CLI command shown by cliDisplay. Do not claim you ran it. If lookup and active tools cannot answer the request, name the missing read-only capability, explain what it would inspect and what it must not mutate, then ask for permission to start the guided tool-growth routine. Include a toolGrowthRequest object in the final AgentStep so the runtime can remember the proposed tool-growth request for the user's next approval message.

Do not use raw SQLite/runtime file reads as a substitute for runtime command surfaces. Hash-prefixed commands are not part of the runtime command surface.

If a PENDING TOOL GROWTH REQUEST block is present, interpret the current user message semantically. If the user clearly wants to start the proposed routine, return toolGrowthDecision {"action":"start"}. If the user clearly refuses or cancels it, return {"action":"cancel"}. If the user asks a question or the intent is unclear, return {"action":"clarify"} or {"action":"none"} and keep answering normally. Do not require slash commands for this natural-language decision.

For unavailable runtime surfaces after lookup, prefer this answer shape in the user's language: "To answer this, COSIA needs a read-only <capability name> tool. It would inspect <specific runtime queue/state>, report <specific fields>, and would not modify files, approvals, memory, tools, policy, or connectors. Should I start the tool creation routine?"

For a tool call, choose exactly one tool listed in ACTIVE TOOL STATE and provide only the structured args needed by that tool:
{"type":"tool_call","tool":"<active_tool_name>","args":{},"content":"","memoryCandidates":[],"skillCandidates":[]}

For a tool call that needs a search query, keep unused args as empty strings:
{"type":"tool_call","tool":"<active_search_tool_name>","args":{"path":"","content":"","query":"cosia","directory":"","command":"","cwd":"","reason":"","expectedEffect":""},"content":"","memoryCandidates":[],"skillCandidates":[]}

For a final answer:
{"type":"final","tool":"","args":{"path":"","content":"","query":"","directory":"","command":"","cwd":"","reason":"","expectedEffect":""},"content":"...","memoryCandidates":[],"skillCandidates":[],"toolGrowthRequest":null,"toolGrowthDecision":null}

For a final answer that asks permission to create a missing runtime inspection tool:
{"type":"final","tool":"","args":{"path":"","content":"","query":"","directory":"","command":"","cwd":"","reason":"","expectedEffect":""},"content":"To answer this, COSIA needs a read-only <capability name> tool... Should I start the tool creation routine?","memoryCandidates":[],"skillCandidates":[],"toolGrowthRequest":{"request":"read-only <specific runtime inspector> for <specific queue/state>","capabilityName":"<capability_name>","summary":"Inspect <specific fields> without mutating files, approvals, memory, tools, policy, or connectors.","readOnly":true},"toolGrowthDecision":null}

For a final answer that interprets a reply to a pending tool-growth request:
{"type":"final","tool":"","args":{"path":"","content":"","query":"","directory":"","command":"","cwd":"","reason":"","expectedEffect":""},"content":"Okay. I will start that guided tool creation routine now.","memoryCandidates":[],"skillCandidates":[],"toolGrowthRequest":null,"toolGrowthDecision":{"action":"start","reason":"The user approved starting the pending guided tool-growth routine."}}
`;
}

function activeToolStateText(allowedTools: string[]): string {
  const details = allowedTools.map((tool) => {
    const entry = (toolCatalog as Record<string, typeof toolCatalog[keyof typeof toolCatalog] | undefined>)[tool];
    if (!entry) {
      return `- ${tool}: active workspace tool. Use only when the current request matches its purpose.`;
    }
    return `- ${tool}: ${entry.description} Permission: ${entry.permission}.`;
  });
  return `# ACTIVE TOOL STATE

Available tools for this run: ${allowedTools.join(", ") || "none"}
Tool details:
${details.join("\n") || "- none"}
Maximum tool loop depth: 5`;
}

function gatewayCommandContextText(input: PromptInput): string {
  const actor = input.gatewayActor;
  const chatId = String(actor?.chatId ?? "");
  const userId = String(actor?.userId ?? "");
  const chatType = actor?.chatType ?? "private";
  const privateMasterDirectChat = input.gatewayRole === "master"
    && chatType === "private"
    && chatId.length > 0
    && userId.length > 0
    && chatId === userId;
  return [
    "# GATEWAY COMMAND CONTEXT",
    `Source channel: ${input.sourceChannel ?? "unknown"}`,
    `Gateway role: ${input.gatewayRole ?? "unknown"}`,
    `Connector: ${actor?.connector ?? "unknown"}`,
    `Chat type: ${chatType}`,
    `Chat id equals user id: ${chatId.length > 0 && chatId === userId}`,
    `Private master direct chat: ${privateMasterDirectChat}`,
    "",
    "If Private master direct chat is true, normal workspace-local CLI mutation commandIds may be executed through cosia_runtime_command when the user explicitly asks. System-boundary, dangerous, shell, and pending apply/cancel commands remain blocked by runtime policy."
  ].join("\n");
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

function contextHealthLevel(chars: number, warningChars: number, criticalChars: number): PromptContextManifest["healthLevel"] {
  if (chars >= criticalChars) {
    return "critical";
  }
  if (chars >= warningChars) {
    return "warning";
  }
  return "ok";
}

function isPlaceholderSessionSummary(content: string): boolean {
  const normalized = content
    .replace(/^# SESSION SUMMARY\s*/i, "")
    .trim();
  return normalized.length === 0 || normalized === "No compact session summary yet.";
}

function countContextRuns(content: string): number {
  return [...content.matchAll(/^## Run .+$/gm)].length;
}
