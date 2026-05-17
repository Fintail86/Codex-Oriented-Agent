import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { memoryCandidateSchema, memoryScopeSchema, type MemoryCandidate, type MemoryRecord, type MemoryScope, type SessionMetadata } from "./types.js";

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
    const lines = candidates.map((candidate) => {
      const parsed = memoryCandidateSchema.parse(candidate);
      return JSON.stringify({
        ...parsed,
        sourceSessionId: session.id,
        sourceAgentId: session.agentId,
        createdAt: new Date().toISOString()
      });
    });
    await appendFile(join(this.memoryDir, "memory_candidates.jsonl"), `${lines.join("\n")}\n`, "utf8");
  }

  private open(): DatabaseSync {
    return new DatabaseSync(this.dbPath);
  }
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
