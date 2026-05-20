import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, pathExists, readText, writeTextIfMissing } from "./fs_utils.js";
import {
  architectAgentTemplates,
  architectAllowedTools,
  architectManifest,
  cosiaAgentTemplates,
  cosiaAllowedTools,
  cosiaManifest
} from "./templates.js";
import { agentManifestSchema, type AgentManifest } from "./types.js";
import { normalizeTriggerText, triggerMatches } from "./skills/skill_text.js";

export const defaultCosiaAgentId = "cosia-agent";

export type AgentDeleteResult = {
  changed: boolean;
  agentId: string;
  agentPath: string;
  isDefault: boolean;
  isLastAgent: boolean;
  referencedSessions: string[];
  message: string;
};

export type AgentBootstrapInput = {
  id: string;
  name: string;
  role: string;
  voice: string;
  priorities?: string[];
  boundaries?: string[];
};

export type AgentRecommendationRow = {
  agentId: string;
  status: "SELECTED" | "CANDIDATE";
  totalScore: number;
  promptScore: number;
  goalScore: number;
  matchedTriggers: string[];
  reason: string;
};

export class AgentManager {
  constructor(private readonly workspaceRoot: string) {}

  async createAgent(agentId: string, template: string): Promise<AgentManifest> {
    if (!["architect", "cosia"].includes(template)) {
      throw new Error(`Unsupported agent template: ${template}`);
    }
    const agentDir = this.agentDir(agentId);
    if (await pathExists(agentDir)) {
      throw new Error(`Agent already exists: ${agentId}`);
    }
    await mkdir(agentDir, { recursive: true });
    const templates = template === "cosia" ? cosiaAgentTemplates : architectAgentTemplates;
    for (const [fileName, content] of Object.entries(templates)) {
      await writeTextIfMissing(join(agentDir, fileName), content);
    }
    const manifest = template === "cosia" ? cosiaManifest(agentId) : architectManifest(agentId);
    await writeFile(join(agentDir, "manifest.json"), `${JSON.stringify(serializeAgentManifest(manifest), null, 2)}\n`, "utf8");
    return manifest;
  }

  async bootstrapAgent(input: AgentBootstrapInput): Promise<AgentManifest> {
    const agentDir = this.agentDir(input.id);
    if (await pathExists(agentDir)) {
      throw new Error(`Agent already exists: ${input.id}`);
    }
    await mkdir(agentDir, { recursive: true });
    const priorities = normalizeList(input.priorities);
    const boundaries = normalizeList(input.boundaries);
    const manifest: AgentManifest = {
      ...cosiaManifest(input.id),
      name: input.name,
      description: input.role,
      identity: {
        role: input.role,
        voice: input.voice,
        operatingStyle: [
          "Use COSIA policy, memory, skills, and tools as runtime boundaries.",
          "Ask for clarification only when a decision cannot be inferred safely."
        ],
        priorities,
        boundaries
      },
      selectionTriggers: normalizeList([
        input.name,
        input.role,
        ...priorities
      ])
    };
    const files = renderCustomAgentFiles(manifest);
    for (const [fileName, content] of Object.entries(files)) {
      await writeTextIfMissing(join(agentDir, fileName), content);
    }
    await writeFile(join(agentDir, "manifest.json"), `${JSON.stringify(serializeAgentManifest(agentManifestSchema.parse(manifest)), null, 2)}\n`, "utf8");
    return manifest;
  }

  async loadAgent(agentId: string): Promise<AgentManifest> {
    const manifestPath = join(this.agentDir(agentId), "manifest.json");
    if (!(await pathExists(manifestPath))) {
      throw new Error(`Agent manifest not found: ${agentId}. Run \`cosia agent bootstrap\` to create a default agent, or choose an existing agent.`);
    }
    const parsed = JSON.parse(await readText(manifestPath));
    const manifest = agentManifestSchema.parse(parsed);
    const repaired = repairAgentManifest(manifest, parsed);
    if (
      repaired !== manifest ||
      !("identity" in parsed) ||
      !("selectionTriggers" in parsed) ||
      !("preferredSkills" in parsed) ||
      !("blockedSkills" in parsed) ||
      !("skillWeights" in parsed)
    ) {
      await writeFile(manifestPath, `${JSON.stringify(serializeAgentManifest(repaired), null, 2)}\n`, "utf8");
    }
    return repaired;
  }

  async listAgents(): Promise<AgentManifest[]> {
    const agentsDir = join(this.workspaceRoot, "agents");
    if (!(await pathExists(agentsDir))) {
      return [];
    }
    const entries = await readdir(agentsDir, { withFileTypes: true });
    const agents: AgentManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        agents.push(await this.loadAgent(entry.name));
      } catch {
        // Ignore incomplete agent folders in status/list output.
      }
    }
    return agents.sort((left, right) => left.id.localeCompare(right.id));
  }

  async ensureDefaultAgent(defaultAgentId: string | null | undefined): Promise<string[]> {
    const created: string[] = [];
    const agents = await this.listAgents();
    if (agents.length > 0 && defaultAgentId && agents.some((agent) => agent.id === defaultAgentId)) {
      return created;
    }
    if (agents.length > 0 && defaultAgentId !== defaultCosiaAgentId) {
      return created;
    }
    const id = defaultAgentId || defaultCosiaAgentId;
    if (!(await pathExists(this.agentDir(id)))) {
      await this.createAgent(id, id === defaultCosiaAgentId ? "cosia" : "cosia");
      created.push(`agents/${id}/`);
    }
    return created;
  }

  async deleteAgent(agentId: string, options: {
    yes?: boolean;
    force?: boolean;
    allowEmpty?: boolean;
    defaultAgentId?: string | null;
  } = {}): Promise<AgentDeleteResult> {
    const agentPath = this.agentDir(agentId);
    if (!(await pathExists(agentPath))) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const agents = await this.listAgents();
    const isDefault = options.defaultAgentId === agentId;
    const isLastAgent = agents.length <= 1;
    const referencedSessions = await this.sessionReferences(agentId);
    if (!options.yes) {
      return {
        changed: false,
        agentId,
        agentPath,
        isDefault,
        isLastAgent,
        referencedSessions,
        message: "Agent delete preview. Re-run with --yes to delete."
      };
    }
    if (isDefault && !options.allowEmpty) {
      throw new Error(`Cannot delete default agent: ${agentId}. Set another default agent first, or use --force --allow-empty.`);
    }
    if (isLastAgent && !options.allowEmpty) {
      throw new Error(`Cannot delete the last agent: ${agentId}. Use --force --allow-empty to leave the workspace without agents.`);
    }
    if (referencedSessions.length && !options.force) {
      throw new Error(`Agent is referenced by sessions: ${referencedSessions.join(", ")}. Use --force to delete anyway.`);
    }
    if ((isDefault || isLastAgent) && !options.force) {
      throw new Error(`Deleting ${agentId} requires --force because it is ${isDefault ? "the default agent" : "the last agent"}.`);
    }
    await rm(agentPath, { recursive: true, force: true });
    return {
      changed: true,
      agentId,
      agentPath,
      isDefault,
      isLastAgent,
      referencedSessions,
      message: "Deleted agent."
    };
  }

  async recommendAgent(input: {
    prompt: string;
    goal?: string;
    defaultAgentId?: string | null;
  }): Promise<AgentRecommendationRow[]> {
    const agents = await this.listAgents();
    const rows = agents.map((agent) => scoreAgent(agent, input.prompt, input.goal ?? ""));
    rows.sort((left, right) => {
      if (right.totalScore !== left.totalScore) {
        return right.totalScore - left.totalScore;
      }
      if ((left.agentId === input.defaultAgentId) !== (right.agentId === input.defaultAgentId)) {
        return left.agentId === input.defaultAgentId ? -1 : 1;
      }
      return left.agentId.localeCompare(right.agentId);
    });
    return rows.map((row, index) => ({
      ...row,
      status: index === 0 ? "SELECTED" as const : "CANDIDATE" as const,
      reason: row.totalScore > 0 ? row.reason : (row.agentId === input.defaultAgentId ? "defaultAgent" : "noTriggerMatch")
    }));
  }

  async ensureAgentsDir(): Promise<void> {
    await ensureDir(join(this.workspaceRoot, "agents"));
  }

  agentDir(agentId: string): string {
    return join(this.workspaceRoot, "agents", agentId);
  }

  private async sessionReferences(agentId: string): Promise<string[]> {
    const sessionsDir = join(this.workspaceRoot, "sessions");
    if (!(await pathExists(sessionsDir))) {
      return [];
    }
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    const sessionIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        const parsed = JSON.parse(await readText(join(sessionsDir, entry.name, "session.json"))) as { agentId?: string };
        if (parsed.agentId === agentId) {
          sessionIds.push(entry.name);
        }
      } catch {
        // Ignore incomplete session folders.
      }
    }
    return sessionIds.sort();
  }
}

function serializeAgentManifest(manifest: AgentManifest): Record<string, unknown> {
  const output: Record<string, unknown> = { ...manifest };
  if (!manifest.skills.length) {
    delete output.skills;
  }
  if (!Object.keys(manifest.skillTriggers ?? {}).length) {
    delete output.skillTriggers;
  }
  return output;
}

function repairAgentManifest(manifest: AgentManifest, raw: Record<string, unknown>): AgentManifest {
  const isArchitect = manifest.name === "Architect Agent";
  const isCosia = manifest.name === "COSIA Agent" || manifest.id === defaultCosiaAgentId;
  const template = isArchitect
    ? architectManifest(manifest.id)
    : isCosia
      ? cosiaManifest(manifest.id)
      : undefined;
  const allowedTools = template
    ? [...new Set([...manifest.allowedTools, ...(isArchitect ? architectAllowedTools : cosiaAllowedTools)])]
    : manifest.allowedTools;
  const preferredSkills = manifest.preferredSkills ?? [];
  const blockedSkills = manifest.blockedSkills ?? [];
  const skillWeights = manifest.skillWeights ?? {};
  const identity = "identity" in raw ? manifest.identity : (template?.identity ?? manifest.identity);
  const selectionTriggers = "selectionTriggers" in raw ? manifest.selectionTriggers : (template?.selectionTriggers ?? manifest.selectionTriggers);
  if (
    allowedTools.length === manifest.allowedTools.length &&
    manifest.identity === identity &&
    manifest.selectionTriggers === selectionTriggers &&
    manifest.preferredSkills === preferredSkills &&
    manifest.blockedSkills === blockedSkills &&
    manifest.skillWeights === skillWeights
  ) {
    return manifest;
  }
  return {
    ...manifest,
    identity,
    selectionTriggers,
    allowedTools,
    preferredSkills,
    blockedSkills,
    skillWeights
  };
}

function renderCustomAgentFiles(manifest: AgentManifest): Record<string, string> {
  return {
    "AGENT.md": `# ${manifest.name}

${manifest.identity.role}
`,
    "LOCAL_RULES.md": `# LOCAL RULES

${manifest.identity.boundaries.map((item) => `- ${item}`).join("\n") || "- Follow Codex and runtime policy constraints."}
`,
    "STYLE.md": `# STYLE

${manifest.identity.voice}
`,
    "SKILLS.md": `# SKILLS

This file is generated by COSIA as an agent preference view over the global skill toolbox.

No promoted skills.
`
  };
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function scoreAgent(agent: AgentManifest, prompt: string, goal: string): Omit<AgentRecommendationRow, "status"> {
  const current = normalizeTriggerText(prompt);
  const sessionGoal = normalizeTriggerText(goal);
  const matchedTriggers: string[] = [];
  let promptScore = 0;
  let goalScore = 0;
  for (const trigger of normalizeList(agent.selectionTriggers)) {
    if (trigger.length <= 2) {
      continue;
    }
    const normalized = normalizeTriggerText(trigger);
    const promptMatch = triggerMatches(normalized, current);
    const goalMatch = triggerMatches(normalized, sessionGoal);
    if (promptMatch || goalMatch) {
      matchedTriggers.push(normalized);
    }
    if (promptMatch) {
      promptScore += 5;
    }
    if (goalMatch) {
      goalScore += 2;
    }
  }
  const totalScore = promptScore + goalScore;
  return {
    agentId: agent.id,
    totalScore,
    promptScore,
    goalScore,
    matchedTriggers,
    reason: promptScore > 0 ? "triggerMatch" : goalScore > 0 ? "goalMatch" : "noTriggerMatch"
  };
}

export function formatAgentRecommendation(rows: AgentRecommendationRow[]): string {
  if (!rows.length) {
    return "No agents. Run `cosia agent bootstrap` to create one.";
  }
  const header = [
    pad("Agent", 20),
    pad("Status", 10),
    pad("Total", 5),
    pad("Prompt", 6),
    pad("Goal", 4),
    "Reason"
  ].join("  ");
  const body = rows.map((row) => [
    pad(row.agentId, 20),
    pad(row.status, 10),
    pad(String(row.totalScore), 5),
    pad(String(row.promptScore), 6),
    pad(String(row.goalScore), 4),
    row.reason
  ].join("  "));
  return [header, ...body].join("\n");
}

export function formatAgentDeleteResult(result: AgentDeleteResult): string {
  const lines = [
    result.changed ? "Deleted agent." : "Agent delete preview. No changes made.",
    `Agent: ${result.agentId}`,
    `Path: ${result.agentPath}`,
    `Default: ${result.isDefault}`,
    `Last agent: ${result.isLastAgent}`,
    `Referenced sessions: ${result.referencedSessions.length ? result.referencedSessions.join(", ") : "none"}`
  ];
  if (!result.changed) {
    lines.push("Re-run with --yes to delete.");
  }
  if (result.isDefault || result.isLastAgent) {
    lines.push("Deleting a default or last agent requires --force --allow-empty.");
  }
  return lines.join("\n");
}

function pad(value: string, length: number): string {
  return value.length >= length ? value : `${value}${" ".repeat(length - value.length)}`;
}
