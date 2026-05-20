import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, relative } from "node:path";
import { detectSecrets } from "./risk_classifier.js";
import { agentManifestSchema, type AgentManifest, type RiskLevel, type SessionMetadata, type SkillCandidate, skillCandidateRecordSchema, type SkillCandidateRecord } from "./types.js";

type SkillCandidateRow = {
  id: string;
  record_json: string;
};

export type SkillCandidateView = {
  displayId: string;
  record: SkillCandidateRecord;
};

export type SkillRecord = {
  id: string;
  agentId: string;
  path: string;
  content: string;
  triggers: string[];
  manualOnly: boolean;
};

export type SkillCheckResult = {
  ok: boolean;
  agentId: string;
  mirrorExists: boolean;
  mirrorMatches: boolean;
  repaired: boolean;
  missingSkillFiles: string[];
  orphanSkillFiles: string[];
  manualOnlySkills: string[];
};

export type SkillTriggerMatch = {
  skillId: string;
  score: number;
  matchedTriggers: string[];
  matchedFrom: Array<"current_request" | "session_goal">;
};

export type SkillSelectionManifest = {
  skillId: string;
  selected: boolean;
  selectedBy: "manual" | "trigger";
  triggerScore: number;
  matchedTriggers: string[];
  matchedFrom: Array<"current_request" | "session_goal">;
  originalChars: number;
  retainedChars: number;
  truncated: boolean;
  omittedReason?: string;
};

export type SkillPromptBlock = {
  title: string;
  content: string;
  manifest: SkillSelectionManifest[];
};

export type SkillBudget = {
  skillMaxItems: number;
  skillMaxChars: number;
  skillItemMaxChars: number;
};

type PromoteSkillOptions = {
  yes?: boolean;
  confirmHighRisk?: string;
};

export type PromoteSkillResult = {
  changed: boolean;
  record: SkillCandidateRecord;
  skillPath: string;
  manifestPath: string;
  skillsIndexPath: string;
  warning?: string;
};

const highRiskConfirmPhrase = "PROMOTE HIGH RISK SKILL";

export class SkillManager {
  constructor(private readonly workspaceRoot: string) {}

  ensureSchema(): void {
    this.ensureMemoryDir();
    const db = this.open();
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_candidates (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          skill_name TEXT NOT NULL,
          skill_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          content TEXT NOT NULL,
          triggers_json TEXT NOT NULL,
          risk_level TEXT NOT NULL,
          source_session_id TEXT,
          source_agent_id TEXT,
          run_id TEXT,
          created_at TEXT NOT NULL,
          reviewed_at TEXT,
          promoted_skill_id TEXT,
          discard_reason TEXT,
          record_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    } finally {
      db.close();
    }
  }

  appendCandidates(candidates: SkillCandidate[] | undefined, session: SessionMetadata, runId?: string): SkillCandidateRecord[] {
    if (!candidates?.length) {
      return [];
    }
    this.ensureSchema();
    const now = new Date().toISOString();
    const records = candidates.map((candidate) => {
      const id = randomUUID();
      const triggers = normalizeTriggers(candidate.triggers ?? []);
      const record: SkillCandidateRecord = {
        id,
        status: "pending",
        agentId: candidate.agentId || session.agentId,
        skillName: candidate.skillName,
        skillId: slugifySkillId(candidate.skillName, id),
        reason: candidate.reason,
        content: candidate.content,
        triggers,
        riskLevel: classifySkillRisk(candidate),
        sourceSessionId: session.id,
        sourceAgentId: session.agentId,
        runId,
        createdAt: now
      };
      return skillCandidateRecordSchema.parse(record);
    });
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const record of records) {
          upsertSkillCandidateRow(db, record);
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the original error.
        }
        throw error;
      }
    } finally {
      db.close();
    }
    return records;
  }

  listCandidates(includeAll = false): SkillCandidateView[] {
    return this.readCandidateEntries().filter((entry) => includeAll || entry.record.status === "pending");
  }

  getCandidate(candidateId: string): SkillCandidateView {
    return resolveSkillCandidate(this.readCandidateEntries(), candidateId, true);
  }

  exportCandidatesJsonl(): string {
    const records = this.readCandidateEntries().map((entry) => entry.record);
    return records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
  }

  discardCandidate(candidateId: string, reason: string): SkillCandidateRecord {
    const entry = resolveSkillCandidate(this.readCandidateEntries(), candidateId, false);
    if (entry.record.status !== "pending") {
      throw new Error(`Skill candidate is not pending: ${candidateId}`);
    }
    const updated = {
      ...entry.record,
      status: "discarded" as const,
      reviewedAt: new Date().toISOString(),
      discardReason: reason
    };
    const db = this.open();
    try {
      upsertSkillCandidateRow(db, updated);
    } finally {
      db.close();
    }
    return updated;
  }

  promoteCandidate(candidateId: string, options: PromoteSkillOptions = {}): PromoteSkillResult {
    const entry = resolveSkillCandidate(this.readCandidateEntries(), candidateId, false);
    const record = entry.record;
    if (record.status !== "pending") {
      throw new Error(`Skill candidate is not pending: ${candidateId}`);
    }
    const agentDir = this.agentDir(record.agentId);
    const skillPath = this.skillPath(record.agentId, record.skillId);
    const manifestPath = join(agentDir, "manifest.json");
    const skillsIndexPath = join(agentDir, "SKILLS.md");
    const warning = record.triggers.length
      ? undefined
      : "Warning: this skill has no triggers and will be manual-only unless selected with --skill or /skills use.";

    if (existsSync(skillPath)) {
      throw new Error(`Skill already exists: ${record.skillId}`);
    }
    if (!options.yes) {
      return { changed: false, record, skillPath, manifestPath, skillsIndexPath, warning };
    }
    if (record.riskLevel === "high" && options.confirmHighRisk !== highRiskConfirmPhrase) {
      throw new Error(`High-risk skill promotion requires --confirm-high-risk "${highRiskConfirmPhrase}"`);
    }

    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, renderSkillFile(record), "utf8");
    const manifest = this.readAgentManifest(record.agentId);
    const nextManifest: AgentManifest = {
      ...manifest,
      skills: [...new Set([...manifest.skills, record.skillId])],
      skillTriggers: {
        ...(manifest.skillTriggers ?? {}),
        [record.skillId]: record.triggers
      }
    };
    this.writeAgentManifest(record.agentId, nextManifest);
    this.writeSkillsIndex(record.agentId, nextManifest);

    const updated = {
      ...record,
      status: "promoted" as const,
      reviewedAt: new Date().toISOString(),
      promotedSkillId: record.skillId
    };
    const db = this.open();
    try {
      upsertSkillCandidateRow(db, updated);
    } finally {
      db.close();
    }
    return { changed: true, record: updated, skillPath, manifestPath, skillsIndexPath, warning };
  }

  listSkills(agentId: string): SkillRecord[] {
    const manifest = this.readAgentManifest(agentId);
    return manifest.skills.map((skillId) => this.getSkill(agentId, skillId));
  }

  getSkill(agentId: string, skillId: string): SkillRecord {
    const manifest = this.readAgentManifest(agentId);
    const resolvedSkillId = resolveSkillId(manifest.skills, skillId);
    const skillPath = this.skillPath(agentId, resolvedSkillId);
    if (!existsSync(skillPath)) {
      throw new Error(`Skill file not found: ${resolvedSkillId}`);
    }
    const content = readFileSync(skillPath, "utf8");
    const triggers = manifest.skillTriggers?.[resolvedSkillId] ?? [];
    return {
      id: resolvedSkillId,
      agentId,
      path: skillPath,
      content,
      triggers,
      manualOnly: triggers.length === 0
    };
  }

  syncSkillsIndex(agentId: string): string {
    const manifest = this.readAgentManifest(agentId);
    this.writeSkillsIndex(agentId, manifest);
    return join(this.agentDir(agentId), "SKILLS.md");
  }

  checkSkills(agentId: string, repair = false): SkillCheckResult {
    const manifest = this.readAgentManifest(agentId);
    const skillsDir = join(this.agentDir(agentId), "skills");
    if (!existsSync(skillsDir)) {
      mkdirSync(skillsDir, { recursive: true });
    }
    const mirrorPath = join(this.agentDir(agentId), "SKILLS.md");
    const expectedMirror = renderSkillsIndex(agentId, manifest);
    const mirrorExists = existsSync(mirrorPath);
    let mirrorMatches = mirrorExists && readFileSync(mirrorPath, "utf8").replace(/\r\n/g, "\n") === expectedMirror.replace(/\r\n/g, "\n");
    let repaired = false;
    const missingSkillFiles = manifest.skills.filter((skillId) => !existsSync(this.skillPath(agentId, skillId)));
    const skillSet = new Set(manifest.skills);
    const orphanSkillFiles = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -3))
      .filter((skillId) => !skillSet.has(skillId));
    const manualOnlySkills = manifest.skills.filter((skillId) => (manifest.skillTriggers?.[skillId] ?? []).length === 0);
    if (repair && !mirrorMatches) {
      this.writeSkillsIndex(agentId, manifest);
      mirrorMatches = true;
      repaired = true;
    }
    return {
      ok: mirrorMatches && missingSkillFiles.length === 0,
      agentId,
      mirrorExists,
      mirrorMatches,
      repaired,
      missingSkillFiles,
      orphanSkillFiles,
      manualOnlySkills
    };
  }

  selectSkillPromptBlock(input: {
    agent: AgentManifest;
    sessionGoal: string;
    currentRequest: string;
    manualSkillIds?: string[];
    budget: SkillBudget;
  }): SkillPromptBlock | undefined {
    const skills = input.agent.skills;
    const manualSkillIds = [...new Set(input.manualSkillIds ?? [])].map((skillId) => resolveSkillId(skills, skillId));
    const manifestOrder = new Map(skills.map((skillId, index) => [skillId, index]));
    const matches = skills.map((skillId) => calculateSkillTriggerMatch({
      skillId,
      triggers: input.agent.skillTriggers?.[skillId] ?? [],
      sessionGoal: input.sessionGoal,
      currentRequest: input.currentRequest
    }));
    const candidates = matches
      .map((match) => ({
        match,
        selectedBy: manualSkillIds.includes(match.skillId) ? "manual" as const : "trigger" as const
      }))
      .filter((item) => item.selectedBy === "manual" || item.match.score > 0)
      .sort((left, right) => {
        if (left.selectedBy !== right.selectedBy) {
          return left.selectedBy === "manual" ? -1 : 1;
        }
        if (right.match.score !== left.match.score) {
          return right.match.score - left.match.score;
        }
        return (manifestOrder.get(left.match.skillId) ?? 0) - (manifestOrder.get(right.match.skillId) ?? 0);
      });

    const manifest: SkillSelectionManifest[] = [];
    const renderedSkills: string[] = [];
    let retainedTotal = 0;
    for (const item of candidates) {
      const skill = this.getSkill(input.agent.id, item.match.skillId);
      const original = skill.content;
      let content = neutralizeXmlBoundaries(original);
      let truncated = false;
      if (content.length > input.budget.skillItemMaxChars) {
        content = truncateSkillContent(content, input.budget.skillItemMaxChars, skill.id);
        truncated = true;
      }
      const rendered = renderSkillPromptItem(skill, item.match, item.selectedBy, content);
      if (renderedSkills.length >= input.budget.skillMaxItems) {
        manifest.push(selectionManifest(item, original.length, 0, false, "skillMaxItems"));
        continue;
      }
      if (retainedTotal + rendered.length > input.budget.skillMaxChars) {
        manifest.push(selectionManifest(item, original.length, 0, false, "skillMaxChars"));
        continue;
      }
      renderedSkills.push(rendered);
      retainedTotal += rendered.length;
      manifest.push(selectionManifest(item, original.length, content.length, truncated));
    }
    if (!renderedSkills.length && !manifest.length) {
      return undefined;
    }
    return {
      title: "SELECTED SKILLS",
      content: `<available_skills>\n${renderedSkills.join("\n")}\n</available_skills>`,
      manifest
    };
  }

  private readCandidateEntries(): SkillCandidateView[] {
    this.ensureSchema();
    const db = this.open();
    try {
      const rows = db.prepare("SELECT id, record_json FROM skill_candidates ORDER BY created_at ASC, rowid ASC").all() as SkillCandidateRow[];
      return rows.map((row) => ({ displayId: row.id, record: skillCandidateRecordSchema.parse(JSON.parse(row.record_json)) }));
    } finally {
      db.close();
    }
  }

  private readAgentManifest(agentId: string): AgentManifest {
    const manifestPath = join(this.agentDir(agentId), "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`Agent manifest not found: ${agentId}`);
    }
    return agentManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  }

  private writeAgentManifest(agentId: string, manifest: AgentManifest): void {
    writeFileSync(join(this.agentDir(agentId), "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  private writeSkillsIndex(agentId: string, manifest: AgentManifest): void {
    writeFileSync(join(this.agentDir(agentId), "SKILLS.md"), renderSkillsIndex(agentId, manifest), "utf8");
  }

  private agentDir(agentId: string): string {
    return join(this.workspaceRoot, "agents", agentId);
  }

  private skillPath(agentId: string, skillId: string): string {
    return join(this.agentDir(agentId), "skills", `${skillId}.md`);
  }

  private ensureMemoryDir(): void {
    const dir = join(this.workspaceRoot, "memory");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private open(): DatabaseSync {
    return new DatabaseSync(join(this.workspaceRoot, "memory", "longterm.sqlite"));
  }
}

export function calculateSkillTriggerMatch(input: {
  skillId: string;
  triggers: string[];
  sessionGoal: string;
  currentRequest: string;
}): SkillTriggerMatch {
  const current = normalizeTriggerText(input.currentRequest);
  const goal = normalizeTriggerText(input.sessionGoal);
  const matchedTriggers: string[] = [];
  const matchedFrom = new Set<"current_request" | "session_goal">();
  let score = 0;
  for (const trigger of normalizeTriggers(input.triggers)) {
    if (trigger.length <= 2) {
      continue;
    }
    const currentMatch = triggerMatches(trigger, current);
    const goalMatch = triggerMatches(trigger, goal);
    if (currentMatch || goalMatch) {
      matchedTriggers.push(trigger);
    }
    if (currentMatch) {
      score += 5;
      matchedFrom.add("current_request");
    }
    if (goalMatch) {
      score += 2;
      matchedFrom.add("session_goal");
    }
  }
  return {
    skillId: input.skillId,
    score,
    matchedTriggers,
    matchedFrom: [...matchedFrom]
  };
}

export function formatSkillCandidate(record: SkillCandidateRecord): string {
  const secret = detectSecrets(record.content);
  const content = secret.matched ? secret.redactedPreview : preview(record.content);
  const triggerText = record.triggers.length ? record.triggers.join(", ") : "manual-only";
  return `${record.id}\t${record.status}\t${record.riskLevel}\t${record.agentId}/${record.skillId}\ttriggers:${triggerText}\t${content}`;
}

export function formatSkillPromotionPreview(result: PromoteSkillResult): string {
  const secret = detectSecrets(result.record.content);
  const content = secret.matched ? secret.redactedPreview : preview(result.record.content);
  const lines = [
    result.changed ? "Promoted skill candidate." : "Skill promotion preview. No changes made.",
    `Candidate: ${result.record.id}`,
    `Agent: ${result.record.agentId}`,
    `Skill: ${result.record.skillId}`,
    `Risk: ${result.record.riskLevel}`,
    `Triggers: ${result.record.triggers.length ? result.record.triggers.join(", ") : "manual-only"}`,
    `Skill file: ${relative(process.cwd(), result.skillPath)}`,
    `Manifest: ${relative(process.cwd(), result.manifestPath)}`,
    `SKILLS mirror: ${relative(process.cwd(), result.skillsIndexPath)}`,
    `Content: ${content}`
  ];
  if (result.warning) {
    lines.push(result.warning);
  }
  if (!result.changed) {
    lines.push("Re-run with --yes to apply this promotion.");
  }
  if (result.record.riskLevel === "high") {
    lines.push(`High-risk confirmation: --confirm-high-risk "${highRiskConfirmPhrase}"`);
  }
  return lines.join("\n");
}

export function formatSkillCheckResult(result: SkillCheckResult): string {
  const lines = [
    `Agent: ${result.agentId}`,
    `SKILLS.md: ${result.mirrorMatches ? "ok" : "stale/missing"}`,
    `Skill files: ${result.missingSkillFiles.length ? "missing files" : "ok"}`
  ];
  if (result.repaired) {
    lines.push("Repaired: SKILLS.md");
  }
  for (const skillId of result.manualOnlySkills) {
    lines.push(`Warning: ${skillId} is manual-only because it has no triggers.`);
  }
  for (const skillId of result.orphanSkillFiles) {
    lines.push(`Warning: orphan skill file is not listed in manifest: ${skillId}.md`);
  }
  for (const skillId of result.missingSkillFiles) {
    lines.push(`Error: manifest skill is missing its file: ${skillId}.md`);
  }
  return lines.join("\n");
}

function upsertSkillCandidateRow(db: DatabaseSync, record: SkillCandidateRecord): void {
  db.prepare(`
    INSERT INTO skill_candidates (
      id, status, agent_id, skill_name, skill_id, reason, content, triggers_json,
      risk_level, source_session_id, source_agent_id, run_id, created_at, reviewed_at,
      promoted_skill_id, discard_reason, record_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      agent_id = excluded.agent_id,
      skill_name = excluded.skill_name,
      skill_id = excluded.skill_id,
      reason = excluded.reason,
      content = excluded.content,
      triggers_json = excluded.triggers_json,
      risk_level = excluded.risk_level,
      reviewed_at = excluded.reviewed_at,
      promoted_skill_id = excluded.promoted_skill_id,
      discard_reason = excluded.discard_reason,
      record_json = excluded.record_json,
      updated_at = excluded.updated_at
  `).run(
    record.id,
    record.status,
    record.agentId,
    record.skillName,
    record.skillId,
    record.reason,
    record.content,
    JSON.stringify(record.triggers),
    record.riskLevel,
    record.sourceSessionId ?? null,
    record.sourceAgentId ?? null,
    record.runId ?? null,
    record.createdAt,
    record.reviewedAt ?? null,
    record.promotedSkillId ?? null,
    record.discardReason ?? null,
    JSON.stringify(record),
    new Date().toISOString()
  );
}

function resolveSkillCandidate(entries: SkillCandidateView[], candidateId: string, includeReviewed: boolean): SkillCandidateView {
  const normalized = candidateId.trim();
  if (!normalized) {
    throw new Error("Skill candidate id is required.");
  }
  const candidates = includeReviewed ? entries : entries.filter((entry) => entry.record.status === "pending");
  const matches = candidates.filter((entry) => entry.displayId === normalized || entry.displayId.startsWith(normalized));
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`Skill candidate id prefix is ambiguous: ${candidateId}. Matches: ${matches.map((entry) => entry.displayId).join(", ")}`);
  }
  throw new Error(`Skill candidate not found: ${candidateId}`);
}

function resolveSkillId(skills: string[], skillId: string): string {
  const normalized = skillId.trim();
  const matches = skills.filter((id) => id === normalized || id.startsWith(normalized));
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`Skill id prefix is ambiguous: ${skillId}. Matches: ${matches.join(", ")}`);
  }
  throw new Error(`Skill not found: ${skillId}`);
}

function classifySkillRisk(candidate: SkillCandidate): RiskLevel {
  const secret = detectSecrets(candidate.content);
  if (secret.matched || candidate.riskLevel === "high") {
    return "high";
  }
  return candidate.riskLevel ?? "low";
}

function slugifySkillId(skillName: string, candidateId: string): string {
  const slug = skillName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `skill-${candidateId.slice(0, 8)}`;
}

function normalizeTriggers(triggers: string[]): string[] {
  return [...new Set(triggers.map((trigger) => normalizeTriggerText(trigger)).filter(Boolean))];
}

function normalizeTriggerText(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, " ");
}

function triggerMatches(trigger: string, text: string): boolean {
  if (!trigger || !text) {
    return false;
  }
  if (isAsciiCodeLike(trigger)) {
    const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`, "i").test(text);
  }
  return text.includes(trigger);
}

function isAsciiCodeLike(trigger: string): boolean {
  return /^[a-z0-9_.:-]+$/i.test(trigger);
}

function renderSkillFile(record: SkillCandidateRecord): string {
  return `# ${record.skillName}

<!-- COSIA skill id: ${record.skillId} -->

## Reason

${record.reason}

## Triggers

${record.triggers.length ? record.triggers.map((trigger) => `- ${trigger}`).join("\n") : "- manual-only"}

## Instructions

${record.content.trim()}
`;
}

function renderSkillsIndex(agentId: string, manifest: AgentManifest): string {
  const skills = manifest.skills.length
    ? manifest.skills.map((skillId) => {
        const triggers = manifest.skillTriggers?.[skillId] ?? [];
        return `- ${skillId} (${triggers.length ? `triggers: ${triggers.join(", ")}` : "manual-only"})`;
      }).join("\n")
    : "No promoted skills.";
  return `# SKILLS

This file is generated by COSIA from \`agents/${agentId}/skills/*.md\` and \`manifest.json\`.
Do not manually edit sections here; update skill files or run \`cosia skill sync ${agentId}\`.

${skills}
`;
}

function renderSkillPromptItem(skill: SkillRecord, match: SkillTriggerMatch, selectedBy: "manual" | "trigger", content: string): string {
  const source = `agents/${skill.agentId}/skills/${skill.id}.md`;
  return `  <skill id="${escapeXmlAttribute(skill.id)}" trigger_score="${match.score}" selected_by="${selectedBy}" source="${escapeXmlAttribute(source)}">
    <skill_markdown>
${indentXmlText(content, "      ")}
    </skill_markdown>
  </skill>`;
}

function selectionManifest(
  item: { match: SkillTriggerMatch; selectedBy: "manual" | "trigger" },
  originalChars: number,
  retainedChars: number,
  truncated: boolean,
  omittedReason?: string
): SkillSelectionManifest {
  return {
    skillId: item.match.skillId,
    selected: !omittedReason,
    selectedBy: item.selectedBy,
    triggerScore: item.match.score,
    matchedTriggers: item.match.matchedTriggers,
    matchedFrom: item.match.matchedFrom,
    originalChars,
    retainedChars,
    truncated,
    omittedReason
  };
}

function neutralizeXmlBoundaries(content: string): string {
  return content
    .replace(/<\/(skill|skill_markdown|available_skills)>/gi, "<\\/$1>")
    .replace(/<(skill|skill_markdown|available_skills)(\s|>)/gi, "&lt;$1$2");
}

function truncateSkillContent(content: string, maxChars: number, skillId: string): string {
  const marker = `\n[COSIA: skill ${skillId} truncated, originalChars=${content.length}, retainedChars=${maxChars}]`;
  return `${content.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function indentXmlText(value: string, prefix: string): string {
  return value.split(/\r?\n/).map((line) => `${prefix}${line}`).join("\n");
}

function preview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}
