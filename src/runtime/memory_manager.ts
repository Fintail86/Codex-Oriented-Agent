import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
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
};

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
};

export type CandidateView = {
  displayId: string;
  legacy: boolean;
  record?: MemoryCandidateRecord;
  raw: Record<string, unknown>;
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
          expires_at TEXT
        );
      `);
    } finally {
      db.close();
    }
  }

  addMemory(input: AddMemoryInput): MemoryRecord {
    this.ensureSchema();
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
      lastAccessedAt: null
    };
    const db = this.open();
    try {
      db.prepare(`
        INSERT INTO memories (
          id, scope, owner_type, owner_id, kind, content, source_session_id, source_agent_id,
          confidence, importance, status, created_at, updated_at, last_accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        record.lastAccessedAt
      );
      return record;
    } finally {
      db.close();
    }
  }

  search(query: string, limit = 8): MemoryRecord[] {
    this.ensureSchema();
    const normalized = query.trim();
    if (!normalized) {
      return [];
    }
    const tokens = [...new Set(normalized.split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length >= 2))].slice(0, 8);
    if (!tokens.length) {
      return [];
    }
    const clauses = tokens.map(() => "(content LIKE ? OR kind LIKE ? OR scope LIKE ? OR owner_id LIKE ?)").join(" OR ");
    const params = tokens.flatMap((token) => {
      const like = `%${token}%`;
      return [like, like, like, like];
    });
    const db = this.open();
    try {
      const rows = db.prepare(`
        SELECT * FROM memories
        WHERE status = 'active'
          AND (${clauses})
        ORDER BY importance DESC, updated_at DESC
        LIMIT ?
      `).all(...params, limit) as MemoryRow[];
      const now = new Date().toISOString();
      for (const row of rows) {
        db.prepare("UPDATE memories SET last_accessed_at = ? WHERE id = ?").run(now, row.id);
      }
      return rows.map(rowToRecord);
    } finally {
      db.close();
    }
  }

  listMemories(limit = 20): MemoryRecord[] {
    this.ensureSchema();
    const db = this.open();
    try {
      const rows = db.prepare(`
        SELECT * FROM memories
        WHERE status = 'active'
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(limit) as MemoryRow[];
      return rows.map(rowToRecord);
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

  async writeReferenceMemory(session: SessionMetadata, userPrompt: string): Promise<MemoryRecord[]> {
    const records = this.search(`${session.goal} ${userPrompt}`, 10);
    const sessionDir = join(this.workspaceRoot, "sessions", session.id);
    const content = records.length
      ? `# REFERENCE MEMORY\n\n${records.map((record) => `- [${record.scope}/${record.kind}] ${record.content}`).join("\n")}\n`
      : "# REFERENCE MEMORY\n\nNo reference memory loaded for this request.\n";
    await writeFile(join(sessionDir, "REF_MEMORY.md"), content, "utf8");
    return records;
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
    const found = entries.find((entry) => entry.displayId === candidateId);
    if (!found) {
      throw new Error(`Memory candidate not found: ${candidateId}`);
    }
    return found;
  }

  async promoteCandidate(candidateId: string): Promise<MemoryRecord> {
    let promoted: MemoryRecord | undefined;
    await this.updateCandidate(candidateId, (record) => {
      if (record.status !== "pending") {
        throw new Error(`Memory candidate is not pending: ${candidateId}`);
      }
      promoted = this.addMemory({
        scope: record.scope,
        content: record.content,
        ownerId: record.ownerId,
        kind: record.kind,
        sourceSessionId: record.sourceSessionId,
        sourceAgentId: record.sourceAgentId,
        confidence: record.confidence,
        importance: record.importance
      });
      return {
        ...record,
        status: "promoted",
        reviewedAt: new Date().toISOString(),
        promotedMemoryId: promoted.id
      };
    });
    if (!promoted) {
      throw new Error(`Memory candidate could not be promoted: ${candidateId}`);
    }
    return promoted;
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

  private async updateCandidate(
    candidateId: string,
    update: (record: MemoryCandidateRecord) => MemoryCandidateRecord
  ): Promise<void> {
    const entries = await this.readCandidateEntries();
    const index = entries.findIndex((entry) => entry.displayId === candidateId);
    if (index === -1) {
      throw new Error(`Memory candidate not found: ${candidateId}`);
    }
    const entry = entries[index];
    if (entry.legacy || !entry.record) {
      throw new Error(`Legacy memory candidate cannot be promoted or discarded: ${candidateId}`);
    }
    entries[index] = candidateToView(update(entry.record), index + 1);
    await this.writeCandidateEntries(entries);
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
    const lines = entries.map((entry) => JSON.stringify(entry.record ?? entry.raw));
    await writeFile(this.candidatePath(), lines.length ? `${lines.join("\n")}\n` : "", "utf8");
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

function candidateToView(record: MemoryCandidateRecord, lineNumber: number): CandidateView {
  return {
    displayId: record.id || `line:${lineNumber}`,
    legacy: false,
    record,
    raw: record
  };
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
    lastAccessedAt: row.last_accessed_at
  };
}
