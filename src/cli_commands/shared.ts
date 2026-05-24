import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { AgentManager } from "../runtime/agent_manager.js";
import { type ResetMode } from "../runtime/doctor.js";
import { createProvider } from "../runtime/model/provider_registry.js";
import { formatProviderFailure, ProviderError } from "../runtime/model/provider_errors.js";
import { PolicyManager } from "../runtime/policy_manager.js";
import type { PromptManifest } from "../runtime/prompt_builder.js";
import { SessionManager } from "../runtime/session_manager.js";
import { formatSessionChoices, sessionFromChoice } from "../runtime/start_flow.js";
import { getToolCatalogEntry, isToolId, toolCatalog, toolNameValues } from "../runtime/tool_catalog.js";
import { ToolRegistry } from "../runtime/tool_registry.js";
import { memoryScopeSchema, memoryTierSchema } from "../runtime/types.js";
import type { MemoryScope, MemoryTier, SessionMetadata, ToolName } from "../runtime/types.js";
import type { ActiveToolRecord } from "../runtime/tool_acquisition.js";
import { readText } from "../runtime/fs_utils.js";
import { requireWorkspaceRoot, workspaceRootForInit } from "../runtime/workspace.js";

export async function main(fn: (workspaceRoot: string) => Promise<void>, options: { allowUninitialized?: boolean } = {}): Promise<void> {
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

export function resolveResetMode(options: { state: boolean; factory: boolean }): ResetMode {
  if (options.state === options.factory) {
    throw new Error("Choose exactly one reset mode: --state or --factory.");
  }
  return options.factory ? "factory" : "state";
}

export async function askOnce(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

export async function createStartSession(workspaceRoot: string, goal: string): Promise<SessionMetadata> {
  const trimmedGoal = goal.trim();
  if (!trimmedGoal) {
    throw new Error("A session goal is required.");
  }
  const policy = await new PolicyManager(workspaceRoot).loadPolicy();
  const agentId = policy.agents.defaultAgentId;
  if (!agentId) {
    throw new Error("No default agent is configured. Run `cosia agent bootstrap` first.");
  }
  await new AgentManager(workspaceRoot).loadAgent(agentId);
  const session = await new SessionManager(workspaceRoot).createSession(agentId, trimmedGoal);
  console.log(`Created session: ${session.id}`);
  return session;
}

export function parseIntegerOption(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

export function parseNumberOption(value: string, name: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

export type ToolCliOptions = {
  args?: string;
  path?: string;
  staged: boolean;
  maxCount?: string;
  fromCapability?: string;
  request?: string;
  provider: string;
  agent?: string;
  reason?: string;
  yes: boolean;
  all: boolean;
  advanced: boolean;
};

export function normalizeCliToolId(value: string): ToolName {
  const candidate = value.replace(/-/g, "_");
  return isToolId(candidate) ? candidate : value;
}

export function parseCliToolArgs(toolId: ToolName, options: ToolCliOptions): Record<string, unknown> {
  const args = options.args ? parseJsonObjectOption(options.args, "args") : {};
  if (options.path !== undefined) {
    args.path = options.path;
  }
  if (options.staged) {
    args.staged = true;
  }
  if (options.maxCount !== undefined) {
    args.maxCount = parseIntegerOption(options.maxCount, "max-count");
  }
  if (Object.keys(args).length === 0) {
    return {};
  }
  return args;
}

export function parseJsonObjectOption(value: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Invalid --${name} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid --${name}: expected a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export function formatToolCatalog(activeTools: ActiveToolRecord[] = []): string {
  const grouped = new Map<string, ToolName[]>();
  for (const id of toolNameValues) {
    const entry = getToolCatalogEntry(id);
    const group = entry.category === "core" ? "core" : entry.extensionId;
    grouped.set(group, [...(grouped.get(group) ?? []), id]);
  }
  const lines = ["COSIA Tool Catalog", ""];
  for (const [group, ids] of grouped) {
    lines.push(group === "core" ? "Core Runtime Tools" : `Bundled Extension Tools: ${group}`);
    lines.push("Tool                 Permission       Exposure   Default  Description");
    for (const id of ids) {
      const entry = toolCatalog[id as keyof typeof toolCatalog];
      lines.push(`${id.padEnd(20)} ${entry.permission.padEnd(16)} ${entry.exposure.padEnd(10)} ${String(entry.defaultEnabled).padEnd(8)} ${entry.description}`);
    }
    lines.push("");
  }
  lines.push("Run:");
  lines.push("  cosia tool run <tool-id> --args \"{...}\"");
  lines.push("  cosia shell preview --command \"<command>\" --reason \"<reason>\"");
  lines.push("  cosia tool grow --request \"<request>\" --provider mock");
  lines.push("  cosia tool grow test <routine-id> --yes");
  lines.push("  cosia tool grow activate <routine-id> --agent <agent-id> --yes");
  lines.push("");
  lines.push("Advanced governance:");
  lines.push("  cosia tool draft --from-capability <capability-id>");
  lines.push("  cosia tool candidate review");
  lines.push("  cosia tool activate <candidate-id> --agent <agent-id> --yes");
  lines.push("  cosia tool blueprint list");
  if (activeTools.length) {
    lines.push("");
    lines.push("Workspace Active Tools");
    lines.push("Tool                 Status       Permission       Exposure   Agents");
    for (const tool of activeTools) {
      lines.push(`${tool.id.padEnd(20)} ${tool.status.padEnd(12)} ${tool.permission.padEnd(16)} ${tool.exposure.padEnd(10)} ${tool.targetAgentIds.join(",") || "-"}`);
    }
  }
  lines.push("");
  lines.push("Zero-base capability flow:");
  lines.push("  cosia capability scan --request \"<request>\"");
  lines.push("  cosia capability plan --request \"<request>\"");
  lines.push("  cosia capability facts --latest");
  lines.push("  cosia capability review");
  return lines.join("\n");
}

export async function resolveMemoryTierOptions(
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

export async function resolveBootstrapOptions(options: {
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

export async function promptHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  try {
    const value = await rl.question("");
    process.stdout.write("\n");
    if (!value.trim()) {
      throw new Error("Secret value is required.");
    }
    return value.trim();
  } finally {
    rl.close();
  }
}

export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function formatPromptManifest(manifest: PromptManifest): string {
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
  if (manifest.context) {
    lines.push("Context:");
    lines.push(`- chars:${manifest.context.chars} health:${manifest.context.healthLevel} summaryPlaceholder:${manifest.context.summaryIsPlaceholder} compactRecommended:${manifest.context.compactRecommended}`);
  }
  return lines.join("\n");
}

export async function printSessionList(workspaceRoot: string, sessions: SessionMetadata[]): Promise<void> {
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

export function formatContextHealth(health: { sessionId: string; chars: number; warningChars: number; criticalChars: number; level: string }): string {
  return `${health.sessionId} ${health.level} ${health.chars} chars (warning:${health.warningChars}, critical:${health.criticalChars})`;
}

export function formatContextStatus(status: {
  sessionId: string;
  chars: number;
  warningChars: number;
  criticalChars: number;
  level: string;
  runEntryCount: number;
  archiveEntryCount: number;
  summaryIsPlaceholder: boolean;
  compactRecommended: boolean;
}): string {
  return [
    `Session: ${status.sessionId}`,
    "Layer: working context (CONTEXT_MEMORY.md), not reviewed durable memory.",
    `Working context: ${status.level} ${status.chars} chars (warning:${status.warningChars}, critical:${status.criticalChars})`,
    `Run entries: ${status.runEntryCount}`,
    `Archived entries: ${status.archiveEntryCount}`,
    `Compact summary placeholder: ${status.summaryIsPlaceholder}`,
    `Compact recommended: ${status.compactRecommended}`
  ].join("\n");
}

export function formatContextCompactResult(result: {
  applied: boolean;
  blocked: boolean;
  movedAt?: string;
  message: string;
  contextCharsBefore: number;
  contextCharsAfter: number;
  keptRuns: number;
  archivedRuns: number;
  summaryIsPlaceholder: boolean;
}): string {
  const lines = [
    result.message,
    `Applied: ${result.applied}`,
    `Blocked: ${result.blocked}`,
    `Kept runs: ${result.keptRuns}`,
    `Archived runs: ${result.archivedRuns}`,
    `Working context chars: ${result.contextCharsBefore} -> ${result.contextCharsAfter}`,
    `Compact summary placeholder: ${result.summaryIsPlaceholder}`
  ];
  if (result.blocked && result.summaryIsPlaceholder) {
    lines.push("Next: write SESSION_SUMMARY.md first, or pass --allow-empty-summary if this archive is acceptable without a compact summary.");
  }
  if (result.movedAt) {
    lines.push(`Moved at: ${result.movedAt}`);
  }
  return lines.join("\n");
}

export function contextCriticalHint(sessionId: string): string {
  return contextMaintenanceHint(sessionId);
}

export function contextMaintenanceHint(sessionId: string): string {
  return [
    "Suggested context maintenance:",
    `- cosia session context status ${sessionId}`,
    `- cosia session prompt ${sessionId} --latest`,
    `- cosia session summarize ${sessionId} --content \"<summary>\"`,
    `- cosia session summarize ${sessionId} --from-context --provider <provider>`,
    `- cosia session context compact ${sessionId} --keep-last 5 --reason \"<reason>\"`,
    `- cosia session context undo-last ${sessionId} --reason \"<reason>\"`
  ].join("\n");
}

export async function generateSessionSummary(
  workspaceRoot: string,
  session: SessionMetadata,
  providerId: string,
  options: { timeoutMs?: number; contextChars: number }
): Promise<string> {
  const sessions = new SessionManager(workspaceRoot);
  const policy = await new PolicyManager(workspaceRoot).loadPolicy();
  const source = await sessions.summarySource(session.id, options.contextChars);
  let providerIdForFailure = providerId;
  try {
    const provider = createProvider(providerId, workspaceRoot, {
      policy,
      timeoutMs: options.timeoutMs
    });
    providerIdForFailure = provider.id;
    if (provider.id !== "mock") {
      const auth = await provider.checkAuth();
      if (!auth.ok) {
        throw new ProviderError(auth.reason ?? "auth_failed", `Model provider auth failed: ${auth.message}`, {
          hint: auth.hint
        });
      }
    }
    const output = await provider.complete({
      sessionId: session.id,
      prompt: buildSessionSummaryPrompt(session, source)
    });
    if (output.step.type !== "final") {
      throw new ProviderError("malformed_agent_step", "Summary provider returned a tool_call; expected final.");
    }
    return output.step.content.trim();
  } catch (error) {
    throw new Error(formatProviderFailure(error, providerIdForFailure));
  }
}

export function buildSessionSummaryPrompt(
  session: SessionMetadata,
  source: {
    existingSummary: string;
    summaryIsPlaceholder: boolean;
    contextTail: string;
    contextChars: number;
    retainedContextChars: number;
    runEntryCount: number;
  }
): string {
  return `Return only one valid JSON object. Do not wrap it in Markdown.

You are updating COSIA's SESSION_SUMMARY.md for a single session.
Return a concise durable summary of the session so far.
Preserve goals, important decisions, current state, blockers, and next actions.
Do not invent facts outside the provided context.
Do not call tools.

AgentStep final schema:
{"type":"final","content":"...","memoryCandidates":[],"skillCandidates":[]}

Session:
- id: ${session.id}
- goal: ${session.goal}
- status: ${session.status}
- assigned agent: ${session.assignedAgentId ?? "none"}

Existing summary (${source.summaryIsPlaceholder ? "placeholder" : "user-written"}):
${source.existingSummary}

Context source:
- total chars: ${source.contextChars}
- retained chars: ${source.retainedContextChars}
- run entries: ${source.runEntryCount}

Context tail:
${source.contextTail}
`;
}

export async function runCliTool(workspaceRoot: string, name: ToolName, args: Record<string, unknown>): Promise<void> {
  const result = await new ToolRegistry().execute(name, args, {
    workspaceRoot,
    allowedTools: [name],
    sourceChannel: "cli"
  });
  console.log(result.content);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

export async function readRawPolicy(workspaceRoot: string): Promise<unknown> {
  return JSON.parse(await readText(join(workspaceRoot, "codex", "POLICY.json"))) as unknown;
}
