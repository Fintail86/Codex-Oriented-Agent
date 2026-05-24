import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readText, resolveInside, writeText } from "./fs_utils.js";
import { PolicyManager, type PolicyConfig } from "./policy_manager.js";

export type CodexAmendmentStatus =
  | "pending"
  | "applied"
  | "rejected"
  | "cancelled"
  | "stale"
  | "failed";

export type CodexAmendment = {
  id: string;
  targetPath: string;
  previousHash: string;
  proposedHash: string;
  proposedContent: string;
  reason: string;
  status: CodexAmendmentStatus;
  sourceSessionId?: string;
  sourceAgentId?: string;
  sourceRunId?: string;
  sourceChannel: "cli" | "repl" | "gateway";
  createdAt: string;
  appliedAt?: string;
  rejectedAt?: string;
  cancelledAt?: string;
  failureReason?: string;
};

export type CreateCodexAmendmentInput = {
  targetPath: string;
  proposedContent: string;
  reason: string;
  sourceSessionId?: string;
  sourceAgentId?: string;
  sourceRunId?: string;
  sourceChannel: "cli" | "repl" | "gateway";
  now?: Date;
};

export type CodexCheckSummary = {
  protectedSources: Array<{ path: string; exists: boolean }>;
  protectedMirrors: Array<{ path: string; exists: boolean }>;
  policyMirrorOk: boolean;
  pendingCount: number;
  stalePendingCount: number;
};

type CodexAmendmentRow = {
  id: string;
  target_path: string;
  previous_hash: string;
  proposed_hash: string;
  proposed_content: string;
  reason: string;
  status: CodexAmendmentStatus;
  source_session_id: string | null;
  source_agent_id: string | null;
  source_run_id: string | null;
  source_channel: "cli" | "repl" | "gateway";
  created_at: string;
  applied_at: string | null;
  rejected_at: string | null;
  cancelled_at: string | null;
  failure_reason: string | null;
};

const strictSecretPatterns: Array<{ reason: string; pattern: RegExp }> = [
  { reason: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { reason: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { reason: "jwt-token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { reason: "assignment:password", pattern: /\bpassword\s*[:=]\s*["']?[^"'\s]{4,}/gi },
  { reason: "assignment:token", pattern: /\btoken\s*[:=]\s*["']?[^"'\s]{12,}/gi },
  { reason: "assignment:api-key", pattern: /\bapi[_ -]?key\s*[:=]\s*["']?[^"'\s]{12,}/gi },
  { reason: "assignment:secret", pattern: /\bsecret\s*[:=]\s*["']?[^"'\s]{12,}/gi },
  { reason: "pem-private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g },
  { reason: "bearer-token", pattern: /\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi }
];

export class CodexAmendmentLedger {
  private readonly dbPath: string;

  constructor(private readonly workspaceRoot: string) {
    this.dbPath = join(workspaceRoot, "memory", "longterm.sqlite");
  }

  async propose(input: CreateCodexAmendmentInput): Promise<CodexAmendment> {
    const policy = await new PolicyManager(this.workspaceRoot).loadPolicy();
    if (!policy.codex.amendment.canPropose) {
      throw new Error("Codex amendment proposals are disabled by policy.");
    }
    const targetPath = this.normalizeTargetPath(policy, input.targetPath);
    const secret = detectStrictSecrets(input.proposedContent);
    if (secret.matched) {
      throw new Error(`Codex amendment content appears to contain secret-like values: ${secret.reasons.join(", ")}`);
    }
    const existing = await readText(resolveInside(this.workspaceRoot, targetPath));
    const now = input.now ?? new Date();
    const amendment: CodexAmendment = {
      id: `amend_${randomUUID().slice(0, 8)}`,
      targetPath,
      previousHash: hashText(existing),
      proposedHash: hashText(input.proposedContent),
      proposedContent: input.proposedContent,
      reason: input.reason.trim(),
      status: "pending",
      sourceSessionId: input.sourceSessionId,
      sourceAgentId: input.sourceAgentId,
      sourceRunId: input.sourceRunId,
      sourceChannel: input.sourceChannel,
      createdAt: now.toISOString()
    };
    if (!amendment.reason) {
      throw new Error("Codex amendment reason is required.");
    }
    this.withDb((db) => insertAmendment(db, amendment));
    return amendment;
  }

  get(id: string): CodexAmendment | undefined {
    return this.withDb((db) => selectAmendment(db, id));
  }

  list(options: { all?: boolean } = {}): CodexAmendment[] {
    return this.withDb((db) => {
      const rows = options.all
        ? db.prepare("SELECT * FROM codex_amendments ORDER BY created_at DESC").all()
        : db.prepare("SELECT * FROM codex_amendments WHERE status = 'pending' ORDER BY created_at DESC").all();
      return rows.map((row) => rowToAmendment(row as CodexAmendmentRow));
    });
  }

  async apply(id: string, options: { now?: Date } = {}): Promise<CodexAmendment> {
    const current = this.required(id);
    if (current.status !== "pending") {
      throw new Error(`Codex amendment is not pending: ${current.status}`);
    }
    const resolved = resolveInside(this.workspaceRoot, current.targetPath);
    const existing = await readText(resolved);
    if (hashText(existing) !== current.previousHash) {
      const stale = {
        ...current,
        status: "stale" as const,
        failureReason: "Target file changed after amendment preview."
      };
      this.withDb((db) => updateAmendment(db, stale));
      throw new Error("Codex amendment is stale. The target file changed after preview.");
    }
    await writeText(resolved, current.proposedContent);
    if (normalizeRelativePath(current.targetPath) === "codex/policy.json") {
      await new PolicyManager(this.workspaceRoot).syncMarkdown();
    }
    const applied = {
      ...current,
      status: "applied" as const,
      appliedAt: (options.now ?? new Date()).toISOString()
    };
    this.withDb((db) => updateAmendment(db, applied));
    return applied;
  }

  reject(id: string, reason: string): CodexAmendment {
    const current = this.required(id);
    if (current.status !== "pending") {
      throw new Error(`Codex amendment is not pending: ${current.status}`);
    }
    const rejected = {
      ...current,
      status: "rejected" as const,
      rejectedAt: new Date().toISOString(),
      failureReason: reason.trim() || "Rejected by user."
    };
    this.withDb((db) => updateAmendment(db, rejected));
    return rejected;
  }

  cancel(id: string, reason: string): CodexAmendment {
    const current = this.required(id);
    if (current.status !== "pending") {
      throw new Error(`Codex amendment is not pending: ${current.status}`);
    }
    const cancelled = {
      ...current,
      status: "cancelled" as const,
      cancelledAt: new Date().toISOString(),
      failureReason: reason.trim() || "Cancelled by user."
    };
    this.withDb((db) => updateAmendment(db, cancelled));
    return cancelled;
  }

  async check(): Promise<CodexCheckSummary> {
    const policyManager = new PolicyManager(this.workspaceRoot);
    const policy = await policyManager.loadPolicy();
    const policyCheck = await policyManager.checkPolicy(false, false);
    const protectedSources = await Promise.all(policy.codex.protectedSourcePaths.map(async (path) => ({
      path,
      exists: await fileExists(resolveInside(this.workspaceRoot, path))
    })));
    const protectedMirrors = await Promise.all(policy.codex.protectedMirrorPaths.map(async (path) => ({
      path,
      exists: await fileExists(resolveInside(this.workspaceRoot, path))
    })));
    const pending = this.list();
    const stalePending = await stalePendingAmendments(this.workspaceRoot, pending);
    return {
      protectedSources,
      protectedMirrors,
      policyMirrorOk: policyCheck.markdownExists && policyCheck.markdownMatches,
      pendingCount: pending.length,
      stalePendingCount: stalePending.length
    };
  }

  async readProtectedFile(path?: string): Promise<string> {
    const policy = await new PolicyManager(this.workspaceRoot).loadPolicy();
    const target = path ? this.normalizeTargetPath(policy, path, { allowMirror: true }) : undefined;
    if (!target) {
      return formatCodexProtectedPaths(policy);
    }
    return readText(resolveInside(this.workspaceRoot, target));
  }

  private required(id: string): CodexAmendment {
    const current = this.get(id);
    if (!current) {
      throw new Error(`Codex amendment not found: ${id}`);
    }
    return current;
  }

  private normalizeTargetPath(policy: PolicyConfig, inputPath: string, options: { allowMirror?: boolean } = {}): string {
    const resolved = resolveInside(this.workspaceRoot, inputPath);
    const relativePath = normalizeRelativePath(relative(this.workspaceRoot, resolved));
    const sources = policy.codex.protectedSourcePaths.map(normalizeRelativePath);
    const mirrors = policy.codex.protectedMirrorPaths.map(normalizeRelativePath);
    if (sources.includes(relativePath)) {
      return policy.codex.protectedSourcePaths[sources.indexOf(relativePath)].replace(/\\/g, "/");
    }
    if (mirrors.includes(relativePath)) {
      if (options.allowMirror) {
        return policy.codex.protectedMirrorPaths[mirrors.indexOf(relativePath)].replace(/\\/g, "/");
      }
      throw new Error(`Generated Codex mirror cannot be amended directly: ${relativePath}. Amend codex/POLICY.json and sync the mirror.`);
    }
    throw new Error(`Path is not a protected Codex source path: ${relativePath}`);
  }

  private withDb<T>(work: (db: DatabaseSync) => T): T {
    mkdirSync(join(this.workspaceRoot, "memory"), { recursive: true });
    const db = new DatabaseSync(this.dbPath);
    try {
      ensureCodexAmendmentTable(db);
      return work(db);
    } finally {
      db.close();
    }
  }
}

export function formatCodexAmendmentPreview(amendment: CodexAmendment): string {
  return [
    "[PREVIEW] Codex amendment requires approval.",
    `Amendment: ${amendment.id}`,
    `Status: ${amendment.status}`,
    `Path: ${amendment.targetPath}`,
    `Existing hash: ${amendment.previousHash.slice(0, 16)}`,
    `Proposed hash: ${amendment.proposedHash.slice(0, 16)}`,
    `New content chars: ${amendment.proposedContent.length}`,
    `Reason: ${amendment.reason}`,
    `Preview: ${redactedContentPreview(amendment.proposedContent)}`,
    "",
    `Run: cosia codex amendment apply ${amendment.id} --yes`,
    "Or in REPL/Telegram, run #적용 or /apply for the concrete pending preview.",
    "",
    "The Codex file has not been changed yet."
  ].join("\n");
}

export function formatCodexAmendmentApplied(amendment: CodexAmendment): string {
  return [
    "[SUCCESS] Codex amendment applied.",
    `Amendment: ${amendment.id}`,
    `Path: ${amendment.targetPath}`,
    amendment.targetPath === "codex/POLICY.json" ? "Mirror: codex/POLICY.md synced from POLICY.json" : undefined
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function formatCodexAmendmentList(amendments: CodexAmendment[]): string {
  if (!amendments.length) {
    return "No Codex amendments.";
  }
  return amendments
    .map((item) => `${item.id}\t${item.status}\t${item.targetPath}\t${item.createdAt}\t${item.reason}`)
    .join("\n");
}

export function formatCodexAmendmentDetail(amendment: CodexAmendment): string {
  return [
    `Codex amendment: ${amendment.id}`,
    `Status: ${amendment.status}`,
    `Path: ${amendment.targetPath}`,
    `Created: ${amendment.createdAt}`,
    amendment.appliedAt ? `Applied: ${amendment.appliedAt}` : undefined,
    amendment.rejectedAt ? `Rejected: ${amendment.rejectedAt}` : undefined,
    amendment.cancelledAt ? `Cancelled: ${amendment.cancelledAt}` : undefined,
    `Previous hash: ${amendment.previousHash}`,
    `Proposed hash: ${amendment.proposedHash}`,
    `Reason: ${amendment.reason}`,
    amendment.failureReason ? `Failure reason: ${amendment.failureReason}` : undefined,
    "",
    `Proposed content preview:\n${redactedContentPreview(amendment.proposedContent, 2000)}`
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function formatCodexCheck(summary: CodexCheckSummary): string {
  return [
    "Codex law check",
    "",
    "Protected source files:",
    ...summary.protectedSources.map((item) => `- ${item.path}: ${item.exists ? "ok" : "missing"}`),
    "",
    "Protected generated mirrors:",
    ...summary.protectedMirrors.map((item) => `- ${item.path}: ${item.exists ? "ok" : "missing"}`),
    "",
    `Policy mirror: ${summary.policyMirrorOk ? "ok" : "stale or missing"}`,
    `Pending amendments: ${summary.pendingCount}`,
    `Stale pending amendments: ${summary.stalePendingCount}`
  ].join("\n");
}

function ensureCodexAmendmentTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_amendments (
      id TEXT PRIMARY KEY,
      target_path TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      proposed_hash TEXT NOT NULL,
      proposed_content TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      source_session_id TEXT,
      source_agent_id TEXT,
      source_run_id TEXT,
      source_channel TEXT NOT NULL,
      created_at TEXT NOT NULL,
      applied_at TEXT,
      rejected_at TEXT,
      cancelled_at TEXT,
      failure_reason TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_codex_amendments_status ON codex_amendments(status);
  `);
}

function insertAmendment(db: DatabaseSync, amendment: CodexAmendment): void {
  ensureCodexAmendmentTable(db);
  db.prepare(`
    INSERT INTO codex_amendments (
      id, target_path, previous_hash, proposed_hash, proposed_content, reason, status,
      source_session_id, source_agent_id, source_run_id, source_channel, created_at,
      applied_at, rejected_at, cancelled_at, failure_reason, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(...amendmentValues(amendment), new Date().toISOString());
}

function updateAmendment(db: DatabaseSync, amendment: CodexAmendment): void {
  db.prepare(`
    UPDATE codex_amendments SET
      target_path = ?,
      previous_hash = ?,
      proposed_hash = ?,
      proposed_content = ?,
      reason = ?,
      status = ?,
      source_session_id = ?,
      source_agent_id = ?,
      source_run_id = ?,
      source_channel = ?,
      created_at = ?,
      applied_at = ?,
      rejected_at = ?,
      cancelled_at = ?,
      failure_reason = ?,
      updated_at = ?
    WHERE id = ?
  `).run(...amendmentValues(amendment).slice(1), new Date().toISOString(), amendment.id);
}

function amendmentValues(amendment: CodexAmendment): Array<string | null> {
  return [
    amendment.id,
    amendment.targetPath,
    amendment.previousHash,
    amendment.proposedHash,
    amendment.proposedContent,
    amendment.reason,
    amendment.status,
    amendment.sourceSessionId ?? null,
    amendment.sourceAgentId ?? null,
    amendment.sourceRunId ?? null,
    amendment.sourceChannel,
    amendment.createdAt,
    amendment.appliedAt ?? null,
    amendment.rejectedAt ?? null,
    amendment.cancelledAt ?? null,
    amendment.failureReason ?? null
  ];
}

function selectAmendment(db: DatabaseSync, id: string): CodexAmendment | undefined {
  const row = db.prepare("SELECT * FROM codex_amendments WHERE id = ?").get(id) as CodexAmendmentRow | undefined;
  return row ? rowToAmendment(row) : undefined;
}

function rowToAmendment(row: CodexAmendmentRow): CodexAmendment {
  return {
    id: row.id,
    targetPath: row.target_path,
    previousHash: row.previous_hash,
    proposedHash: row.proposed_hash,
    proposedContent: row.proposed_content,
    reason: row.reason,
    status: row.status,
    sourceSessionId: row.source_session_id ?? undefined,
    sourceAgentId: row.source_agent_id ?? undefined,
    sourceRunId: row.source_run_id ?? undefined,
    sourceChannel: row.source_channel,
    createdAt: row.created_at,
    appliedAt: row.applied_at ?? undefined,
    rejectedAt: row.rejected_at ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
    failureReason: row.failure_reason ?? undefined
  };
}

async function stalePendingAmendments(workspaceRoot: string, amendments: CodexAmendment[]): Promise<CodexAmendment[]> {
  const stale: CodexAmendment[] = [];
  for (const amendment of amendments) {
    try {
      const current = await readText(resolveInside(workspaceRoot, amendment.targetPath));
      if (hashText(current) !== amendment.previousHash) {
        stale.push(amendment);
      }
    } catch {
      stale.push(amendment);
    }
  }
  return stale;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function formatCodexProtectedPaths(policy: PolicyConfig): string {
  return [
    "Codex protected files",
    "",
    "Protected source files:",
    ...policy.codex.protectedSourcePaths.map((path) => `- ${path}`),
    "",
    "Generated mirrors:",
    ...policy.codex.protectedMirrorPaths.map((path) => `- ${path}`)
  ].join("\n");
}

function detectStrictSecrets(content: string): { matched: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const { reason, pattern } of strictSecretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) {
      reasons.push(reason);
    }
  }
  return {
    matched: reasons.length > 0,
    reasons: [...new Set(reasons)]
  };
}

function redactedContentPreview(content: string, maxChars = 500): string {
  let redacted = content;
  for (const { pattern } of strictSecretPatterns) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  const normalized = redacted.trim() || "(empty)";
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 3)}...` : normalized;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}
