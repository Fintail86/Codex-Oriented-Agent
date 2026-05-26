import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { classifyMemoryCandidate, redactedCandidatePreview, type RiskClassification } from "./risk_classifier.js";
import { calculateMemoryScore, formatReferenceMemoryLine, type MemorySearchResult } from "./memory_search.js";
import { intersectMemoryTokens, memoryTokenSet, normalizeMemoryText, previewMemoryText } from "./memory_text.js";
import { createSkillCandidateRecord, ensureSkillCandidateTable, upsertSkillCandidateRow } from "./skills/skill_candidates.js";
import {
  memoryCandidateRecordSchema,
  memoryCandidateSchema,
  memoryTierSchema,
  type MemoryCandidate,
  type MemoryCandidateRecord,
  type MemoryRecord,
  type MemoryTier,
  type RiskLevel,
  type SessionMetadata,
  type SkillCandidateRecord
} from "./types.js";

export { calculateMemoryScore, type MemorySearchResult } from "./memory_search.js";
export { memoryTokenSet, normalizeMemoryText } from "./memory_text.js";

type AddMemoryInput = {
  tier?: MemoryTier;
  content: string;
  ownerId?: string;
  kind?: string;
  sourceSessionId?: string;
  sourceAgentId?: string;
  confidence?: number;
  importance?: number;
  validFrom?: string | null;
  validUntil?: string | null;
  expiresAt?: string | null;
};

type UpdateMemoryInput = Partial<Pick<AddMemoryInput, "tier" | "content" | "ownerId" | "kind" | "confidence" | "importance">>;

type MemorySearchOptions = {
  tier?: MemoryTier;
  ownerId?: string;
  refSessionId?: string;
  refAgentId?: string;
};

type MemoryRow = {
  id: string;
  tier: MemoryTier;
  owner_id: string | null;
  kind: string;
  content: string;
  source_session_id: string | null;
  source_agent_id: string | null;
  confidence: number;
  importance: number;
  status: string;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  expires_at: string | null;
  archived_at: string | null;
  archive_reason: string | null;
  replaced_by_memory_id: string | null;
};

type TableColumn = {
  name: string;
};

type CandidateRow = {
  id: string;
  record_json: string;
};

type PromotionRow = {
  id: string;
  record_json: string;
};

type TierPromotionRow = {
  id: string;
  record_json: string;
};

export type CandidateView = {
  displayId: string;
  record: MemoryCandidateRecord;
};

export type MemoryConflictType = "duplicate" | "overlap" | "possible_conflict";

export type MemoryConflict = {
  type: MemoryConflictType;
  memory: MemoryRecord;
  score: number;
  overlapRatio: number;
  matchedTokens: string[];
  candidatePreview: string;
  memoryPreview: string;
};

export type PromoteCandidateOptions = {
  force?: boolean;
  replaceMemoryId?: string;
  mergeMemoryId?: string;
  mergeContent?: string;
};

export type CandidateCleanupResult = {
  olderThanDays: number;
  cutoff: string;
  eligible: number;
  deleted: number;
  retainedDiscarded: number;
  applied: boolean;
};

export type MemoryTierPromotionMode = "promote" | "force" | "replace" | "merge" | "skill_candidate";

export type MemoryTierPromotionTarget = MemoryTier | "skill_candidate";

export type PromoteMemoryOptions = {
  toTier: Extract<MemoryTier, "agent" | "core">;
  ownerId?: string;
  reason: string;
  content?: string;
  kind?: string;
  importance?: number;
  confidence?: number;
  force?: boolean;
  replaceMemoryId?: string;
  mergeMemoryId?: string;
};

export type PromoteMemoryToSkillCandidateOptions = {
  skillName: string;
  reason: string;
  content?: string;
  triggers?: string[];
};

export type MemoryTierPromotionRecord = {
  id: string;
  sourceMemoryId: string;
  targetMemoryId: string;
  replacedMemoryId?: string;
  fromTier: MemoryTier;
  toTier: MemoryTierPromotionTarget;
  fromOwnerId?: string | null;
  toOwnerId?: string | null;
  mode: MemoryTierPromotionMode;
  reason: string;
  createdAt: string;
  revertedAt?: string;
  revertReason?: string;
  sourceSnapshot?: MemoryRecord;
  targetSnapshot?: MemoryRecord;
  replacedSnapshot?: MemoryRecord;
};

export type AutoPromotionMode = "manual" | "conservative" | "balanced" | "strict";

export type AutoPromotionPolicy = {
  mode: AutoPromotionMode;
  allowRiskLevels: RiskLevel[];
  requireNoConflict: boolean;
  allowTiers?: MemoryTier[];
  denyTiers?: MemoryTier[];
  denyKinds: string[];
};

export type AutoPromotionRecord = {
  id: string;
  candidateId: string;
  promotedMemoryId: string;
  runId?: string;
  sessionId: string;
  agentId: string;
  riskLevel: RiskLevel;
  reasons: string[];
  policyMode: AutoPromotionMode;
  createdAt: string;
  revertedAt?: string;
  revertReason?: string;
};

export type CandidateReview = {
  candidate: MemoryCandidateRecord;
  conflicts: MemoryConflict[];
  classification: RiskClassification;
  autoPromoted?: AutoPromotionRecord;
};

export type MemoryReviewSummary = {
  created: number;
  autoPromoted: number;
  pending: number;
  conflicts: number;
  reviews: CandidateReview[];
};

const conflictRank: Record<MemoryConflictType, number> = {
  duplicate: 0,
  overlap: 1,
  possible_conflict: 2
};

function assertCanonicalColumns(db: DatabaseSync, tableName: string, expectedColumns: string[]): void {
  const actual = (db.prepare(`PRAGMA table_info(${tableName})`).all() as TableColumn[]).map((column) => column.name);
  const actualSet = new Set(actual);
  const missing = expectedColumns.filter((column) => !actualSet.has(column));
  const extra = actual.filter((column) => !expectedColumns.includes(column));
  if (missing.length || extra.length) {
    throw new Error([
      `Unsupported legacy memory database schema for ${tableName}.`,
      missing.length ? `Missing columns: ${missing.join(", ")}` : undefined,
      extra.length ? `Legacy columns: ${extra.join(", ")}` : undefined,
      "Reset the local memory store by removing ignored runtime file memory/longterm.sqlite, then rerun the command."
    ].filter(Boolean).join(" "));
  }
}

export class MemoryManager {
  private readonly memoryDir: string;
  private readonly dbPath: string;

  constructor(private readonly workspaceRoot: string) {
    this.memoryDir = join(workspaceRoot, "memory");
    this.dbPath = join(this.memoryDir, "longterm.sqlite");
  }

  ensureSchema(): void {
    if (!existsSync(this.memoryDir)) {
      mkdirSync(this.memoryDir, { recursive: true });
    }
    const db = this.open();
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          tier TEXT NOT NULL,
          owner_id TEXT,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          source_session_id TEXT,
          source_agent_id TEXT,
          confidence REAL DEFAULT 0.7,
          importance INTEGER DEFAULT 3,
          status TEXT DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_accessed_at TEXT,
          valid_from TEXT,
          valid_until TEXT,
          expires_at TEXT,
          archived_at TEXT,
          archive_reason TEXT,
          replaced_by_memory_id TEXT
        );
      `);
      assertCanonicalColumns(db, "memories", [
        "id",
        "tier",
        "owner_id",
        "kind",
        "content",
        "source_session_id",
        "source_agent_id",
        "confidence",
        "importance",
        "status",
        "created_at",
        "updated_at",
        "last_accessed_at",
        "valid_from",
        "valid_until",
        "expires_at",
        "archived_at",
        "archive_reason",
        "replaced_by_memory_id"
      ]);
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_candidates (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          tier TEXT NOT NULL,
          owner_id TEXT,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          importance INTEGER NOT NULL,
          confidence REAL NOT NULL,
          source_session_id TEXT NOT NULL,
          source_agent_id TEXT NOT NULL,
          run_id TEXT,
          created_at TEXT NOT NULL,
          reviewed_at TEXT,
          promoted_memory_id TEXT,
          auto_promotion_id TEXT,
          risk_level TEXT,
          risk_reasons_json TEXT,
          discard_reason TEXT,
          record_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS auto_promotions (
          id TEXT PRIMARY KEY,
          candidate_id TEXT NOT NULL,
          promoted_memory_id TEXT NOT NULL,
          run_id TEXT,
          session_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          risk_level TEXT NOT NULL,
          reasons_json TEXT NOT NULL,
          policy_mode TEXT NOT NULL,
          created_at TEXT NOT NULL,
          reverted_at TEXT,
          revert_reason TEXT,
          record_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_tier_promotions (
          id TEXT PRIMARY KEY,
          source_memory_id TEXT NOT NULL,
          target_memory_id TEXT NOT NULL,
          replaced_memory_id TEXT,
          from_tier TEXT NOT NULL,
          to_tier TEXT NOT NULL,
          from_owner_id TEXT,
          to_owner_id TEXT,
          mode TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL,
          reverted_at TEXT,
          revert_reason TEXT,
          record_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      ensureSkillCandidateTable(db);
      assertCanonicalColumns(db, "memory_candidates", [
        "id",
        "status",
        "tier",
        "owner_id",
        "kind",
        "content",
        "importance",
        "confidence",
        "source_session_id",
        "source_agent_id",
        "run_id",
        "created_at",
        "reviewed_at",
        "promoted_memory_id",
        "auto_promotion_id",
        "risk_level",
        "risk_reasons_json",
        "discard_reason",
        "record_json",
        "updated_at"
      ]);
    } finally {
      db.close();
    }
  }

  addMemory(input: AddMemoryInput): MemoryRecord {
    this.ensureSchema();
    const db = this.open();
    try {
      return insertMemory(db, input);
    } finally {
      db.close();
    }
  }

  search(query: string, limit = 8, options: MemorySearchOptions = {}): MemorySearchResult[] {
    this.ensureSchema();
    const normalized = normalizeMemoryText(query);
    if (!normalized) {
      return [];
    }
    const db = this.open();
    try {
      const records = this.activeSearchableMemories(db, options);
      const results = records
        .map((record) => calculateMemoryScore(query, record))
        .filter((result) => result.score > 0)
        .sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt))
        .slice(0, limit);
      const now = new Date().toISOString();
      for (const result of results) {
        db.prepare("UPDATE memories SET last_accessed_at = ? WHERE id = ?").run(now, result.record.id);
        result.record.lastAccessedAt = now;
      }
      return results;
    } finally {
      db.close();
    }
  }

  listMemories(limit = 20, includeAll = false, options: { tier?: MemoryTier; ownerId?: string } = {}): MemoryRecord[] {
    this.ensureSchema();
    const db = this.open();
    try {
      const clauses: string[] = [];
      const params: Array<string | number | null> = [];
      if (!includeAll) {
        clauses.push("status = 'active'");
      }
      if (options.tier) {
        clauses.push("tier = ?");
        params.push(options.tier);
      }
      if (options.ownerId) {
        clauses.push("owner_id = ?");
        params.push(options.ownerId);
      }
      const rows = db.prepare(`
        SELECT * FROM memories
        ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(...params, limit) as MemoryRow[];
      return rows.map(rowToRecord);
    } finally {
      db.close();
    }
  }

  getMemory(memoryId: string): MemoryRecord {
    return this.resolveMemory(memoryId, true);
  }

  updateMemory(memoryId: string, input: UpdateMemoryInput): MemoryRecord {
    this.ensureSchema();
    const target = this.resolveMemory(memoryId, false);
    const updates = Object.entries(input).filter(([, value]) => value !== undefined);
    if (!updates.length) {
      return target;
    }
    const next: MemoryRecord = {
      ...target,
      tier: input.tier ?? target.tier,
      ownerId: input.ownerId !== undefined ? input.ownerId : target.ownerId,
      kind: input.kind ?? target.kind,
      content: input.content ?? target.content,
      confidence: input.confidence ?? target.confidence,
      importance: input.importance ?? target.importance,
      updatedAt: new Date().toISOString()
    };
    const db = this.open();
    try {
      updateMemoryRow(db, next);
      return next;
    } finally {
      db.close();
    }
  }

  archiveMemory(memoryId: string, reason: string, replacedByMemoryId: string | null = null): MemoryRecord {
    this.ensureSchema();
    const target = this.resolveMemory(memoryId, false);
    const db = this.open();
    try {
      const archived = archiveMemoryRow(db, target, reason, replacedByMemoryId);
      return archived;
    } finally {
      db.close();
    }
  }

  archiveOwnerMemories(tier: MemoryTier, ownerId: string, reason: string): number {
    this.ensureSchema();
    const db = this.open();
    try {
      const targets = this.activeSearchableMemories(db, { tier, ownerId });
      for (const target of targets) {
        archiveMemoryRow(db, target, reason, null);
      }
      return targets.length;
    } finally {
      db.close();
    }
  }

  promoteMemory(memoryId: string, options: PromoteMemoryOptions): MemoryTierPromotionRecord {
    this.ensureSchema();
    validateMemoryPromotionOptions(options);
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      const source = this.resolveMemoryWithDb(db, memoryId, false);
      const target = resolvePromotionTarget(source, options);
      const candidate = promotionTargetToCandidate(source, target, options);
      const conflicts = this.findConflictsForPromotionWithDb(db, candidate, [source.id]);
      const hasResolution = options.force || options.replaceMemoryId || options.mergeMemoryId;
      if (conflicts.length && !hasResolution) {
        throw new Error(`Memory promotion conflicts detected. Resolve with --force, --replace, or --merge.\n${formatMemoryConflicts(candidate, conflicts)}`);
      }

      let record: MemoryTierPromotionRecord;
      if (options.mergeMemoryId) {
        const targetMemory = this.resolveMemoryWithDb(db, options.mergeMemoryId, false);
        validatePromotionResolutionTarget(targetMemory, target, candidate.kind);
        const merged: MemoryRecord = {
          ...targetMemory,
          content: options.content?.trim() ?? "",
          kind: candidate.kind,
          confidence: Math.max(targetMemory.confidence, candidate.confidence),
          importance: Math.max(targetMemory.importance, candidate.importance),
          updatedAt: new Date().toISOString()
        };
        if (!merged.content) {
          throw new Error("--merge requires --content with merged memory content.");
        }
        updateMemoryRow(db, merged);
        archiveMemoryRow(db, source, `Promoted to ${target.tier} by merge: ${options.reason}`, merged.id);
        record = createTierPromotionRecord(source, merged, {
          toTier: target.tier,
          toOwnerId: target.ownerId,
          mode: "merge",
          reason: options.reason,
          sourceSnapshot: source,
          targetSnapshot: targetMemory
        });
      } else if (options.replaceMemoryId) {
        const replaced = this.resolveMemoryWithDb(db, options.replaceMemoryId, false);
        validatePromotionResolutionTarget(replaced, target, candidate.kind);
        const promoted = insertMemory(db, promotionCandidateToMemoryInput(candidate, source));
        archiveMemoryRow(db, source, `Promoted to ${target.tier}: ${options.reason}`, promoted.id);
        archiveMemoryRow(db, replaced, `Replaced by memory promotion ${promoted.id}: ${options.reason}`, promoted.id);
        record = createTierPromotionRecord(source, promoted, {
          toTier: target.tier,
          toOwnerId: target.ownerId,
          mode: "replace",
          reason: options.reason,
          replacedMemoryId: replaced.id,
          sourceSnapshot: source,
          replacedSnapshot: replaced
        });
      } else {
        const promoted = insertMemory(db, promotionCandidateToMemoryInput(candidate, source));
        archiveMemoryRow(db, source, `Promoted to ${target.tier}: ${options.reason}`, promoted.id);
        record = createTierPromotionRecord(source, promoted, {
          toTier: target.tier,
          toOwnerId: target.ownerId,
          mode: options.force ? "force" : "promote",
          reason: options.reason,
          sourceSnapshot: source
        });
      }
      upsertTierPromotionRow(db, record);
      db.exec("COMMIT");
      return record;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      throw error;
    } finally {
      db.close();
    }
  }

  promoteCoreMemoryToSkillCandidate(memoryId: string, options: PromoteMemoryToSkillCandidateOptions): { promotion: MemoryTierPromotionRecord; candidate: SkillCandidateRecord } {
    this.ensureSchema();
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      const source = this.resolveMemoryWithDb(db, memoryId, false);
      if (source.tier !== "core") {
        throw new Error("Only core memory can be promoted to a skill candidate.");
      }
      const content = options.content?.trim() || source.content;
      const candidate = createSkillCandidateRecord({
        skillName: options.skillName,
        reason: `Created from core memory ${source.id.slice(0, 8)}: ${options.reason}`,
        content,
        triggers: options.triggers,
        sourceSessionId: source.sourceSessionId ?? undefined,
        sourceAgentId: source.sourceAgentId ?? undefined,
        suggestedByAgentId: source.sourceAgentId ?? undefined
      });
      upsertSkillCandidateRow(db, candidate);
      const promotion = createTierPromotionRecord(source, source, {
        toTier: "skill_candidate",
        toOwnerId: null,
        mode: "skill_candidate",
        reason: options.reason,
        sourceSnapshot: source,
        targetMemoryId: candidate.id
      });
      upsertTierPromotionRow(db, promotion);
      db.exec("COMMIT");
      return { promotion, candidate };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      throw error;
    } finally {
      db.close();
    }
  }

  listTierPromotions(includeReverted = false): MemoryTierPromotionRecord[] {
    return this.readTierPromotionEntries().filter((record) => includeReverted || !record.revertedAt);
  }

  getTierPromotion(promotionId: string): MemoryTierPromotionRecord {
    return resolveTierPromotionFromEntries(this.readTierPromotionEntries(), promotionId, true);
  }

  revertTierPromotion(promotionId: string, reason: string): MemoryTierPromotionRecord {
    this.ensureSchema();
    const promotion = resolveTierPromotionFromEntries(this.readTierPromotionEntries(), promotionId, false);
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      if (promotion.toTier === "skill_candidate") {
        throw new Error("Skill candidate promotions cannot be reverted from memory promotion history. Discard the skill candidate instead.");
      }
      if (promotion.mode === "merge" && promotion.targetSnapshot) {
        restoreMemorySnapshot(db, promotion.targetSnapshot);
      } else {
        const target = this.resolveMemoryWithDb(db, promotion.targetMemoryId, true);
        if (target.status === "active") {
          archiveMemoryRow(db, target, `Reverted memory promotion ${promotion.id}: ${reason}`, null);
        }
      }
      if (promotion.replacedSnapshot) {
        restoreMemorySnapshot(db, promotion.replacedSnapshot);
      }
      if (promotion.sourceSnapshot) {
        restoreMemorySnapshot(db, promotion.sourceSnapshot);
      }
      const updated = {
        ...promotion,
        revertedAt: new Date().toISOString(),
        revertReason: reason
      };
      upsertTierPromotionRow(db, updated);
      db.exec("COMMIT");
      return updated;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      throw error;
    } finally {
      db.close();
    }
  }

  countMemories(): number {
    this.ensureSchema();
    const db = this.open();
    try {
      const row = db.prepare("SELECT COUNT(*) AS count FROM memories WHERE status = 'active'").get() as { count: number };
      return row.count;
    } finally {
      db.close();
    }
  }

  async writeReferenceMemory(session: SessionMetadata, userPrompt: string, executingAgentId?: string): Promise<MemorySearchResult[]> {
    const results = this.search(`${session.goal} ${userPrompt}`, 10, {
      refSessionId: session.id,
      refAgentId: executingAgentId ?? session.assignedAgentId ?? undefined
    });
    const sessionDir = join(this.workspaceRoot, "sessions", session.id);
    const content = results.length
      ? `# REFERENCE MEMORY\n\n${results.map((result) => formatReferenceMemoryLine(result)).join("\n")}\n`
      : "# REFERENCE MEMORY\n\nNo reference memory loaded for this request.\n";
    await writeFile(join(sessionDir, "REF_MEMORY.md"), content, "utf8");
    return results;
  }

  async appendCandidates(candidates: MemoryCandidate[] | undefined, session: SessionMetadata, runId?: string, sourceAgentId?: string): Promise<MemoryCandidateRecord[]> {
    if (!candidates?.length) {
      return [];
    }
    const agentId = sourceAgentId ?? session.assignedAgentId;
    if (!agentId) {
      throw new Error("Cannot append memory candidates without an executing or assigned agent.");
    }
    this.ensureSchema();
    const records: MemoryCandidateRecord[] = candidates.map((candidate) => {
      const parsed = memoryCandidateSchema.parse(candidate);
      return normalizeCandidateRecord({
        id: randomUUID(),
        status: "pending" as const,
        ...parsed,
        sourceSessionId: session.id,
        sourceAgentId: agentId,
        runId,
        createdAt: new Date().toISOString()
      }, session, agentId);
    });
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const record of records) {
        upsertCandidateRow(db, record);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback errors; the original failure is more useful.
      }
      throw error;
    } finally {
      db.close();
    }
    return records;
  }

  async listCandidates(includeAll = false): Promise<CandidateView[]> {
    const entries = await this.readCandidateEntries();
    return entries.filter((entry) => includeAll || entry.record.status === "pending");
  }

  async getCandidate(candidateId: string): Promise<CandidateView> {
    const entries = await this.readCandidateEntries();
    return entries[this.resolveCandidateIndex(entries, candidateId)];
  }

  async findCandidateConflicts(candidateId: string): Promise<{ candidate: MemoryCandidateRecord; conflicts: MemoryConflict[] }> {
    const candidate = await this.pendingCandidateRecord(candidateId);
    return {
      candidate,
      conflicts: this.findConflictsForCandidate(candidate)
    };
  }

  async promoteCandidate(candidateId: string, options: PromoteCandidateOptions = {}): Promise<MemoryRecord> {
    this.ensureSchema();
    validatePromotionOptions(options);
    const entries = await this.readCandidateEntries();
    const index = this.resolveCandidateIndex(entries, candidateId);
    const entry = entries[index];
    if (entry.record.status !== "pending") {
      throw new Error(`Memory candidate is not pending: ${candidateId}`);
    }

    const conflicts = this.findConflictsForCandidate(entry.record);
    const hasResolution = options.force || options.replaceMemoryId || options.mergeMemoryId;
    if (conflicts.length && !hasResolution) {
      throw new Error(`Memory candidate conflicts detected. Resolve with --force, --replace, or --merge.\n${formatMemoryConflicts(entry.record, conflicts)}`);
    }

    if (options.mergeMemoryId) {
      return this.mergeCandidate(entries, index, entry.record, options.mergeMemoryId, options.mergeContent);
    }
    if (options.replaceMemoryId) {
      return this.replaceCandidate(entries, index, entry.record, options.replaceMemoryId);
    }
    return this.insertCandidateMemory(entries, index, entry.record);
  }

  async discardCandidate(candidateId: string, reason: string): Promise<MemoryCandidateRecord> {
    let discarded: MemoryCandidateRecord | undefined;
    await this.updateCandidate(candidateId, (record) => {
      if (record.status !== "pending") {
        throw new Error(`Memory candidate is not pending: ${candidateId}`);
      }
      discarded = {
        ...record,
        status: "discarded",
        reviewedAt: new Date().toISOString(),
        discardReason: reason
      };
      return discarded;
    });
    if (!discarded) {
      throw new Error(`Memory candidate could not be discarded: ${candidateId}`);
    }
    return discarded;
  }

  cleanupDiscardedCandidates(options: { olderThanDays?: number; apply?: boolean } = {}): CandidateCleanupResult {
    const olderThanDays = options.olderThanDays ?? 7;
    const apply = options.apply ?? true;
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    this.ensureSchema();
    const db = this.open();
    try {
      const rows = db.prepare("SELECT id, record_json FROM memory_candidates ORDER BY created_at ASC, rowid ASC").all() as CandidateRow[];
      const records = rows.map((row) => memoryCandidateRecordSchema.parse(JSON.parse(row.record_json)));
      const expired = records.filter((record) => {
        if (record.status !== "discarded") {
          return false;
        }
        const referenceTime = record.reviewedAt ?? record.createdAt;
        return referenceTime < cutoff;
      });
      const retainedDiscarded = records.filter((record) => record.status === "discarded").length - expired.length;
      if (apply && expired.length) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const statement = db.prepare("DELETE FROM memory_candidates WHERE id = ?");
          for (const record of expired) {
            statement.run(record.id);
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
      }
      return {
        olderThanDays,
        cutoff,
        eligible: expired.length,
        deleted: apply ? expired.length : 0,
        retainedDiscarded,
        applied: apply
      };
    } finally {
      db.close();
    }
  }

  async countPendingCandidates(): Promise<number> {
    return (await this.listCandidates(false)).filter((candidate) => candidate.record?.status === "pending").length;
  }

  async reviewCandidates(candidates: MemoryCandidateRecord[], policy: AutoPromotionPolicy): Promise<MemoryReviewSummary> {
    const reviews: CandidateReview[] = [];
    for (const candidate of candidates) {
      const conflicts = this.findConflictsForCandidate(candidate);
      const classification = classifyMemoryCandidate(candidate, conflicts.length > 0);
      let autoPromoted: AutoPromotionRecord | undefined;
      if (shouldAutoPromote(candidate, conflicts, classification, policy)) {
        autoPromoted = this.autoPromoteCandidate(candidate.id, classification, policy.mode);
      }
      reviews.push({ candidate, conflicts, classification, autoPromoted });
    }
    return summarizeReviews(reviews);
  }

  async reviewPendingCandidates(options: { latest?: boolean } = {}): Promise<CandidateReview[]> {
    const candidates = (await this.listCandidates()).map((candidate) => candidate.record);
    const selected = options.latest ? latestRunCandidates(candidates) : candidates;
    return selected.map((candidate) => {
      const conflicts = this.findConflictsForCandidate(candidate);
      return {
        candidate,
        conflicts,
        classification: classifyMemoryCandidate(candidate, conflicts.length > 0)
      };
    });
  }

  listPromotions(includeReverted = false): AutoPromotionRecord[] {
    return this.readPromotionEntries().filter((record) => includeReverted || !record.revertedAt);
  }

  getPromotion(promotionId: string): AutoPromotionRecord {
    return resolvePromotionFromEntries(this.readPromotionEntries(), promotionId, true);
  }

  revertPromotion(promotionId: string, reason: string): AutoPromotionRecord {
    this.ensureSchema();
    const promotion = resolvePromotionFromEntries(this.readPromotionEntries(), promotionId, false);
    const entries = this.readCandidateEntriesSync();
    const index = this.resolveCandidateIndex(entries, promotion.candidateId);
    const candidate = entries[index].record;
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      const memory = this.resolveMemoryWithDb(db, promotion.promotedMemoryId, false);
      archiveMemoryRow(db, memory, `Reverted auto promotion ${promotion.id}: ${reason}`, null);
      if (candidate) {
        upsertCandidateRow(db, {
          ...candidate,
          status: "reverted",
          reviewedAt: new Date().toISOString()
        });
      }
      const updated = {
        ...promotion,
        revertedAt: new Date().toISOString(),
        revertReason: reason
      };
      upsertPromotionRow(db, updated);
      db.exec("COMMIT");
      return updated;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback errors; the original failure is more useful.
      }
      throw error;
    } finally {
      db.close();
    }
  }

  async promoteAllLowRisk(options: { yes?: boolean } = {}): Promise<MemoryReviewSummary> {
    const reviews = await this.reviewPendingCandidates();
    const promotable = reviews.filter((review) => review.classification.riskLevel === "low" && !review.conflicts.length);
    if (!options.yes) {
      return summarizeReviews(promotable);
    }
    const promoted: CandidateReview[] = [];
    for (const review of promotable) {
      const memory = await this.promoteCandidate(review.candidate.id);
      promoted.push({
        ...review,
        autoPromoted: {
          id: `manual-batch:${memory.id}`,
          candidateId: review.candidate.id,
          promotedMemoryId: memory.id,
          sessionId: review.candidate.sourceSessionId,
          agentId: review.candidate.sourceAgentId,
          riskLevel: review.classification.riskLevel,
          reasons: review.classification.reasons,
          policyMode: "manual",
          createdAt: new Date().toISOString()
        }
      });
    }
    return summarizeReviews(promoted);
  }

  async discardAllLowRisk(reason: string, options: { yes?: boolean } = {}): Promise<MemoryReviewSummary> {
    const reviews = await this.reviewPendingCandidates();
    const discardable = reviews.filter((review) => review.classification.riskLevel === "low" && !review.conflicts.length);
    if (!options.yes) {
      return summarizeReviews(discardable);
    }
    for (const review of discardable) {
      await this.discardCandidate(review.candidate.id, reason);
    }
    return summarizeReviews(discardable);
  }

  private insertCandidateMemory(entries: CandidateView[], index: number, candidate: MemoryCandidateRecord): MemoryRecord {
    return this.transactCandidateUpdate(entries, index, (db) => {
      const promoted = insertMemory(db, candidateToMemoryInput(candidate));
      return {
        result: promoted,
        candidate: {
          ...candidate,
          status: "promoted",
          reviewedAt: new Date().toISOString(),
          promotedMemoryId: promoted.id
        }
      };
    });
  }

  private autoPromoteCandidate(candidateId: string, classification: RiskClassification, policyMode: AutoPromotionMode): AutoPromotionRecord {
    const entries = this.readCandidateEntriesSync();
    const index = this.resolveCandidateIndex(entries, candidateId);
    const entry = entries[index];
    if (entry.record.status !== "pending") {
      throw new Error(`Memory candidate is not pending: ${candidateId}`);
    }
    return this.transactCandidateUpdate(entries, index, (db) => {
      const promoted = insertMemory(db, candidateToMemoryInput(entry.record as MemoryCandidateRecord));
      const promotion: AutoPromotionRecord = {
        id: randomUUID(),
        candidateId: entry.record.id,
        promotedMemoryId: promoted.id,
        runId: entry.record.runId,
        sessionId: entry.record.sourceSessionId,
        agentId: entry.record.sourceAgentId,
        riskLevel: classification.riskLevel,
        reasons: classification.reasons,
        policyMode,
        createdAt: new Date().toISOString()
      };
      return {
        result: promotion,
        candidate: {
          ...entry.record,
          status: "auto_promoted",
          reviewedAt: new Date().toISOString(),
          promotedMemoryId: promoted.id,
          autoPromotionId: promotion.id,
          riskLevel: classification.riskLevel,
          riskReasons: classification.reasons
        }
      };
    });
  }

  private replaceCandidate(entries: CandidateView[], index: number, candidate: MemoryCandidateRecord, memoryId: string): MemoryRecord {
    const target = this.resolveMemory(memoryId, false);
    return this.transactCandidateUpdate(entries, index, (db) => {
      const promoted = insertMemory(db, candidateToMemoryInput(candidate));
      archiveMemoryRow(db, target, `Replaced by memory candidate ${candidate.id}`, promoted.id);
      return {
        result: promoted,
        candidate: {
          ...candidate,
          status: "promoted",
          reviewedAt: new Date().toISOString(),
          promotedMemoryId: promoted.id
        }
      };
    });
  }

  private mergeCandidate(entries: CandidateView[], index: number, candidate: MemoryCandidateRecord, memoryId: string, content: string | undefined): MemoryRecord {
    if (!content?.trim()) {
      throw new Error("--merge requires --content with merged memory content.");
    }
    const target = this.resolveMemory(memoryId, false);
    return this.transactCandidateUpdate(entries, index, (db) => {
      const merged: MemoryRecord = {
        ...target,
        content,
        confidence: Math.max(target.confidence, candidate.confidence),
        importance: Math.max(target.importance, candidate.importance),
        updatedAt: new Date().toISOString()
      };
      updateMemoryRow(db, merged);
      return {
        result: merged,
        candidate: {
          ...candidate,
          status: "promoted",
          reviewedAt: new Date().toISOString(),
          promotedMemoryId: merged.id
        }
      };
    });
  }

  private transactCandidateUpdate<T>(
    entries: CandidateView[],
    index: number,
    work: (db: DatabaseSync) => { result: T; candidate: MemoryCandidateRecord }
  ): T {
    this.ensureSchema();
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      const output = work(db);
      entries[index] = candidateToView(output.candidate, index + 1);
      upsertCandidateRow(db, output.candidate);
      if (isAutoPromotionRecord(output.result)) {
        upsertPromotionRow(db, output.result);
      }
      db.exec("COMMIT");
      return output.result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback errors; the original failure is more useful.
      }
      throw error;
    } finally {
      db.close();
    }
  }

  private findConflictsForCandidate(candidate: MemoryCandidateRecord): MemoryConflict[] {
    this.ensureSchema();
    const db = this.open();
    try {
      return this.findConflictsForPromotionWithDb(db, candidate);
    } finally {
      db.close();
    }
  }

  private findConflictsForPromotionWithDb(db: DatabaseSync, candidate: MemoryCandidateRecord, excludeMemoryIds: string[] = []): MemoryConflict[] {
    const candidateNormalized = normalizeMemoryText(candidate.content);
    const candidateTokens = memoryTokenSet(candidate.content);
    if (!candidateNormalized || !candidateTokens.size) {
      return [];
    }
    const excluded = new Set(excludeMemoryIds);
    return this.activeSearchableMemories(db, { tier: candidate.tier, ownerId: candidate.ownerId })
      .flatMap((memory) => {
        if (excluded.has(memory.id) || !isComparableMemory(candidate, memory)) {
          return [];
        }
        const memoryNormalized = normalizeMemoryText(memory.content);
        const memoryTokens = memoryTokenSet(memory.content);
        const matchedTokens = intersectMemoryTokens([...candidateTokens], memoryTokens);
        const overlapRatio = matchedTokens.length / Math.max(1, Math.min(candidateTokens.size, memoryTokens.size));
        const type = classifyConflict(candidateNormalized, memoryNormalized, overlapRatio);
        if (!type) {
          return [];
        }
        return [{
          type,
          memory,
          score: calculateMemoryScore(candidate.content, memory).score,
          overlapRatio,
          matchedTokens,
          candidatePreview: previewMemoryText(candidate.content),
          memoryPreview: previewMemoryText(memory.content)
        }];
      })
      .sort((a, b) => conflictRank[a.type] - conflictRank[b.type] || b.overlapRatio - a.overlapRatio);
  }

  private async pendingCandidateRecord(candidateId: string): Promise<MemoryCandidateRecord> {
    const candidate = await this.getCandidate(candidateId);
    if (candidate.record.status !== "pending") {
      throw new Error(`Memory candidate is not pending: ${candidateId}`);
    }
    return candidate.record;
  }

  private activeSearchableMemories(db: DatabaseSync, options: MemorySearchOptions = {}): MemoryRecord[] {
    const now = new Date().toISOString();
    const rows = db.prepare(`
      SELECT * FROM memories
      WHERE status = 'active'
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY updated_at DESC
    `).all(now) as MemoryRow[];
    return rows
      .map(rowToRecord)
      .filter((record) => memoryMatchesSearchOptions(record, options));
  }

  private resolveMemory(memoryId: string, includeAll: boolean): MemoryRecord {
    this.ensureSchema();
    const db = this.open();
    try {
      return this.resolveMemoryWithDb(db, memoryId, includeAll);
    } finally {
      db.close();
    }
  }

  private resolveMemoryWithDb(db: DatabaseSync, memoryId: string, includeAll: boolean): MemoryRecord {
    const normalized = memoryId.trim();
    if (!normalized) {
      throw new Error("Memory id is required.");
    }
    const rows = db.prepare(`
      SELECT * FROM memories
      ${includeAll ? "" : "WHERE status = 'active'"}
      ORDER BY updated_at DESC
    `).all() as MemoryRow[];
    const records = rows.map(rowToRecord);
    const exact = records.find((record) => record.id === normalized);
    if (exact) {
      return exact;
    }
    const matches = records.filter((record) => record.id.startsWith(normalized));
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      throw new Error(`Memory id prefix is ambiguous: ${memoryId}. Matches: ${matches.map((record) => record.id).join(", ")}`);
    }
    throw new Error(`Memory not found: ${memoryId}`);
  }

  private async updateCandidate(
    candidateId: string,
    update: (record: MemoryCandidateRecord) => MemoryCandidateRecord
  ): Promise<void> {
    const entries = await this.readCandidateEntries();
    const index = this.resolveCandidateIndex(entries, candidateId);
    const entry = entries[index];
    entries[index] = candidateToView(update(entry.record), index + 1);
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      upsertCandidateRow(db, entries[index].record as MemoryCandidateRecord);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback errors; the original failure is more useful.
      }
      throw error;
    } finally {
      db.close();
    }
  }

  private resolveCandidateIndex(entries: CandidateView[], candidateId: string): number {
    const normalized = candidateId.trim();
    if (!normalized) {
      throw new Error("Memory candidate id is required.");
    }
    const exactIndex = entries.findIndex((entry) => entry.displayId === normalized);
    if (exactIndex !== -1) {
      return exactIndex;
    }

    const matches = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.displayId.startsWith(normalized));
    if (matches.length === 1) {
      return matches[0].index;
    }
    if (matches.length > 1) {
      throw new Error(`Memory candidate id prefix is ambiguous: ${candidateId}. Matches: ${matches.map(({ entry }) => entry.displayId).join(", ")}`);
    }
    throw new Error(`Memory candidate not found: ${candidateId}`);
  }

  private async readCandidateEntries(): Promise<CandidateView[]> {
    return this.readCandidateEntriesSync();
  }

  private readCandidateEntriesSync(): CandidateView[] {
    this.ensureSchema();
    const db = this.open();
    try {
      cleanupDiscardedCandidateRows(db, 7);
      const rows = db.prepare("SELECT id, record_json FROM memory_candidates ORDER BY created_at ASC, rowid ASC").all() as CandidateRow[];
      return rows.map((row, index) => candidateToView(memoryCandidateRecordSchema.parse(JSON.parse(row.record_json)), index + 1));
    } finally {
      db.close();
    }
  }

  private readPromotionEntries(): AutoPromotionRecord[] {
    this.ensureSchema();
    const db = this.open();
    try {
      const rows = db.prepare("SELECT id, record_json FROM auto_promotions ORDER BY created_at ASC, rowid ASC").all() as PromotionRow[];
      return rows.map((row) => JSON.parse(row.record_json) as AutoPromotionRecord);
    } finally {
      db.close();
    }
  }

  private readTierPromotionEntries(): MemoryTierPromotionRecord[] {
    this.ensureSchema();
    const db = this.open();
    try {
      const rows = db.prepare("SELECT id, record_json FROM memory_tier_promotions ORDER BY created_at ASC, rowid ASC").all() as TierPromotionRow[];
      return rows.map((row) => JSON.parse(row.record_json) as MemoryTierPromotionRecord);
    } finally {
      db.close();
    }
  }

  exportCandidatesJsonl(): string {
    const entries = this.readCandidateEntriesSync().map((entry) => entry.record);
    return entries.length ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "";
  }

  exportPromotionsJsonl(): string {
    const entries = this.readPromotionEntries();
    return entries.length ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "";
  }

  private ensureMemoryDir(): void {
    if (!existsSync(this.memoryDir)) {
      mkdirSync(this.memoryDir, { recursive: true });
    }
  }

  private open(): DatabaseSync {
    return new DatabaseSync(this.dbPath);
  }
}

export function formatMemoryReviewSummary(summary: MemoryReviewSummary): string {
  const lines = [
    `Memory review: ${summary.created} candidates`,
    `Auto-promoted: ${summary.autoPromoted}`,
    `Pending review: ${summary.pending}`,
    `Conflicts: ${summary.conflicts}`
  ];
  for (const review of summary.reviews) {
    const id = review.candidate.id.slice(0, 8);
    const status = review.autoPromoted ? "auto-promoted" : "pending";
    const conflictText = review.conflicts.length ? ` conflicts:${review.conflicts.length}` : "";
    lines.push(`- ${id} ${status} risk:${review.classification.riskLevel}${conflictText} ${review.candidate.tier}/${review.candidate.kind}`);
    lines.push(`  reasons: ${review.classification.reasons.join(", ") || "none"}`);
    lines.push(`  content: ${redactedCandidatePreview(review.candidate, review.classification)}`);
    if (review.conflicts.length) {
      lines.push(`  review: cosia memory candidate conflicts ${id}`);
    }
    if (review.autoPromoted) {
      lines.push(`  revert: cosia memory promotion revert ${review.autoPromoted.id.slice(0, 8)} --reason "<reason>"`);
    }
  }
  return lines.join("\n");
}

function shouldAutoPromote(
  candidate: MemoryCandidateRecord,
  conflicts: MemoryConflict[],
  classification: RiskClassification,
  policy: AutoPromotionPolicy
): boolean {
  if (policy.mode === "manual" || policy.mode === "strict") {
    return false;
  }
  if (policy.requireNoConflict && conflicts.length > 0) {
    return false;
  }
  if (policy.denyTiers?.includes(candidate.tier)) {
    return false;
  }
  if (policy.allowTiers && !policy.allowTiers.includes(candidate.tier)) {
    return false;
  }
  if (policy.denyKinds.includes(candidate.kind.toLowerCase())) {
    return false;
  }
  const modeAllowedLevels = policy.mode === "balanced" ? ["low", "medium"] : ["low"];
  const allowedLevels = policy.allowRiskLevels.filter((level) => modeAllowedLevels.includes(level));
  return classification.autoPromotable && allowedLevels.includes(classification.riskLevel);
}

function summarizeReviews(reviews: CandidateReview[]): MemoryReviewSummary {
  return {
    created: reviews.length,
    autoPromoted: reviews.filter((review) => review.autoPromoted).length,
    pending: reviews.filter((review) => !review.autoPromoted).length,
    conflicts: reviews.filter((review) => review.conflicts.length > 0).length,
    reviews
  };
}

function latestRunCandidates(candidates: MemoryCandidateRecord[]): MemoryCandidateRecord[] {
  const latestRunId = [...candidates].reverse().find((candidate) => candidate.runId)?.runId;
  if (latestRunId) {
    return candidates.filter((candidate) => candidate.runId === latestRunId);
  }
  const latestCreatedAt = candidates.map((candidate) => candidate.createdAt).sort().at(-1);
  return latestCreatedAt ? candidates.filter((candidate) => candidate.createdAt === latestCreatedAt) : [];
}

function resolvePromotionFromEntries(entries: AutoPromotionRecord[], promotionId: string, includeReverted: boolean): AutoPromotionRecord {
  const normalized = promotionId.trim();
  if (!normalized) {
    throw new Error("Promotion id is required.");
  }
  const candidates = includeReverted ? entries : entries.filter((entry) => !entry.revertedAt);
  const exact = candidates.find((entry) => entry.id === normalized);
  if (exact) {
    return exact;
  }
  const matches = candidates.filter((entry) => entry.id.startsWith(normalized));
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`Promotion id prefix is ambiguous: ${promotionId}. Matches: ${matches.map((entry) => entry.id).join(", ")}`);
  }
  throw new Error(`Promotion not found: ${promotionId}`);
}

function upsertCandidateRow(db: DatabaseSync, record: MemoryCandidateRecord): void {
  const normalized = memoryCandidateRecordSchema.parse(record);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO memory_candidates (
      id, status, tier, owner_id, kind, content, importance, confidence,
      source_session_id, source_agent_id, run_id, created_at, reviewed_at,
      promoted_memory_id, auto_promotion_id, risk_level, risk_reasons_json,
      discard_reason, record_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      tier = excluded.tier,
      owner_id = excluded.owner_id,
      kind = excluded.kind,
      content = excluded.content,
      importance = excluded.importance,
      confidence = excluded.confidence,
      source_session_id = excluded.source_session_id,
      source_agent_id = excluded.source_agent_id,
      run_id = excluded.run_id,
      created_at = excluded.created_at,
      reviewed_at = excluded.reviewed_at,
      promoted_memory_id = excluded.promoted_memory_id,
      auto_promotion_id = excluded.auto_promotion_id,
      risk_level = excluded.risk_level,
      risk_reasons_json = excluded.risk_reasons_json,
      discard_reason = excluded.discard_reason,
      record_json = excluded.record_json,
      updated_at = excluded.updated_at
  `).run(
    normalized.id,
    normalized.status,
    normalized.tier,
    normalized.ownerId ?? null,
    normalized.kind,
    normalized.content,
    normalized.importance,
    normalized.confidence,
    normalized.sourceSessionId,
    normalized.sourceAgentId,
    normalized.runId ?? null,
    normalized.createdAt,
    normalized.reviewedAt ?? null,
    normalized.promotedMemoryId ?? null,
    normalized.autoPromotionId ?? null,
    normalized.riskLevel ?? null,
    normalized.riskReasons ? JSON.stringify(normalized.riskReasons) : null,
    normalized.discardReason ?? null,
    JSON.stringify(normalized),
    now
  );
}

function cleanupDiscardedCandidateRows(db: DatabaseSync, olderThanDays: number): number {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare("SELECT id, record_json FROM memory_candidates").all() as CandidateRow[];
  const expired = rows
    .map((row) => memoryCandidateRecordSchema.parse(JSON.parse(row.record_json)))
    .filter((record) => record.status === "discarded" && (record.reviewedAt ?? record.createdAt) < cutoff);
  if (!expired.length) {
    return 0;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const statement = db.prepare("DELETE FROM memory_candidates WHERE id = ?");
    for (const record of expired) {
      statement.run(record.id);
    }
    db.exec("COMMIT");
    return expired.length;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
}

function upsertPromotionRow(db: DatabaseSync, record: AutoPromotionRecord): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO auto_promotions (
      id, candidate_id, promoted_memory_id, run_id, session_id, agent_id,
      risk_level, reasons_json, policy_mode, created_at, reverted_at,
      revert_reason, record_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      candidate_id = excluded.candidate_id,
      promoted_memory_id = excluded.promoted_memory_id,
      run_id = excluded.run_id,
      session_id = excluded.session_id,
      agent_id = excluded.agent_id,
      risk_level = excluded.risk_level,
      reasons_json = excluded.reasons_json,
      policy_mode = excluded.policy_mode,
      created_at = excluded.created_at,
      reverted_at = excluded.reverted_at,
      revert_reason = excluded.revert_reason,
      record_json = excluded.record_json,
      updated_at = excluded.updated_at
  `).run(
    record.id,
    record.candidateId,
    record.promotedMemoryId,
    record.runId ?? null,
    record.sessionId,
    record.agentId,
    record.riskLevel,
    JSON.stringify(record.reasons),
    record.policyMode,
    record.createdAt,
    record.revertedAt ?? null,
    record.revertReason ?? null,
    JSON.stringify(record),
    now
  );
}

function upsertTierPromotionRow(db: DatabaseSync, record: MemoryTierPromotionRecord): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO memory_tier_promotions (
      id, source_memory_id, target_memory_id, replaced_memory_id, from_tier, to_tier,
      from_owner_id, to_owner_id, mode, reason, created_at, reverted_at, revert_reason,
      record_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source_memory_id = excluded.source_memory_id,
      target_memory_id = excluded.target_memory_id,
      replaced_memory_id = excluded.replaced_memory_id,
      from_tier = excluded.from_tier,
      to_tier = excluded.to_tier,
      from_owner_id = excluded.from_owner_id,
      to_owner_id = excluded.to_owner_id,
      mode = excluded.mode,
      reason = excluded.reason,
      created_at = excluded.created_at,
      reverted_at = excluded.reverted_at,
      revert_reason = excluded.revert_reason,
      record_json = excluded.record_json,
      updated_at = excluded.updated_at
  `).run(
    record.id,
    record.sourceMemoryId,
    record.targetMemoryId,
    record.replacedMemoryId ?? null,
    record.fromTier,
    record.toTier,
    record.fromOwnerId ?? null,
    record.toOwnerId ?? null,
    record.mode,
    record.reason,
    record.createdAt,
    record.revertedAt ?? null,
    record.revertReason ?? null,
    JSON.stringify(record),
    now
  );
}

function resolveTierPromotionFromEntries(entries: MemoryTierPromotionRecord[], promotionId: string, includeReverted: boolean): MemoryTierPromotionRecord {
  const normalized = promotionId.trim();
  if (!normalized) {
    throw new Error("Memory tier promotion id is required.");
  }
  const candidates = includeReverted ? entries : entries.filter((entry) => !entry.revertedAt);
  const matches = candidates.filter((entry) => entry.id === normalized || entry.id.startsWith(normalized));
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`Memory tier promotion id prefix is ambiguous: ${promotionId}. Matches: ${matches.map((entry) => entry.id).join(", ")}`);
  }
  throw new Error(`Memory tier promotion not found: ${promotionId}`);
}

function isAutoPromotionRecord(value: unknown): value is AutoPromotionRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<AutoPromotionRecord>;
  return typeof record.id === "string"
    && typeof record.candidateId === "string"
    && typeof record.promotedMemoryId === "string"
    && typeof record.sessionId === "string"
    && typeof record.agentId === "string"
    && (record.riskLevel === "low" || record.riskLevel === "medium" || record.riskLevel === "high")
    && Array.isArray(record.reasons)
    && typeof record.policyMode === "string"
    && typeof record.createdAt === "string";
}

export function formatMemoryConflicts(candidate: MemoryCandidateRecord, conflicts: MemoryConflict[]): string {
  if (!conflicts.length) {
    return `No memory conflicts for candidate ${candidate.id}.`;
  }
  const lines = [
    `Candidate: ${candidate.id}`,
    `Tier: ${candidate.tier}/${candidate.kind}`,
    `Content: ${previewMemoryText(candidate.content)}`,
    `Conflicts: ${conflicts.length}`,
    ""
  ];
  conflicts.forEach((conflict, index) => {
    lines.push(`${index + 1}. ${conflict.type}  memory:${conflict.memory.id.slice(0, 8)}  ${conflict.memory.tier}/${conflict.memory.kind}`);
    lines.push(`   score: ${conflict.score.toFixed(2)}  overlap: ${conflict.overlapRatio.toFixed(2)}`);
    lines.push(`   memory: ${conflict.memoryPreview}`);
    lines.push(`   candidate: ${conflict.candidatePreview}`);
  });
  return lines.join("\n");
}

function validatePromotionOptions(options: PromoteCandidateOptions): void {
  const selected = [options.force, options.replaceMemoryId, options.mergeMemoryId].filter(Boolean).length;
  if (selected > 1) {
    throw new Error("Use only one promotion resolution: --force, --replace, or --merge.");
  }
  if (options.mergeContent && !options.mergeMemoryId) {
    throw new Error("--content for candidate promote is only valid with --merge.");
  }
}

function validateMemoryPromotionOptions(options: PromoteMemoryOptions): void {
  const selected = [options.force, options.replaceMemoryId, options.mergeMemoryId].filter(Boolean).length;
  if (selected > 1) {
    throw new Error("Use only one memory promotion resolution: --force, --replace, or --merge.");
  }
  if (!options.reason.trim()) {
    throw new Error("--reason is required for memory promotion.");
  }
  if (options.mergeMemoryId && !options.content?.trim()) {
    throw new Error("--merge requires --content with merged memory content.");
  }
}

function resolvePromotionTarget(source: MemoryRecord, options: PromoteMemoryOptions): { tier: Extract<MemoryTier, "agent" | "core">; ownerId: string | null } {
  if (source.tier === "core") {
    throw new Error("Core memory cannot be promoted to agent or session memory.");
  }
  if (source.tier === "agent" && options.toTier !== "core") {
    throw new Error("Agent memory can only be promoted to core memory.");
  }
  if (source.tier === "session" && options.toTier !== "agent" && options.toTier !== "core") {
    throw new Error("Session memory can only be promoted to agent or core memory.");
  }
  if (options.toTier === "agent") {
    if (!options.ownerId?.trim()) {
      throw new Error("--owner-id is required when promoting memory to agent tier.");
    }
    return { tier: "agent", ownerId: options.ownerId };
  }
  return { tier: "core", ownerId: null };
}

function promotionTargetToCandidate(
  source: MemoryRecord,
  target: { tier: Extract<MemoryTier, "agent" | "core">; ownerId: string | null },
  options: PromoteMemoryOptions
): MemoryCandidateRecord {
  return memoryCandidateRecordSchema.parse({
    id: `promotion:${source.id}`,
    status: "pending",
    tier: target.tier,
    ownerId: target.ownerId ?? undefined,
    kind: options.kind ?? source.kind,
    content: options.content?.trim() || source.content,
    importance: options.importance ?? source.importance,
    confidence: options.confidence ?? source.confidence,
    sourceSessionId: source.sourceSessionId ?? source.ownerId ?? "memory-promotion",
    sourceAgentId: source.sourceAgentId ?? target.ownerId ?? "memory-promotion",
    createdAt: new Date().toISOString()
  });
}

function promotionCandidateToMemoryInput(candidate: MemoryCandidateRecord, source: MemoryRecord): AddMemoryInput {
  return {
    tier: candidate.tier,
    ownerId: candidate.ownerId,
    kind: candidate.kind,
    content: candidate.content,
    importance: candidate.importance,
    confidence: candidate.confidence,
    sourceSessionId: source.sourceSessionId ?? (source.tier === "session" ? source.ownerId ?? undefined : undefined),
    sourceAgentId: source.sourceAgentId ?? (source.tier === "agent" ? source.ownerId ?? undefined : undefined)
  };
}

function validatePromotionResolutionTarget(
  memory: MemoryRecord,
  target: { tier: Extract<MemoryTier, "agent" | "core">; ownerId: string | null },
  kind: string
): void {
  if (memory.tier !== target.tier || memory.ownerId !== target.ownerId || memory.kind !== kind) {
    throw new Error(`Resolution memory must match target tier, owner, and kind: expected ${target.tier}/${kind}.`);
  }
}

function createTierPromotionRecord(
  source: MemoryRecord,
  target: MemoryRecord,
  options: {
    toTier: MemoryTierPromotionTarget;
    toOwnerId?: string | null;
    mode: MemoryTierPromotionMode;
    reason: string;
    replacedMemoryId?: string;
    targetMemoryId?: string;
    sourceSnapshot?: MemoryRecord;
    targetSnapshot?: MemoryRecord;
    replacedSnapshot?: MemoryRecord;
  }
): MemoryTierPromotionRecord {
  return {
    id: randomUUID(),
    sourceMemoryId: source.id,
    targetMemoryId: options.targetMemoryId ?? target.id,
    replacedMemoryId: options.replacedMemoryId,
    fromTier: source.tier,
    toTier: options.toTier,
    fromOwnerId: source.ownerId,
    toOwnerId: options.toOwnerId ?? target.ownerId,
    mode: options.mode,
    reason: options.reason,
    createdAt: new Date().toISOString(),
    sourceSnapshot: options.sourceSnapshot,
    targetSnapshot: options.targetSnapshot,
    replacedSnapshot: options.replacedSnapshot
  };
}

function normalizeMemoryOwnership(input: {
  tier?: MemoryTier;
  ownerId?: string | null;
  sourceSessionId?: string;
  sourceAgentId?: string;
}): { tier: MemoryTier; ownerId: string | null } {
  const parsedTier = input.tier ? memoryTierSchema.parse(input.tier) : undefined;
  const tier = parsedTier ?? "session";
  const ownerId = input.ownerId !== undefined
    ? input.ownerId
    : tier === "session"
      ? input.sourceSessionId ?? null
      : tier === "agent"
        ? input.sourceAgentId ?? null
        : null;
  return {
    tier,
    ownerId: ownerId ?? null
  };
}

function normalizeCandidateRecord(
  candidate: Omit<MemoryCandidateRecord, "tier"> & Partial<Pick<MemoryCandidateRecord, "tier">>,
  session: SessionMetadata,
  executingAgentId: string
): MemoryCandidateRecord {
  const ownership = normalizeMemoryOwnership({
    tier: candidate.tier,
    ownerId: candidate.ownerId,
    sourceSessionId: session.id,
    sourceAgentId: executingAgentId
  });
  return memoryCandidateRecordSchema.parse({
    ...candidate,
    tier: ownership.tier,
    ownerId: ownership.ownerId ?? undefined
  });
}

function candidateToView(record: MemoryCandidateRecord, lineNumber: number): CandidateView {
  return {
    displayId: record.id || `line:${lineNumber}`,
    record
  };
}

function candidateToMemoryInput(candidate: MemoryCandidateRecord): AddMemoryInput {
  return {
    tier: candidate.tier,
    content: candidate.content,
    ownerId: candidate.ownerId,
    kind: candidate.kind,
    sourceSessionId: candidate.sourceSessionId,
    sourceAgentId: candidate.sourceAgentId,
    confidence: candidate.confidence,
    importance: candidate.importance
  };
}

function insertMemory(db: DatabaseSync, input: AddMemoryInput): MemoryRecord {
  const ownership = normalizeMemoryOwnership(input);
  const now = new Date().toISOString();
  const record: MemoryRecord = {
    id: randomUUID(),
    tier: ownership.tier,
    ownerId: ownership.ownerId,
    kind: input.kind ?? "note",
    content: input.content,
    sourceSessionId: input.sourceSessionId ?? null,
    sourceAgentId: input.sourceAgentId ?? null,
    confidence: input.confidence ?? 0.7,
    importance: input.importance ?? 3,
    status: "active",
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: null,
    validFrom: input.validFrom ?? null,
    validUntil: input.validUntil ?? null,
    expiresAt: input.expiresAt ?? null,
    archivedAt: null,
    archiveReason: null,
    replacedByMemoryId: null
  };
  db.prepare(`
    INSERT INTO memories (
      id, tier, owner_id, kind, content, source_session_id, source_agent_id,
      confidence, importance, status, created_at, updated_at, last_accessed_at,
      valid_from, valid_until, expires_at, archived_at, archive_reason, replaced_by_memory_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.tier,
    record.ownerId,
    record.kind,
    record.content,
    record.sourceSessionId,
    record.sourceAgentId,
    record.confidence,
    record.importance,
    record.status,
    record.createdAt,
    record.updatedAt,
    record.lastAccessedAt,
    record.validFrom,
    record.validUntil,
    record.expiresAt,
    record.archivedAt,
    record.archiveReason,
    record.replacedByMemoryId
  );
  return record;
}

function updateMemoryRow(db: DatabaseSync, record: MemoryRecord): void {
  db.prepare(`
    UPDATE memories
    SET tier = ?, owner_id = ?, kind = ?, content = ?,
      confidence = ?, importance = ?, updated_at = ?
    WHERE id = ? AND status = 'active'
  `).run(
    record.tier,
    record.ownerId,
    record.kind,
    record.content,
    record.confidence,
    record.importance,
    record.updatedAt,
    record.id
  );
}

function restoreMemorySnapshot(db: DatabaseSync, record: MemoryRecord): void {
  db.prepare(`
    UPDATE memories
    SET tier = ?, owner_id = ?, kind = ?, content = ?,
      source_session_id = ?, source_agent_id = ?, confidence = ?, importance = ?, status = ?,
      updated_at = ?, last_accessed_at = ?, valid_from = ?, valid_until = ?, expires_at = ?,
      archived_at = ?, archive_reason = ?, replaced_by_memory_id = ?
    WHERE id = ?
  `).run(
    record.tier,
    record.ownerId,
    record.kind,
    record.content,
    record.sourceSessionId,
    record.sourceAgentId,
    record.confidence,
    record.importance,
    record.status,
    new Date().toISOString(),
    record.lastAccessedAt,
    record.validFrom,
    record.validUntil,
    record.expiresAt,
    record.archivedAt,
    record.archiveReason,
    record.replacedByMemoryId,
    record.id
  );
}

function archiveMemoryRow(db: DatabaseSync, target: MemoryRecord, reason: string, replacedByMemoryId: string | null): MemoryRecord {
  const now = new Date().toISOString();
  const archived: MemoryRecord = {
    ...target,
    status: "archived",
    updatedAt: now,
    archivedAt: now,
    archiveReason: reason,
    replacedByMemoryId
  };
  db.prepare(`
    UPDATE memories
    SET status = 'archived', updated_at = ?, archived_at = ?, archive_reason = ?, replaced_by_memory_id = ?
    WHERE id = ? AND status = 'active'
  `).run(archived.updatedAt, archived.archivedAt, archived.archiveReason, archived.replacedByMemoryId, archived.id);
  return archived;
}

function rowToRecord(row: MemoryRow): MemoryRecord {
  const ownership = normalizeMemoryOwnership({
    tier: row.tier,
    ownerId: row.owner_id ?? undefined,
    sourceSessionId: row.source_session_id ?? undefined,
    sourceAgentId: row.source_agent_id ?? undefined
  });
  return {
    id: row.id,
    tier: ownership.tier,
    ownerId: ownership.ownerId,
    kind: row.kind,
    content: row.content,
    sourceSessionId: row.source_session_id,
    sourceAgentId: row.source_agent_id,
    confidence: row.confidence,
    importance: row.importance,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    validFrom: row.valid_from ?? null,
    validUntil: row.valid_until ?? null,
    expiresAt: row.expires_at ?? null,
    archivedAt: row.archived_at ?? null,
    archiveReason: row.archive_reason ?? null,
    replacedByMemoryId: row.replaced_by_memory_id ?? null
  };
}

function isComparableMemory(candidate: MemoryCandidateRecord, memory: MemoryRecord): boolean {
  return candidate.tier === memory.tier
    && candidate.kind === memory.kind
    && ownersCompatible(candidate.ownerId ?? null, memory.ownerId);
}

function memoryMatchesSearchOptions(record: MemoryRecord, options: MemorySearchOptions): boolean {
  if (options.tier && record.tier !== options.tier) {
    return false;
  }
  if (options.ownerId && record.ownerId !== options.ownerId) {
    return false;
  }
  if (options.refSessionId || options.refAgentId) {
    return record.tier === "core"
      || (record.tier === "session" && record.ownerId === options.refSessionId)
      || (record.tier === "agent" && record.ownerId === options.refAgentId);
  }
  return true;
}

function ownersCompatible(candidateOwnerId: string | null, memoryOwnerId: string | null): boolean {
  return !candidateOwnerId || !memoryOwnerId || candidateOwnerId === memoryOwnerId;
}

function classifyConflict(candidateNormalized: string, memoryNormalized: string, overlapRatio: number): MemoryConflictType | undefined {
  if (candidateNormalized === memoryNormalized || candidateNormalized.includes(memoryNormalized) || memoryNormalized.includes(candidateNormalized)) {
    return "duplicate";
  }
  if (overlapRatio >= 0.75) {
    return "overlap";
  }
  if (overlapRatio >= 0.4) {
    return "possible_conflict";
  }
  return undefined;
}
