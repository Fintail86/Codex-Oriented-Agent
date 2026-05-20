import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { detectSecrets } from "../risk_classifier.js";
import {
  skillCandidateRecordSchema,
  skillMetadataSchema,
  type RiskLevel,
  type SessionMetadata,
  type SkillCandidate,
  type SkillCandidateRecord,
  type SkillMetadata
} from "../types.js";
import type { SkillMirror } from "./skill_mirror.js";
import { SkillStore } from "./skill_store.js";
import { normalizeTriggers, slugifySkillId } from "./skill_text.js";

type SkillCandidateRow = {
  id: string;
  record_json: string;
};

export type SkillCandidateView = {
  displayId: string;
  record: SkillCandidateRecord;
};

export type PromoteSkillOptions = {
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

export type CreateSkillCandidateInput = {
  skillName: string;
  reason: string;
  content: string;
  triggers?: string[];
  riskLevel?: RiskLevel;
  agentId?: string;
  suggestedByAgentId?: string;
  sourceSessionId?: string;
  sourceAgentId?: string;
  runId?: string;
};

export const highRiskConfirmPhrase = "PROMOTE HIGH RISK SKILL";

export class SkillCandidateStore {
  constructor(
    private readonly workspaceRoot: string,
    private readonly store: SkillStore,
    private readonly mirror: SkillMirror
  ) {}

  ensureSchema(): void {
    this.store.ensureMemoryDir();
    this.store.ensureSkillsDir();
    const db = this.open();
    try {
      ensureSkillCandidateTable(db);
    } finally {
      db.close();
    }
  }

  appendCandidates(candidates: SkillCandidate[] | undefined, session: SessionMetadata, runId?: string, sourceAgentId?: string): SkillCandidateRecord[] {
    if (!candidates?.length) {
      return [];
    }
    const executingAgentId = sourceAgentId ?? session.assignedAgentId;
    if (!executingAgentId) {
      throw new Error("Cannot append skill candidates without an executing or assigned agent.");
    }
    this.ensureSchema();
    const records = candidates.map((candidate) => createSkillCandidateRecord({
      ...candidate,
      agentId: candidate.agentId || executingAgentId,
      suggestedByAgentId: candidate.agentId || executingAgentId,
      sourceSessionId: session.id,
      sourceAgentId: executingAgentId,
      runId
    }));
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

  appendManualCandidate(input: CreateSkillCandidateInput): SkillCandidateRecord {
    this.ensureSchema();
    const record = createSkillCandidateRecord(input);
    const db = this.open();
    try {
      upsertSkillCandidateRow(db, record);
    } finally {
      db.close();
    }
    return record;
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
    this.mirror.ensureGlobalMirror();
    const skillPath = this.store.skillPath(record.skillId);
    const metadataPath = this.store.skillMetadataPath(record.skillId);
    const skillsIndexPath = this.store.globalSkillsIndexPath();
    const warning = record.triggers.length
      ? undefined
      : "Warning: this skill has no triggers and will be manual-only unless selected with --skill or /skills use.";

    if (existsSync(skillPath) || existsSync(metadataPath)) {
      throw new Error(`Skill already exists: ${record.skillId}`);
    }
    if (options.preferFor) {
      const manifest = this.store.readAgentManifest(options.preferFor);
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
    this.store.writeSkillFromCandidate(record, metadata);
    this.mirror.syncSkillsIndex();
    if (options.preferFor) {
      this.store.preferSkill(record.skillId, options.preferFor);
      this.mirror.syncSkillsIndex(options.preferFor);
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

  private open(): DatabaseSync {
    return new DatabaseSync(join(this.workspaceRoot, "memory", "longterm.sqlite"));
  }
}

export function ensureSkillCandidateTable(db: DatabaseSync): void {
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
}

export function createSkillCandidateRecord(input: CreateSkillCandidateInput): SkillCandidateRecord {
  const id = randomUUID();
  const agentId = input.agentId || input.suggestedByAgentId || input.sourceAgentId || "core-memory";
  const candidate: SkillCandidate = {
    agentId,
    skillName: input.skillName,
    reason: input.reason,
    content: input.content,
    triggers: input.triggers,
    riskLevel: input.riskLevel
  };
  const record: SkillCandidateRecord = {
    id,
    status: "pending",
    agentId,
    skillName: input.skillName,
    skillId: slugifySkillId(input.skillName, id),
    reason: input.reason,
    content: input.content,
    triggers: normalizeTriggers(input.triggers ?? []),
    riskLevel: classifySkillRisk(candidate),
    suggestedByAgentId: input.suggestedByAgentId,
    sourceSessionId: input.sourceSessionId,
    sourceAgentId: input.sourceAgentId,
    runId: input.runId,
    createdAt: new Date().toISOString()
  };
  return skillCandidateRecordSchema.parse(record);
}

export function upsertSkillCandidateRow(db: DatabaseSync, record: SkillCandidateRecord): void {
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

function classifySkillRisk(candidate: SkillCandidate): RiskLevel {
  const secret = detectSecrets(candidate.content);
  if (secret.matched || candidate.riskLevel === "high") {
    return "high";
  }
  return candidate.riskLevel ?? "low";
}
