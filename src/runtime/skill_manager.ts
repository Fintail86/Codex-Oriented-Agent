import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, relative } from "node:path";
import { detectSecrets } from "./risk_classifier.js";
import {
  agentManifestSchema,
  skillCandidateRecordSchema,
  skillMetadataSchema,
  type AgentManifest,
  type RiskLevel,
  type SessionMetadata,
  type SkillCandidate,
  type SkillCandidateRecord,
  type SkillMetadata
} from "./types.js";

type SkillCandidateRow = {
  id: string;
  record_json: string;
};

export type SkillCandidateView = {
  displayId: string;
  record: SkillCandidateRecord;
};

export type SkillRecord = SkillMetadata & {
  path: string;
  metadataPath: string;
  content: string;
  manualOnly: boolean;
};

export type SkillCheckResult = {
  ok: boolean;
  scope: "global" | "agent";
  agentId?: string;
  mirrorExists: boolean;
  mirrorMatches: boolean;
  repaired: boolean;
  missingSkillFiles: string[];
  missingMetadataFiles: string[];
  orphanSkillFiles: string[];
  manualOnlySkills: string[];
  missingPreferredSkills: string[];
  missingBlockedSkills: string[];
};

export type SkillTriggerMatch = {
  skillId: string;
  score: number;
  matchedTriggers: string[];
  matchedFrom: Array<"current_request" | "session_goal">;
};

export type SkillSelectionStatus = "SELECTED" | "OMITTED" | "BLOCKED";

export type SkillSelectionManifest = {
  skillId: string;
  selected: boolean;
  selectedBy: "manual" | "trigger";
  triggerScore: number;
  preferredBonus: number;
  weightBonus: number;
  finalScore: number;
  matchedTriggers: string[];
  matchedFrom: Array<"current_request" | "session_goal">;
  originalChars: number;
  retainedChars: number;
  truncated: boolean;
  omittedReason?: string;
};

export type SkillSelectionExplainRow = {
  skillId: string;
  status: SkillSelectionStatus;
  selectedBy: "manual" | "trigger" | "none";
  triggerScore: number;
  preferredBonus: number;
  weightBonus: number;
  finalScore: number;
  matchedTriggers: string[];
  matchedFrom: Array<"current_request" | "session_goal">;
  reason: string;
  originalChars: number;
  retainedChars: number;
  truncated: boolean;
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
  preferFor?: string;
};

export type PromoteSkillResult = {
  changed: boolean;
  record: SkillCandidateRecord;
  skillPath: string;
  metadataPath: string;
  skillsIndexPath: string;
  preferredAgentId?: string;
  warning?: string;
};

export type SkillMigrationResult = {
  agentId: string;
  changed: boolean;
  migrated: string[];
  skipped: Array<{ skillId: string; reason: string }>;
};

type RankedSkill = {
  skill: SkillRecord;
  selectedBy: "manual" | "trigger";
  match: SkillTriggerMatch;
  preferredBonus: number;
  weightBonus: number;
  finalScore: number;
};

const highRiskConfirmPhrase = "PROMOTE HIGH RISK SKILL";
const preferredSkillBonus = 3;

export class SkillManager {
  constructor(private readonly workspaceRoot: string) {}

  ensureSchema(): void {
    this.ensureMemoryDir();
    this.ensureSkillFiles();
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

  ensureSkillFiles(): void {
    this.ensureSkillsDir();
    const indexPath = this.globalSkillsIndexPath();
    if (!existsSync(indexPath)) {
      writeFileSync(indexPath, renderGlobalSkillsIndex(this.readSkillRecords()), "utf8");
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
      const suggestedByAgentId = candidate.agentId || session.agentId;
      const triggers = normalizeTriggers(candidate.triggers ?? []);
      const record: SkillCandidateRecord = {
        id,
        status: "pending",
        agentId: suggestedByAgentId,
        skillName: candidate.skillName,
        skillId: slugifySkillId(candidate.skillName, id),
        reason: candidate.reason,
        content: candidate.content,
        triggers,
        riskLevel: classifySkillRisk(candidate),
        suggestedByAgentId,
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
    this.ensureSkillFiles();
    const skillPath = this.skillPath(record.skillId);
    const metadataPath = this.skillMetadataPath(record.skillId);
    const skillsIndexPath = this.globalSkillsIndexPath();
    const warning = record.triggers.length
      ? undefined
      : "Warning: this skill has no triggers and will be manual-only unless selected with --skill or /skills use.";

    if (existsSync(skillPath) || existsSync(metadataPath)) {
      throw new Error(`Skill already exists: ${record.skillId}`);
    }
    if (options.preferFor) {
      const manifest = this.readAgentManifest(options.preferFor);
      if (manifest.blockedSkills.includes(record.skillId)) {
        throw new Error(`Cannot prefer a blocked skill for ${options.preferFor}: ${record.skillId}`);
      }
    }
    if (!options.yes) {
      return { changed: false, record, skillPath, metadataPath, skillsIndexPath, preferredAgentId: options.preferFor, warning };
    }
    if (record.riskLevel === "high" && options.confirmHighRisk !== highRiskConfirmPhrase) {
      throw new Error(`High-risk skill promotion requires --confirm-high-risk "${highRiskConfirmPhrase}"`);
    }

    const now = new Date().toISOString();
    const metadata: SkillMetadata = skillMetadataSchema.parse({
      id: record.skillId,
      name: record.skillName,
      description: record.reason,
      triggers: record.triggers,
      riskLevel: record.riskLevel,
      createdAt: now,
      updatedAt: now,
      sourceCandidateId: record.id,
      suggestedByAgentId: record.suggestedByAgentId ?? record.agentId
    });
    writeFileSync(skillPath, renderSkillFile(record), "utf8");
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    this.writeGlobalSkillsIndex();
    if (options.preferFor) {
      this.preferSkill(record.skillId, options.preferFor);
    }

    const updated = {
      ...record,
      status: "promoted" as const,
      reviewedAt: now,
      promotedSkillId: record.skillId
    };
    const db = this.open();
    try {
      upsertSkillCandidateRow(db, updated);
    } finally {
      db.close();
    }
    return { changed: true, record: updated, skillPath, metadataPath, skillsIndexPath, preferredAgentId: options.preferFor, warning };
  }

  listSkills(): SkillRecord[] {
    this.ensureSkillFiles();
    return this.readSkillRecords();
  }

  getSkill(skillId: string): SkillRecord {
    const resolvedSkillId = this.resolveSkillId(skillId);
    const skill = this.readSkillRecord(resolvedSkillId);
    if (!existsSync(skill.path)) {
      throw new Error(`Skill file not found: ${resolvedSkillId}`);
    }
    return skill;
  }

  resolveSkillId(skillId: string): string {
    return resolveSkillId(this.readSkillRecords().map((skill) => skill.id), skillId);
  }

  syncSkillsIndex(agentId?: string): string {
    if (agentId) {
      const manifest = this.readAgentManifest(agentId);
      const path = this.agentSkillsIndexPath(agentId);
      writeFileSync(path, renderAgentSkillsIndex(agentId, manifest, this.readSkillRecords()), "utf8");
      return path;
    }
    this.writeGlobalSkillsIndex();
    return this.globalSkillsIndexPath();
  }

  checkSkills(agentId?: string, repair = false): SkillCheckResult {
    this.ensureSkillsDir();
    const skills = this.readSkillRecords();
    const metadataIds = new Set(skills.map((skill) => skill.id));
    const mdIds = new Set(this.readSkillMarkdownIds());
    const missingSkillFiles = skills.filter((skill) => !mdIds.has(skill.id)).map((skill) => skill.id);
    const orphanSkillFiles = [...mdIds].filter((skillId) => !metadataIds.has(skillId)).sort();
    const missingMetadataFiles = orphanSkillFiles;
    const manualOnlySkills = skills.filter((skill) => skill.triggers.length === 0).map((skill) => skill.id);
    const manifest = agentId ? this.readAgentManifest(agentId) : undefined;
    const missingPreferredSkills = manifest ? manifest.preferredSkills.filter((skillId) => !metadataIds.has(skillId)).sort() : [];
    const missingBlockedSkills = manifest ? manifest.blockedSkills.filter((skillId) => !metadataIds.has(skillId)).sort() : [];
    const mirrorPath = agentId ? this.agentSkillsIndexPath(agentId) : this.globalSkillsIndexPath();
    const expectedMirror = agentId
      ? renderAgentSkillsIndex(agentId, manifest!, skills)
      : renderGlobalSkillsIndex(skills);
    const mirrorExists = existsSync(mirrorPath);
    let mirrorMatches = mirrorExists && normalizeNewlines(readFileSync(mirrorPath, "utf8")) === normalizeNewlines(expectedMirror);
    let repaired = false;
    if (repair && !mirrorMatches) {
      writeFileSync(mirrorPath, expectedMirror, "utf8");
      mirrorMatches = true;
      repaired = true;
    }
    return {
      ok: mirrorMatches && missingSkillFiles.length === 0 && missingPreferredSkills.length === 0 && missingBlockedSkills.length === 0,
      scope: agentId ? "agent" : "global",
      agentId,
      mirrorExists,
      mirrorMatches,
      repaired,
      missingSkillFiles,
      missingMetadataFiles,
      orphanSkillFiles,
      manualOnlySkills,
      missingPreferredSkills,
      missingBlockedSkills
    };
  }

  preferSkill(skillId: string, agentId: string, weight?: number): AgentManifest {
    const resolvedSkillId = this.resolveSkillId(skillId);
    const manifest = this.readAgentManifest(agentId);
    if (manifest.blockedSkills.includes(resolvedSkillId)) {
      throw new Error(`Cannot prefer a blocked skill: ${resolvedSkillId}`);
    }
    const next: AgentManifest = {
      ...manifest,
      preferredSkills: [...new Set([...manifest.preferredSkills, resolvedSkillId])],
      skillWeights: weight === undefined
        ? manifest.skillWeights
        : { ...manifest.skillWeights, [resolvedSkillId]: clampSkillWeight(weight) }
    };
    this.writeAgentManifest(agentId, next);
    this.syncSkillsIndex(agentId);
    return next;
  }

  unpreferSkill(skillId: string, agentId: string): AgentManifest {
    const resolvedSkillId = this.resolveSkillId(skillId);
    const manifest = this.readAgentManifest(agentId);
    const next: AgentManifest = {
      ...manifest,
      preferredSkills: manifest.preferredSkills.filter((id) => id !== resolvedSkillId),
      skillWeights: Object.fromEntries(Object.entries(manifest.skillWeights).filter(([id]) => id !== resolvedSkillId))
    };
    this.writeAgentManifest(agentId, next);
    this.syncSkillsIndex(agentId);
    return next;
  }

  blockSkill(skillId: string, agentId: string): AgentManifest {
    const resolvedSkillId = this.resolveSkillId(skillId);
    const manifest = this.readAgentManifest(agentId);
    const next: AgentManifest = {
      ...manifest,
      blockedSkills: [...new Set([...manifest.blockedSkills, resolvedSkillId])],
      preferredSkills: manifest.preferredSkills.filter((id) => id !== resolvedSkillId),
      skillWeights: Object.fromEntries(Object.entries(manifest.skillWeights).filter(([id]) => id !== resolvedSkillId))
    };
    this.writeAgentManifest(agentId, next);
    this.syncSkillsIndex(agentId);
    return next;
  }

  unblockSkill(skillId: string, agentId: string): AgentManifest {
    const resolvedSkillId = this.resolveSkillId(skillId);
    const manifest = this.readAgentManifest(agentId);
    const next: AgentManifest = {
      ...manifest,
      blockedSkills: manifest.blockedSkills.filter((id) => id !== resolvedSkillId)
    };
    this.writeAgentManifest(agentId, next);
    this.syncSkillsIndex(agentId);
    return next;
  }

  migrateAgentSkills(agentId: string, yes = false): SkillMigrationResult {
    const manifest = this.readAgentManifest(agentId);
    const legacyDir = join(this.agentDir(agentId), "skills");
    const result: SkillMigrationResult = {
      agentId,
      changed: false,
      migrated: [],
      skipped: []
    };
    if (!existsSync(legacyDir)) {
      return result;
    }
    const legacyFiles = readdirSync(legacyDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -3))
      .sort((left, right) => left.localeCompare(right));
    const now = new Date().toISOString();
    const preferred = new Set(manifest.preferredSkills);
    for (const skillId of legacyFiles) {
      if (existsSync(this.skillPath(skillId)) || existsSync(this.skillMetadataPath(skillId))) {
        result.skipped.push({ skillId, reason: "global skill already exists" });
        continue;
      }
      result.migrated.push(skillId);
      if (!yes) {
        continue;
      }
      const legacyPath = join(legacyDir, `${skillId}.md`);
      const content = readFileSync(legacyPath, "utf8");
      const metadata: SkillMetadata = {
        id: skillId,
        name: titleFromMarkdown(content) ?? skillId,
        triggers: normalizeTriggers(manifest.skillTriggers?.[skillId] ?? []),
        riskLevel: "low",
        createdAt: now,
        updatedAt: now,
        suggestedByAgentId: agentId
      };
      writeFileSync(this.skillPath(skillId), content, "utf8");
      writeFileSync(this.skillMetadataPath(skillId), `${JSON.stringify(skillMetadataSchema.parse(metadata), null, 2)}\n`, "utf8");
      preferred.add(skillId);
    }
    if (yes && result.migrated.length) {
      const nextManifest: AgentManifest = {
        ...manifest,
        preferredSkills: [...preferred].sort((left, right) => left.localeCompare(right))
      };
      this.writeAgentManifest(agentId, nextManifest);
      this.writeGlobalSkillsIndex();
      this.syncSkillsIndex(agentId);
      result.changed = true;
    }
    return result;
  }

  selectSkillPromptBlock(input: {
    agent: AgentManifest;
    sessionGoal: string;
    currentRequest: string;
    manualSkillIds?: string[];
    budget: SkillBudget;
  }): SkillPromptBlock | undefined {
    const selection = this.buildSkillSelection(input, false);
    if (!selection.renderedSkills.length && !selection.manifest.length) {
      return undefined;
    }
    return {
      title: "SELECTED SKILLS",
      content: `<available_skills>\n${selection.renderedSkills.join("\n")}\n</available_skills>`,
      manifest: selection.manifest
    };
  }

  explainSkillSelection(input: {
    agent: AgentManifest;
    sessionGoal: string;
    currentRequest: string;
    manualSkillIds?: string[];
    budget: SkillBudget;
  }): SkillSelectionExplainRow[] {
    return this.buildSkillSelection(input, true).explainRows;
  }

  private buildSkillSelection(input: {
    agent: AgentManifest;
    sessionGoal: string;
    currentRequest: string;
    manualSkillIds?: string[];
    budget: SkillBudget;
  }, includeAllRows: boolean): {
    renderedSkills: string[];
    manifest: SkillSelectionManifest[];
    explainRows: SkillSelectionExplainRow[];
  } {
    const skills = this.readSkillRecords();
    const blockedSkills = new Set(input.agent.blockedSkills);
    const preferredSkills = new Set(input.agent.preferredSkills);
    const manualSkillIds = [...new Set(input.manualSkillIds ?? [])].map((skillId) => this.resolveSkillId(skillId));
    const manualSet = new Set(manualSkillIds);
    for (const skillId of manualSet) {
      if (blockedSkills.has(skillId)) {
        throw new Error(`Skill is blocked for ${input.agent.id}: ${skillId}`);
      }
    }
    const explainRows = new Map<string, SkillSelectionExplainRow>();
    const ranked: RankedSkill[] = [];
    for (const skill of skills) {
      const match = calculateSkillTriggerMatch({
        skillId: skill.id,
        triggers: skill.triggers,
        sessionGoal: input.sessionGoal,
        currentRequest: input.currentRequest
      });
      const preferredBonus = preferredSkills.has(skill.id) ? preferredSkillBonus : 0;
      const weightBonus = clampSkillWeight(input.agent.skillWeights?.[skill.id] ?? 0);
      const finalScore = match.score + preferredBonus + weightBonus;
      if (blockedSkills.has(skill.id)) {
        explainRows.set(skill.id, selectionExplainRow(skill, "BLOCKED", "none", match, 0, 0, 0, "blockedByAgent"));
        continue;
      }
      const selectedBy = manualSet.has(skill.id) ? "manual" as const : "trigger" as const;
      if (selectedBy === "manual" || match.score > 0) {
        ranked.push({ skill, selectedBy, match, preferredBonus, weightBonus, finalScore });
        continue;
      }
      if (includeAllRows) {
        explainRows.set(skill.id, selectionExplainRow(skill, "OMITTED", "none", match, preferredBonus, weightBonus, finalScore, "noTriggerMatch"));
      }
    }
    ranked.sort(compareRankedSkills(input.agent));

    const renderedSkills: string[] = [];
    const manifest: SkillSelectionManifest[] = [];
    let retainedTotal = 0;
    for (const item of ranked) {
      const original = item.skill.content;
      let content = neutralizeXmlBoundaries(original);
      let truncated = false;
      if (content.length > input.budget.skillItemMaxChars) {
        content = truncateSkillContent(content, input.budget.skillItemMaxChars, item.skill.id);
        truncated = true;
      }
      const rendered = renderSkillPromptItem(item.skill, item, content);
      if (renderedSkills.length >= input.budget.skillMaxItems) {
        const row = selectionExplainRow(item.skill, "OMITTED", item.selectedBy, item.match, item.preferredBonus, item.weightBonus, item.finalScore, "skillMaxItems", original.length, 0, false);
        explainRows.set(item.skill.id, row);
        manifest.push(selectionManifest(item, original.length, 0, false, "skillMaxItems"));
        continue;
      }
      if (retainedTotal + rendered.length > input.budget.skillMaxChars) {
        const row = selectionExplainRow(item.skill, "OMITTED", item.selectedBy, item.match, item.preferredBonus, item.weightBonus, item.finalScore, "skillMaxChars", original.length, 0, false);
        explainRows.set(item.skill.id, row);
        manifest.push(selectionManifest(item, original.length, 0, false, "skillMaxChars"));
        continue;
      }
      renderedSkills.push(rendered);
      retainedTotal += rendered.length;
      explainRows.set(item.skill.id, selectionExplainRow(item.skill, "SELECTED", item.selectedBy, item.match, item.preferredBonus, item.weightBonus, item.finalScore, "selected", original.length, content.length, truncated));
      manifest.push(selectionManifest(item, original.length, content.length, truncated));
    }
    const rows = includeAllRows
      ? [...explainRows.values()].sort(compareExplainRows)
      : [...explainRows.values()].filter((row) => row.status !== "OMITTED" || row.reason !== "noTriggerMatch").sort(compareExplainRows);
    return { renderedSkills, manifest, explainRows: rows };
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
    writeFileSync(join(this.agentDir(agentId), "manifest.json"), `${JSON.stringify(serializeAgentManifest(agentManifestSchema.parse(manifest)), null, 2)}\n`, "utf8");
  }

  private readSkillRecords(): SkillRecord[] {
    this.ensureSkillsDir();
    return readdirSync(this.skillsDir(), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -5))
      .map((skillId) => this.readSkillRecord(skillId))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private readSkillRecord(skillId: string): SkillRecord {
    const metadataPath = this.skillMetadataPath(skillId);
    if (!existsSync(metadataPath)) {
      throw new Error(`Skill metadata not found: ${skillId}`);
    }
    const metadata = skillMetadataSchema.parse(JSON.parse(readFileSync(metadataPath, "utf8")));
    const path = this.skillPath(metadata.id);
    const content = existsSync(path) ? readFileSync(path, "utf8") : "";
    return {
      ...metadata,
      path,
      metadataPath,
      content,
      manualOnly: metadata.triggers.length === 0
    };
  }

  private readSkillMarkdownIds(): string[] {
    this.ensureSkillsDir();
    return readdirSync(this.skillsDir(), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "SKILLS.md")
      .map((entry) => entry.name.slice(0, -3));
  }

  private writeGlobalSkillsIndex(): void {
    this.ensureSkillsDir();
    writeFileSync(this.globalSkillsIndexPath(), renderGlobalSkillsIndex(this.readSkillRecords()), "utf8");
  }

  private agentDir(agentId: string): string {
    return join(this.workspaceRoot, "agents", agentId);
  }

  private skillsDir(): string {
    return join(this.workspaceRoot, "skills");
  }

  private skillPath(skillId: string): string {
    return join(this.skillsDir(), `${skillId}.md`);
  }

  private skillMetadataPath(skillId: string): string {
    return join(this.skillsDir(), `${skillId}.json`);
  }

  private globalSkillsIndexPath(): string {
    return join(this.skillsDir(), "SKILLS.md");
  }

  private agentSkillsIndexPath(agentId: string): string {
    return join(this.agentDir(agentId), "SKILLS.md");
  }

  private ensureSkillsDir(): void {
    if (!existsSync(this.skillsDir())) {
      mkdirSync(this.skillsDir(), { recursive: true });
    }
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
  const suggestedBy = record.suggestedByAgentId ?? record.agentId;
  return `${record.id}\t${record.status}\t${record.riskLevel}\t${record.skillId}\tsuggestedBy:${suggestedBy}\ttriggers:${triggerText}\t${content}`;
}

export function formatSkillPromotionPreview(result: PromoteSkillResult): string {
  const secret = detectSecrets(result.record.content);
  const content = secret.matched ? secret.redactedPreview : preview(result.record.content);
  const lines = [
    result.changed ? "Promoted skill candidate." : "Skill promotion preview. No changes made.",
    `Candidate: ${result.record.id}`,
    `Suggested by: ${result.record.suggestedByAgentId ?? result.record.agentId}`,
    `Skill: ${result.record.skillId}`,
    `Risk: ${result.record.riskLevel}`,
    `Triggers: ${result.record.triggers.length ? result.record.triggers.join(", ") : "manual-only"}`,
    `Skill file: ${relative(process.cwd(), result.skillPath)}`,
    `Metadata: ${relative(process.cwd(), result.metadataPath)}`,
    `SKILLS mirror: ${relative(process.cwd(), result.skillsIndexPath)}`,
    `Prefer for: ${result.preferredAgentId ?? "none"}`,
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
    `Scope: ${result.scope}${result.agentId ? ` ${result.agentId}` : ""}`,
    `SKILLS.md: ${result.mirrorMatches ? "ok" : "stale/missing"}`,
    `Skill files: ${result.missingSkillFiles.length ? "missing files" : "ok"}`,
    `Skill metadata: ${result.missingMetadataFiles.length ? "missing metadata" : "ok"}`
  ];
  if (result.repaired) {
    lines.push("Repaired: SKILLS.md");
  }
  for (const skillId of result.manualOnlySkills) {
    lines.push(`Warning: ${skillId} is manual-only because it has no triggers.`);
  }
  for (const skillId of result.orphanSkillFiles) {
    lines.push(`Warning: orphan skill file is not listed in global metadata: ${skillId}.md`);
  }
  for (const skillId of result.missingSkillFiles) {
    lines.push(`Error: skill metadata is missing its file: ${skillId}.md`);
  }
  for (const skillId of result.missingPreferredSkills) {
    lines.push(`Error: preferred skill does not exist: ${skillId}`);
  }
  for (const skillId of result.missingBlockedSkills) {
    lines.push(`Error: blocked skill does not exist: ${skillId}`);
  }
  return lines.join("\n");
}

export function formatSkillSelectionExplanation(rows: SkillSelectionExplainRow[]): string {
  if (!rows.length) {
    return "No skills.";
  }
  const header = [
    pad("Skill", 28),
    pad("Status", 8),
    pad("Total", 5),
    pad("Trigger", 7),
    pad("Pref", 4),
    pad("Weight", 6),
    "Reason"
  ].join("  ");
  const body = rows.map((row) => [
    pad(row.skillId, 28),
    pad(row.status, 8),
    pad(String(row.finalScore), 5),
    pad(String(row.triggerScore), 7),
    pad(String(row.preferredBonus), 4),
    pad(String(row.weightBonus), 6),
    row.reason
  ].join("  "));
  return [header, ...body].join("\n");
}

export function formatSkillMigrationResult(result: SkillMigrationResult): string {
  const lines = [
    result.changed ? "Migrated legacy agent skills." : "Skill migration preview. No changes made.",
    `Agent: ${result.agentId}`,
    `Migratable: ${result.migrated.length ? result.migrated.join(", ") : "none"}`
  ];
  for (const skipped of result.skipped) {
    lines.push(`Skipped: ${skipped.skillId} (${skipped.reason})`);
  }
  if (!result.changed && result.migrated.length) {
    lines.push("Re-run with --yes to migrate these skills.");
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

<!-- COSIA global skill id: ${record.skillId} -->

## Purpose

${record.reason}

## Instructions

${record.content.trim()}
`;
}

function renderGlobalSkillsIndex(skills: SkillRecord[]): string {
  const body = skills.length
    ? skills.map((skill) => {
        const triggers = skill.triggers.length ? skill.triggers.join(", ") : "manual-only";
        return `- ${skill.id} (${skill.riskLevel}; triggers: ${triggers}) - ${skill.name}`;
      }).join("\n")
    : "No promoted skills.";
  return `# SKILLS

This file is generated by COSIA from \`skills/*.json\` and \`skills/*.md\`.
Do not manually edit sections here; update skill files or run \`cosia skill sync\`.

${body}
`;
}

function renderAgentSkillsIndex(agentId: string, manifest: AgentManifest, skills: SkillRecord[]): string {
  const skillMap = new Map(skills.map((skill) => [skill.id, skill]));
  const preferred = manifest.preferredSkills.length
    ? manifest.preferredSkills.map((skillId) => `- ${skillId}${manifest.skillWeights?.[skillId] ? ` (weight: ${manifest.skillWeights[skillId]})` : ""}`).join("\n")
    : "No preferred skills.";
  const blocked = manifest.blockedSkills.length
    ? manifest.blockedSkills.map((skillId) => `- ${skillId}`).join("\n")
    : "No blocked skills.";
  const available = skills.length
    ? skills.map((skill) => {
        const state = manifest.blockedSkills.includes(skill.id)
          ? "blocked"
          : manifest.preferredSkills.includes(skill.id)
            ? "preferred"
            : "available";
        const triggers = skill.triggers.length ? skill.triggers.join(", ") : "manual-only";
        return `- ${skill.id} [${state}] triggers: ${triggers}`;
      }).join("\n")
    : "No global skills.";
  const missingPreferred = manifest.preferredSkills.filter((skillId) => !skillMap.has(skillId));
  const missing = missingPreferred.length ? `\n\n## Missing References\n\n${missingPreferred.map((skillId) => `- ${skillId}`).join("\n")}\n` : "";
  return `# SKILLS

This file is generated by COSIA as an agent preference view over the global skill toolbox.
Agent: ${agentId}

## Preferred Skills

${preferred}

## Blocked Skills

${blocked}

## Global Skills

${available}${missing}`;
}

function renderSkillPromptItem(skill: SkillRecord, item: RankedSkill, content: string): string {
  const source = `skills/${skill.id}.md`;
  return `  <skill id="${escapeXmlAttribute(skill.id)}" trigger_score="${item.match.score}" final_score="${item.finalScore}" selected_by="${item.selectedBy}" source="${escapeXmlAttribute(source)}">
    <skill_markdown>
${indentXmlText(content, "      ")}
    </skill_markdown>
  </skill>`;
}

function selectionManifest(
  item: RankedSkill,
  originalChars: number,
  retainedChars: number,
  truncated: boolean,
  omittedReason?: string
): SkillSelectionManifest {
  return {
    skillId: item.skill.id,
    selected: !omittedReason,
    selectedBy: item.selectedBy,
    triggerScore: item.match.score,
    preferredBonus: item.preferredBonus,
    weightBonus: item.weightBonus,
    finalScore: item.finalScore,
    matchedTriggers: item.match.matchedTriggers,
    matchedFrom: item.match.matchedFrom,
    originalChars,
    retainedChars,
    truncated,
    omittedReason
  };
}

function selectionExplainRow(
  skill: SkillRecord,
  status: SkillSelectionStatus,
  selectedBy: "manual" | "trigger" | "none",
  match: SkillTriggerMatch,
  preferredBonus: number,
  weightBonus: number,
  finalScore: number,
  reason: string,
  originalChars = skill.content.length,
  retainedChars = 0,
  truncated = false
): SkillSelectionExplainRow {
  return {
    skillId: skill.id,
    status,
    selectedBy,
    triggerScore: match.score,
    preferredBonus,
    weightBonus,
    finalScore,
    matchedTriggers: match.matchedTriggers,
    matchedFrom: match.matchedFrom,
    reason,
    originalChars,
    retainedChars,
    truncated
  };
}

function compareRankedSkills(agent: AgentManifest): (left: RankedSkill, right: RankedSkill) => number {
  const preferred = new Set(agent.preferredSkills);
  return (left, right) => {
    if (left.selectedBy !== right.selectedBy) {
      return left.selectedBy === "manual" ? -1 : 1;
    }
    if (right.finalScore !== left.finalScore) {
      return right.finalScore - left.finalScore;
    }
    if (preferred.has(left.skill.id) !== preferred.has(right.skill.id)) {
      return preferred.has(left.skill.id) ? -1 : 1;
    }
    const created = left.skill.createdAt.localeCompare(right.skill.createdAt);
    if (created !== 0) {
      return created;
    }
    return left.skill.id.localeCompare(right.skill.id);
  };
}

function compareExplainRows(left: SkillSelectionExplainRow, right: SkillSelectionExplainRow): number {
  const statusRank: Record<SkillSelectionStatus, number> = {
    SELECTED: 0,
    OMITTED: 1,
    BLOCKED: 2
  };
  if (statusRank[left.status] !== statusRank[right.status]) {
    return statusRank[left.status] - statusRank[right.status];
  }
  if (right.finalScore !== left.finalScore) {
    return right.finalScore - left.finalScore;
  }
  return left.skillId.localeCompare(right.skillId);
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

function pad(value: string, length: number): string {
  return value.length >= length ? value : `${value}${" ".repeat(length - value.length)}`;
}

function clampSkillWeight(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(5, Math.max(0, Math.round(value)));
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function titleFromMarkdown(content: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(content);
  return match?.[1]?.trim();
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
