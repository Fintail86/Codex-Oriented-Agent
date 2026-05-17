import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  memoryCandidateRecordSchema,
  memoryCandidateSchema,
  memoryScopeSchema,
  type MemoryCandidate,
  type MemoryCandidateRecord,
  type MemoryRecord,
  type MemoryScope,
  type SessionMetadata
} from "./types.js";

type AddMemoryInput = {
  scope: MemoryScope;
  content: string;
  ownerType?: string;
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

type UpdateMemoryInput = Partial<Pick<AddMemoryInput, "scope" | "content" | "ownerId" | "kind" | "confidence" | "importance">>;

type MemoryRow = {
  id: string;
  scope: MemoryScope;
  owner_type: string;
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

export type CandidateView = {
  displayId: string;
  legacy: boolean;
  record?: MemoryCandidateRecord;
  raw: Record<string, unknown>;
};

export type MemorySearchResult = {
  record: MemoryRecord;
  score: number;
  matchedTokens: string[];
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

const memoryColumnMigrations: Record<string, string> = {
  valid_from: "TEXT",
  valid_until: "TEXT",
  expires_at: "TEXT",
  archived_at: "TEXT",
  archive_reason: "TEXT",
  replaced_by_memory_id: "TEXT"
};

const conflictRank: Record<MemoryConflictType, number> = {
  duplicate: 0,
  overlap: 1,
  possible_conflict: 2
};

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
          scope TEXT NOT NULL,
          owner_type TEXT NOT NULL,
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
      const existingColumns = new Set((db.prepare("PRAGMA table_info(memories)").all() as TableColumn[]).map((column) => column.name));
      for (const [columnName, columnDefinition] of Object.entries(memoryColumnMigrations)) {
        if (!existingColumns.has(columnName)) {
          db.exec(`ALTER TABLE memories ADD COLUMN ${columnName} ${columnDefinition}`);
        }
      }
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

  search(query: string, limit = 8): MemorySearchResult[] {
    this.ensureSchema();
    const normalized = normalizeMemoryText(query);
    if (!normalized) {
      return [];
    }
    const db = this.open();
    try {
      const records = this.activeSearchableMemories(db);
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

  listMemories(limit = 20, includeAll = false): MemoryRecord[] {
    this.ensureSchema();
    const db = this.open();
    try {
      const rows = db.prepare(`
        SELECT * FROM memories
        ${includeAll ? "" : "WHERE status = 'active'"}
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(limit) as MemoryRow[];
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
      scope: input.scope ? memoryScopeSchema.parse(input.scope) : target.scope,
      ownerType: input.scope ? input.scope : target.ownerType,
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

  async writeReferenceMemory(session: SessionMetadata, userPrompt: string): Promise<MemorySearchResult[]> {
    const results = this.search(`${session.goal} ${userPrompt}`, 10);
    const sessionDir = join(this.workspaceRoot, "sessions", session.id);
    const content = results.length
      ? `# REFERENCE MEMORY\n\n${results.map((result) => formatReferenceMemoryLine(result)).join("\n")}\n`
      : "# REFERENCE MEMORY\n\nNo reference memory loaded for this request.\n";
    await writeFile(join(sessionDir, "REF_MEMORY.md"), content, "utf8");
    return results;
  }

  async appendCandidates(candidates: MemoryCandidate[] | undefined, session: SessionMetadata): Promise<void> {
    if (!candidates?.length) {
      return;
    }
    this.ensureMemoryDir();
    const lines = candidates.map((candidate) => {
      const parsed = memoryCandidateSchema.parse(candidate);
      const record: MemoryCandidateRecord = {
        id: randomUUID(),
        status: "pending",
        ...parsed,
        sourceSessionId: session.id,
        sourceAgentId: session.agentId,
        createdAt: new Date().toISOString()
      };
      return JSON.stringify(record);
    });
    await appendFile(join(this.memoryDir, "memory_candidates.jsonl"), `${lines.join("\n")}\n`, "utf8");
  }

  async listCandidates(includeAll = false): Promise<CandidateView[]> {
    const entries = await this.readCandidateEntries();
    return entries.filter((entry) => includeAll || entry.record?.status === "pending" || (entry.legacy && !includeAll));
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
    if (entry.legacy || !entry.record) {
      throw new Error(`Legacy memory candidate cannot be promoted or discarded: ${candidateId}`);
    }
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

  async countPendingCandidates(): Promise<number> {
    return (await this.listCandidates(false)).filter((candidate) => candidate.record?.status === "pending").length;
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
    this.ensureMemoryDir();
    const candidateSnapshot = this.candidateFileTextSync();
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      const output = work(db);
      entries[index] = candidateToView(output.candidate, index + 1);
      this.writeCandidateEntriesSync(entries);
      db.exec("COMMIT");
      return output.result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback errors; the original failure is more useful.
      }
      try {
        writeFileSync(this.candidatePath(), candidateSnapshot, "utf8");
      } catch {
        // Best-effort restore for the JSONL side of the transaction.
      }
      throw error;
    } finally {
      db.close();
    }
  }

  private findConflictsForCandidate(candidate: MemoryCandidateRecord): MemoryConflict[] {
    this.ensureSchema();
    const candidateNormalized = normalizeMemoryText(candidate.content);
    const candidateTokens = tokenSet(candidate.content);
    if (!candidateNormalized || !candidateTokens.size) {
      return [];
    }
    const db = this.open();
    try {
      return this.activeSearchableMemories(db)
        .flatMap((memory) => {
          if (!isComparableMemory(candidate, memory)) {
            return [];
          }
          const memoryNormalized = normalizeMemoryText(memory.content);
          const memoryTokens = tokenSet(memory.content);
          const matchedTokens = intersection([...candidateTokens], memoryTokens);
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
            candidatePreview: preview(candidate.content),
            memoryPreview: preview(memory.content)
          }];
        })
        .sort((a, b) => conflictRank[a.type] - conflictRank[b.type] || b.overlapRatio - a.overlapRatio);
    } finally {
      db.close();
    }
  }

  private async pendingCandidateRecord(candidateId: string): Promise<MemoryCandidateRecord> {
    const candidate = await this.getCandidate(candidateId);
    if (candidate.legacy || !candidate.record) {
      throw new Error(`Legacy memory candidate cannot be inspected for conflicts: ${candidateId}`);
    }
    if (candidate.record.status !== "pending") {
      throw new Error(`Memory candidate is not pending: ${candidateId}`);
    }
    return candidate.record;
  }

  private activeSearchableMemories(db: DatabaseSync): MemoryRecord[] {
    const now = new Date().toISOString();
    const rows = db.prepare(`
      SELECT * FROM memories
      WHERE status = 'active'
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY updated_at DESC
    `).all(now) as MemoryRow[];
    return rows.map(rowToRecord);
  }

  private resolveMemory(memoryId: string, includeAll: boolean): MemoryRecord {
    const normalized = memoryId.trim();
    if (!normalized) {
      throw new Error("Memory id is required.");
    }
    const records = this.listMemories(Number.MAX_SAFE_INTEGER, includeAll);
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
    if (entry.legacy || !entry.record) {
      throw new Error(`Legacy memory candidate cannot be promoted or discarded: ${candidateId}`);
    }
    entries[index] = candidateToView(update(entry.record), index + 1);
    await this.writeCandidateEntries(entries);
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
    this.ensureMemoryDir();
    const path = this.candidatePath();
    if (!existsSync(path)) {
      await writeFile(path, "", "utf8");
      return [];
    }
    const text = await readFile(path, "utf8");
    const entries: CandidateView[] = [];
    text.split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      const lineNumber = index + 1;
      const raw = JSON.parse(trimmed) as Record<string, unknown>;
      const parsed = memoryCandidateRecordSchema.safeParse(raw);
      if (parsed.success) {
        entries.push(candidateToView(parsed.data, lineNumber));
      } else {
        entries.push({
          displayId: `line:${lineNumber}`,
          legacy: true,
          raw
        });
      }
    });
    return entries;
  }

  private async writeCandidateEntries(entries: CandidateView[]): Promise<void> {
    this.ensureMemoryDir();
    await writeFile(this.candidatePath(), serializeCandidateEntries(entries), "utf8");
  }

  private writeCandidateEntriesSync(entries: CandidateView[]): void {
    this.ensureMemoryDir();
    writeFileSync(this.candidatePath(), serializeCandidateEntries(entries), "utf8");
  }

  private candidateFileTextSync(): string {
    const path = this.candidatePath();
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  private ensureMemoryDir(): void {
    if (!existsSync(this.memoryDir)) {
      mkdirSync(this.memoryDir, { recursive: true });
    }
  }

  private candidatePath(): string {
    return join(this.memoryDir, "memory_candidates.jsonl");
  }

  private open(): DatabaseSync {
    return new DatabaseSync(this.dbPath);
  }
}

export function calculateMemoryScore(query: string, record: MemoryRecord): MemorySearchResult {
  const normalizedQuery = normalizeMemoryText(query);
  const queryTokens = tokenSet(query);
  const haystack = normalizeMemoryText(`${record.content} ${record.kind} ${record.scope} ${record.ownerId ?? ""}`);
  const matchedTokens = intersection([...queryTokens], tokenSet(haystack));
  const exactPhrase = Boolean(normalizedQuery && haystack.includes(normalizedQuery));
  const relevant = exactPhrase || matchedTokens.length > 0;
  if (!relevant) {
    return { record, score: 0, matchedTokens: [] };
  }

  let score = 0;
  if (exactPhrase) {
    score += 6;
  }
  score += matchedTokens.length * 2;
  score += record.importance;
  score += record.confidence * 2;
  score += recencyScore(record.updatedAt);

  return {
    record,
    score: Number(score.toFixed(2)),
    matchedTokens
  };
}

export function normalizeMemoryText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function formatMemoryConflicts(candidate: MemoryCandidateRecord, conflicts: MemoryConflict[]): string {
  if (!conflicts.length) {
    return `No memory conflicts for candidate ${candidate.id}.`;
  }
  const lines = [
    `Candidate: ${candidate.id}`,
    `Scope: ${candidate.scope}/${candidate.kind}`,
    `Content: ${preview(candidate.content)}`,
    `Conflicts: ${conflicts.length}`,
    ""
  ];
  conflicts.forEach((conflict, index) => {
    lines.push(`${index + 1}. ${conflict.type}  memory:${conflict.memory.id.slice(0, 8)}  ${conflict.memory.scope}/${conflict.memory.kind}`);
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

function candidateToView(record: MemoryCandidateRecord, lineNumber: number): CandidateView {
  return {
    displayId: record.id || `line:${lineNumber}`,
    legacy: false,
    record,
    raw: record
  };
}

function candidateToMemoryInput(candidate: MemoryCandidateRecord): AddMemoryInput {
  return {
    scope: candidate.scope,
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
  const scope = memoryScopeSchema.parse(input.scope);
  const now = new Date().toISOString();
  const record: MemoryRecord = {
    id: randomUUID(),
    scope,
    ownerType: input.ownerType ?? scope,
    ownerId: input.ownerId ?? null,
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
      id, scope, owner_type, owner_id, kind, content, source_session_id, source_agent_id,
      confidence, importance, status, created_at, updated_at, last_accessed_at,
      valid_from, valid_until, expires_at, archived_at, archive_reason, replaced_by_memory_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.scope,
    record.ownerType,
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
    SET scope = ?, owner_type = ?, owner_id = ?, kind = ?, content = ?,
      confidence = ?, importance = ?, updated_at = ?
    WHERE id = ? AND status = 'active'
  `).run(
    record.scope,
    record.ownerType,
    record.ownerId,
    record.kind,
    record.content,
    record.confidence,
    record.importance,
    record.updatedAt,
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
  return {
    id: row.id,
    scope: row.scope,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
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

function tokenSet(value: string): Set<string> {
  const normalized = normalizeMemoryText(value);
  if (!normalized) {
    return new Set();
  }
  return new Set(normalized.split(" ").filter((token) => token.length >= 2));
}

function intersection(tokens: string[], target: Set<string>): string[] {
  return [...new Set(tokens)].filter((token) => target.has(token));
}

function recencyScore(updatedAt: string): number {
  const ageMs = Date.now() - Date.parse(updatedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return 1.5;
  }
  const ageDays = ageMs / 86_400_000;
  if (ageDays <= 7) {
    return 1.5;
  }
  if (ageDays <= 30) {
    return 1;
  }
  if (ageDays <= 90) {
    return 0.5;
  }
  return 0;
}

function formatReferenceMemoryLine(result: MemorySearchResult): string {
  const record = result.record;
  return `- [mem:${record.id.slice(0, 8)} score:${result.score.toFixed(2)} ${record.scope}/${record.kind}] ${record.content}`;
}

function isComparableMemory(candidate: MemoryCandidateRecord, memory: MemoryRecord): boolean {
  return candidate.scope === memory.scope
    && candidate.kind === memory.kind
    && ownersCompatible(candidate.ownerId ?? null, memory.ownerId);
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

function preview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

function serializeCandidateEntries(entries: CandidateView[]): string {
  const lines = entries.map((entry) => JSON.stringify(entry.record ?? entry.raw));
  return lines.length ? `${lines.join("\n")}\n` : "";
}
