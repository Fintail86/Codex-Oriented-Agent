import { exec } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { summarizePolicyArgs } from "./policy_audit.js";
import { resolveInside } from "./fs_utils.js";

export const shellApprovalRiskSchema = z.enum(["low", "medium", "high"]);
export type ShellApprovalRisk = z.infer<typeof shellApprovalRiskSchema>;

export const shellApprovalStatusSchema = z.enum([
  "pending",
  "running",
  "applied",
  "expired",
  "cancelled",
  "rejected",
  "failed"
]);
export type ShellApprovalStatus = z.infer<typeof shellApprovalStatusSchema>;

export type ShellFailureKind =
  | "spawn_failed"
  | "timeout"
  | "non_zero_exit"
  | "output_handling_failed";

export type ShellApproval = {
  id: string;
  command: string;
  commandHash: string;
  cwd: string;
  cwdHash: string;
  reason: string;
  expectedEffect: string;
  risk: ShellApprovalRisk;
  blocked: boolean;
  warnings: string[];
  createdAt: string;
  expiresAt: string;
  runningAt?: string;
  appliedAt?: string;
  failedAt?: string;
  failureReason?: string;
  failureKind?: ShellFailureKind;
  exitCode?: number;
  durationMs?: number;
  sourceSessionId?: string;
  sourceAgentId?: string;
  sourceRunId?: string;
  sourceCapabilityId?: string;
  sourceChannel: "cli" | "repl" | "gateway";
  status: ShellApprovalStatus;
};

export type ShellRiskAssessment = {
  risk: ShellApprovalRisk;
  blocked: boolean;
  warnings: string[];
};

export type CreateShellApprovalInput = {
  command: string;
  cwd?: string;
  reason: string;
  expectedEffect?: string;
  sourceSessionId?: string;
  sourceAgentId?: string;
  sourceRunId?: string;
  sourceCapabilityId?: string;
  sourceChannel: "cli" | "repl" | "gateway";
  now?: Date;
  ttlMs?: number;
};

export type ShellExecutionResult = {
  approval: ShellApproval;
  ok: boolean;
  content: string;
};

export type ShellApprovalDb = DatabaseSync;

const defaultTtlMs = 5 * 60 * 1000;
const defaultTimeoutMs = 30_000;
const outputMaxChars = 12_000;
const staleRunningMs = 10 * 60 * 1000;
const envAllowlist = new Set(["PATH", "SYSTEMROOT", "WINDIR", "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE"]);

export class ShellApprovalLedger {
  private readonly dbPath: string;

  constructor(private readonly workspaceRoot: string) {
    this.dbPath = join(workspaceRoot, "memory", "longterm.sqlite");
  }

  create(input: CreateShellApprovalInput): ShellApproval {
    const approval = buildShellApprovalRecord(this.workspaceRoot, input);
    this.withDb((db) => {
      insertShellApproval(db, approval);
    });
    return approval;
  }

  get(id: string): ShellApproval | undefined {
    return this.withDb((db) => selectShellApproval(db, id));
  }

  list(options: { status?: ShellApprovalStatus } = {}): ShellApproval[] {
    return this.withDb((db) => {
      const rows = options.status
        ? db.prepare("SELECT * FROM shell_approvals WHERE status = ? ORDER BY created_at DESC").all(options.status)
        : db.prepare("SELECT * FROM shell_approvals ORDER BY created_at DESC").all();
      return rows.map((row) => rowToApproval(row as ShellApprovalRow));
    });
  }

  cancel(id: string, reason = "Cancelled by user."): ShellApproval {
    return this.withDb((db) => {
      const current = selectShellApproval(db, id);
      if (!current) {
        throw new Error(`Shell approval not found: ${id}`);
      }
      if (current.status !== "pending") {
        throw new Error(`Shell approval is not pending: ${id}`);
      }
      const next = { ...current, status: "cancelled" as const, failureReason: reason.trim() || "Cancelled by user." };
      updateShellApproval(db, next);
      return next;
    });
  }

  async apply(id: string, options: { confirm?: string; now?: Date } = {}): Promise<ShellExecutionResult> {
    const now = options.now ?? new Date();
    const current = this.get(id);
    if (!current) {
      throw new Error(`Shell approval not found: ${id}`);
    }
    if (current.blocked) {
      const rejected = { ...current, status: "rejected" as const, failureReason: "Command is blocked by shell risk policy." };
      this.withDb((db) => updateShellApproval(db, rejected));
      return { approval: rejected, ok: false, content: formatShellExecutionBlocked(rejected) };
    }
    if (current.risk === "high" && options.confirm !== current.id) {
      return {
        approval: current,
        ok: false,
        content: [
          "[BLOCKED] High-risk shell approval requires an approval-id-bound confirmation phrase.",
          `Confirm phrase: ${current.id}`
        ].join("\n")
      };
    }
    const runningAt = now.toISOString();
    const consumed = this.withDb((db) => {
      expireApprovalIfNeeded(db, current.id, now);
      const result = db.prepare(`
        UPDATE shell_approvals
        SET status = 'running', running_at = ?, updated_at = ?
        WHERE id = ?
          AND status = 'pending'
          AND command_hash = ?
          AND cwd_hash = ?
          AND expires_at > ?
          AND blocked = 0
      `).run(runningAt, runningAt, current.id, current.commandHash, current.cwdHash, runningAt);
      return result.changes === 1;
    });
    if (!consumed) {
      const latest = this.get(id) ?? current;
      return { approval: latest, ok: false, content: `[BLOCKED] Shell approval is not executable: ${latest.status}` };
    }
    this.withDb((db) => updateShellApproval(db, { ...current, status: "running", runningAt }));

    const started = Date.now();
    try {
      const executed = await executeApprovedShell(current.command, current.cwd);
      const durationMs = Date.now() - started;
      const next: ShellApproval = executed.exitCode === 0
        ? {
          ...current,
          status: "applied",
          runningAt,
          appliedAt: new Date().toISOString(),
          exitCode: 0,
          durationMs
        }
        : {
          ...current,
          status: "failed",
          runningAt,
          failedAt: new Date().toISOString(),
          failureKind: executed.failureKind ?? "non_zero_exit",
          failureReason: executed.failureReason ?? `Execution completed with non-zero exit code: ${executed.exitCode}`,
          exitCode: executed.exitCode,
          durationMs
        };
      this.withDb((db) => updateShellApproval(db, next));
      return {
        approval: next,
        ok: next.status === "applied",
        content: formatShellExecutionResult(next, executed.outputSummary)
      };
    } catch (error) {
      const durationMs = Date.now() - started;
      const failed: ShellApproval = {
        ...current,
        status: "failed",
        runningAt,
        failedAt: new Date().toISOString(),
        failureKind: "output_handling_failed",
        failureReason: redactShellText((error as Error).message),
        durationMs
      };
      this.withDb((db) => updateShellApproval(db, failed));
      return { approval: failed, ok: false, content: formatShellExecutionResult(failed, "") };
    }
  }

  staleRunning(now = new Date()): ShellApproval[] {
    const cutoff = now.getTime() - staleRunningMs;
    return this.list({ status: "running" }).filter((approval) => Date.parse(approval.runningAt ?? approval.createdAt) < cutoff);
  }

  private withDb<T>(work: (db: DatabaseSync) => T): T {
    mkdirSync(join(this.workspaceRoot, "memory"), { recursive: true });
    const db = new DatabaseSync(this.dbPath);
    try {
      ensureShellApprovalTable(db);
      return work(db);
    } finally {
      db.close();
    }
  }
}

export function ensureShellApprovalStorage(db: DatabaseSync): void {
  ensureShellApprovalTable(db);
}

export function insertShellApprovalRecord(db: DatabaseSync, approval: ShellApproval): void {
  insertShellApproval(db, approval);
}

export function assessShellRisk(command: string): ShellRiskAssessment {
  const warnings: string[] = [];
  let risk: ShellApprovalRisk = "low";
  let blocked = false;
  const normalized = normalizeCommand(command);

  if (hasChainOperator(command)) {
    risk = "high";
    warnings.push("Command contains shell chaining, pipe, or separator operators. Prefer separate approvals.");
  }
  const block = (message: string) => {
    blocked = true;
    risk = "high";
    warnings.push(message);
  };
  if (containsSecretLike(command)) block("Blocked secret-like command text.");
  if (/\bcurl\b[\s\S]*\|[\s\S]*\b(?:sh|bash)\b/.test(normalized)) block("Blocked curl-to-shell pattern.");
  if (/\b(?:iwr|irm|invoke-webrequest)\b[\s\S]*\|[\s\S]*\biex\b/.test(normalized)) block("Blocked PowerShell download-execute pattern.");
  if (/\brm\s+-[a-z]*r[a-z]*f[a-z]*\b/.test(normalized) || /\brm\s+-[a-z]*f[a-z]*r[a-z]*\b/.test(normalized)) block("Blocked recursive force removal.");
  if (/\bremove-item\b[\s\S]*-recurse[\s\S]*-force/.test(normalized) || /\bremove-item\b[\s\S]*-force[\s\S]*-recurse/.test(normalized)) block("Blocked PowerShell recursive force removal.");
  if (/\brd\s+\/s\s+\/q\b/.test(normalized)) block("Blocked recursive directory deletion.");
  if (/\bdel\s+\/s\b/.test(normalized)) block("Blocked recursive file deletion.");
  if (/\bformat\b/.test(normalized)) block("Blocked format command.");
  if (/\bshutdown\b/.test(normalized)) block("Blocked shutdown command.");
  if (/\bgit\s+push\b/.test(normalized)) block("Blocked git push.");
  if (/\bnpm\s+publish\b/.test(normalized)) block("Blocked npm publish.");

  return { risk, blocked, warnings: [...new Set(warnings)] };
}

export function formatShellApprovalPreview(approval: ShellApproval): string {
  return [
    approval.blocked ? "[BLOCKED PREVIEW] Shell command cannot be approved." : "[PREVIEW] Shell command approval created.",
    `Approval: ${approval.id}`,
    `Status: ${approval.status}`,
    `Risk: ${approval.risk}${approval.blocked ? " (blocked)" : ""}`,
    `Blocked: ${approval.blocked ? "yes" : "no"}`,
    `CWD: ${approval.cwd}`,
    `Command: ${approval.command}`,
    `Reason: ${approval.reason}`,
    `Expected effect: ${approval.expectedEffect}`,
    approval.sourceCapabilityId ? `Source capability: ${approval.sourceCapabilityId}` : undefined,
    `Expires: ${approval.expiresAt}`,
    approval.warnings.length ? `Warnings:\n${approval.warnings.map((item) => `- ${item}`).join("\n")}` : undefined,
    "",
    approval.blocked
      ? "This command cannot be executed through COSIA shell approval."
      : `Run: cosia shell apply ${approval.id}`
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function formatShellApprovalList(approvals: ShellApproval[], options: { now?: Date } = {}): string {
  if (!approvals.length) {
    return "No shell approvals.";
  }
  const now = options.now ?? new Date();
  return approvals.map((approval) => {
    const stale = approval.status === "running" && Date.parse(approval.runningAt ?? approval.createdAt) < now.getTime() - staleRunningMs
      ? " stale-running"
      : "";
    const source = approval.sourceCapabilityId ? `\tsourceCapability:${approval.sourceCapabilityId}` : "";
    return `${approval.id}\t${approval.status}${stale}\trisk:${approval.risk}${approval.blocked ? ":blocked" : ""}\texpires:${approval.expiresAt}${source}\t${approval.command}`;
  }).join("\n");
}

export function summarizeShellToolArgs(args: unknown): Record<string, unknown> {
  const summary = summarizePolicyArgs(args);
  if (typeof summary.command === "string") {
    summary.command = redactShellText(summary.command);
  }
  return {
    ...summary,
    permission: "shell_request",
    execution: "preview_only"
  };
}

function ensureShellApprovalTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shell_approvals (
      id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      command_hash TEXT NOT NULL,
      cwd TEXT NOT NULL,
      cwd_hash TEXT NOT NULL,
      reason TEXT NOT NULL,
      expected_effect TEXT NOT NULL,
      risk TEXT NOT NULL,
      blocked INTEGER NOT NULL,
      warnings_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      running_at TEXT,
      applied_at TEXT,
      failed_at TEXT,
      failure_reason TEXT,
      failure_kind TEXT,
      exit_code INTEGER,
      duration_ms INTEGER,
      source_session_id TEXT,
      source_agent_id TEXT,
      source_run_id TEXT,
      source_capability_id TEXT,
      source_channel TEXT NOT NULL,
      record_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shell_approvals_status ON shell_approvals(status);
  `);
  ensureShellColumn(db, "source_capability_id", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_shell_approvals_source_capability_id ON shell_approvals(source_capability_id);");
}

function ensureShellColumn(db: DatabaseSync, columnName: string, definition: string): void {
  const columns = db.prepare("PRAGMA table_info(shell_approvals)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE shell_approvals ADD COLUMN ${columnName} ${definition}`);
  }
}

function insertShellApproval(db: DatabaseSync, approval: ShellApproval): void {
  ensureShellApprovalTable(db);
  db.prepare(`
    INSERT INTO shell_approvals (
      id, command, command_hash, cwd, cwd_hash, reason, expected_effect, risk, blocked,
      warnings_json, status, created_at, expires_at, running_at, applied_at, failed_at,
      failure_reason, failure_kind, exit_code, duration_ms, source_session_id, source_agent_id,
      source_run_id, source_capability_id, source_channel, record_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(...approvalValues(approval), new Date().toISOString());
}

function updateShellApproval(db: DatabaseSync, approval: ShellApproval): void {
  db.prepare(`
    UPDATE shell_approvals SET
      command = ?,
      command_hash = ?,
      cwd = ?,
      cwd_hash = ?,
      reason = ?,
      expected_effect = ?,
      risk = ?,
      blocked = ?,
      warnings_json = ?,
      status = ?,
      created_at = ?,
      expires_at = ?,
      running_at = ?,
      applied_at = ?,
      failed_at = ?,
      failure_reason = ?,
      failure_kind = ?,
      exit_code = ?,
      duration_ms = ?,
      source_session_id = ?,
      source_agent_id = ?,
      source_run_id = ?,
      source_capability_id = ?,
      source_channel = ?,
      record_json = ?,
      updated_at = ?
    WHERE id = ?
  `).run(...approvalValues(approval).slice(1), new Date().toISOString(), approval.id);
}

function approvalValues(approval: ShellApproval): Array<string | number | null> {
  return [
    approval.id,
    approval.command,
    approval.commandHash,
    approval.cwd,
    approval.cwdHash,
    approval.reason,
    approval.expectedEffect,
    approval.risk,
    approval.blocked ? 1 : 0,
    JSON.stringify(approval.warnings),
    approval.status,
    approval.createdAt,
    approval.expiresAt,
    approval.runningAt ?? null,
    approval.appliedAt ?? null,
    approval.failedAt ?? null,
    approval.failureReason ?? null,
    approval.failureKind ?? null,
    approval.exitCode ?? null,
    approval.durationMs ?? null,
    approval.sourceSessionId ?? null,
    approval.sourceAgentId ?? null,
    approval.sourceRunId ?? null,
    approval.sourceCapabilityId ?? null,
    approval.sourceChannel,
    JSON.stringify(approval)
  ];
}

type ShellApprovalRow = {
  id: string;
  command: string;
  command_hash: string;
  cwd: string;
  cwd_hash: string;
  reason: string;
  expected_effect: string;
  risk: ShellApprovalRisk;
  blocked: number;
  warnings_json: string;
  status: ShellApprovalStatus;
  created_at: string;
  expires_at: string;
  running_at: string | null;
  applied_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  failure_kind: ShellFailureKind | null;
  exit_code: number | null;
  duration_ms: number | null;
  source_session_id: string | null;
  source_agent_id: string | null;
  source_run_id: string | null;
  source_capability_id?: string | null;
  source_channel: "cli" | "repl" | "gateway";
  record_json: string;
};

function selectShellApproval(db: DatabaseSync, id: string): ShellApproval | undefined {
  const row = db.prepare("SELECT * FROM shell_approvals WHERE id = ?").get(id) as ShellApprovalRow | undefined;
  return row ? rowToApproval(row) : undefined;
}

function rowToApproval(row: ShellApprovalRow): ShellApproval {
  let parsed: Partial<ShellApproval> = {};
  try {
    parsed = JSON.parse(row.record_json) as Partial<ShellApproval>;
  } catch {
    parsed = {};
  }
  return {
    id: row.id,
    command: row.command,
    commandHash: row.command_hash,
    cwd: row.cwd,
    cwdHash: row.cwd_hash,
    reason: row.reason,
    expectedEffect: row.expected_effect,
    risk: row.risk,
    blocked: Boolean(row.blocked),
    warnings: JSON.parse(row.warnings_json) as string[],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    runningAt: row.running_at ?? undefined,
    appliedAt: row.applied_at ?? undefined,
    failedAt: row.failed_at ?? undefined,
    failureReason: row.failure_reason ?? undefined,
    failureKind: row.failure_kind ?? undefined,
    exitCode: row.exit_code ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    sourceSessionId: row.source_session_id ?? undefined,
    sourceAgentId: row.source_agent_id ?? undefined,
    sourceRunId: row.source_run_id ?? undefined,
    sourceCapabilityId: row.source_capability_id ?? parsed.sourceCapabilityId ?? undefined,
    sourceChannel: row.source_channel,
    status: row.status
  };
}

export function buildShellApprovalRecord(workspaceRoot: string, input: CreateShellApprovalInput): ShellApproval {
  const command = input.command.trim();
  if (!command) {
    throw new Error("Shell command is required.");
  }
  if (input.sourceChannel === "gateway") {
    throw new Error("Gateway shell execution is blocked in v0.29.");
  }
  const cwd = normalizeCwd(workspaceRoot, input.cwd ?? ".");
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? defaultTtlMs));
  const assessment = assessShellRisk(command);
  return {
    id: `shell_${randomUUID().slice(0, 8)}`,
    command: redactShellText(command),
    commandHash: hashText(command),
    cwd,
    cwdHash: hashText(cwd),
    reason: redactShellText(input.reason),
    expectedEffect: redactShellText(input.expectedEffect ?? "Run the approved shell command once."),
    risk: assessment.risk,
    blocked: assessment.blocked,
    warnings: assessment.warnings.map(redactShellText),
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    sourceSessionId: input.sourceSessionId,
    sourceAgentId: input.sourceAgentId,
    sourceRunId: input.sourceRunId,
    sourceCapabilityId: input.sourceCapabilityId,
    sourceChannel: input.sourceChannel,
    status: "pending"
  };
}

function expireApprovalIfNeeded(db: DatabaseSync, id: string, now: Date): void {
  const current = selectShellApproval(db, id);
  if (current && current.status === "pending" && Date.parse(current.expiresAt) <= now.getTime()) {
    updateShellApproval(db, { ...current, status: "expired" });
  }
}

function normalizeCwd(workspaceRoot: string, cwd: string): string {
  return resolve(resolveInside(workspaceRoot, cwd));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeCommand(command: string): string {
  return command.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasChainOperator(command: string): boolean {
  return /&&|\|\||;|\|/.test(command);
}

function containsSecretLike(value: string): boolean {
  return /sk-[A-Za-z0-9_-]{20,}/.test(value)
    || /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/.test(value)
    || /\bBearer\s+[A-Za-z0-9._-]{20,}/i.test(value)
    || /\bghp_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/.test(value)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value);
}

export function redactShellText(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\b\d{8,10}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/\bghp_[A-Za-z0-9_]{12,}\b/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
}

function shellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }
    const upper = key.toUpperCase();
    if (!envAllowlist.has(upper)) {
      continue;
    }
    if (/(API_KEY|TOKEN|SECRET|PASSWORD)/i.test(key)) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

async function executeApprovedShell(command: string, cwd: string): Promise<{
  exitCode: number;
  outputSummary: string;
  failureKind?: ShellFailureKind;
  failureReason?: string;
}> {
  return new Promise((resolvePromise) => {
    const child = exec(command, {
      cwd,
      env: shellEnv(),
      timeout: defaultTimeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      const outputSummary = truncateOutput(formatCommandOutput(stdout, stderr), outputMaxChars);
      if (!error) {
        resolvePromise({ exitCode: 0, outputSummary });
        return;
      }
      const err = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
      const exitCode = typeof err.code === "number" ? err.code : -1;
      const failureKind: ShellFailureKind = err.killed ? "timeout" : typeof err.code === "number" ? "non_zero_exit" : "spawn_failed";
      resolvePromise({
        exitCode,
        outputSummary,
        failureKind,
        failureReason: redactShellText(err.message)
      });
    });
    child.stdin?.end();
  });
}

function formatCommandOutput(stdout: string, stderr: string): string {
  const sections: string[] = [];
  if (stdout.trim()) {
    sections.push(redactShellText(stdout.trimEnd()));
  }
  if (stderr.trim()) {
    sections.push(`stderr:\n${redactShellText(stderr.trimEnd())}`);
  }
  return sections.join("\n\n") || "No output.";
}

function truncateOutput(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  const marker = `\n[COSIA: shell output truncated, originalChars=${content.length}, retainedChars=${maxChars}, omittedChars=${content.length - maxChars}.]`;
  return `${content.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

function formatShellExecutionBlocked(approval: ShellApproval): string {
  return [
    "[BLOCKED] Shell approval is blocked by policy.",
    `Approval: ${approval.id}`,
    `Risk: ${approval.risk}`,
    approval.warnings.length ? `Warnings:\n${approval.warnings.map((item) => `- ${item}`).join("\n")}` : undefined
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatShellExecutionResult(approval: ShellApproval, outputSummary: string): string {
  const header = approval.status === "applied"
    ? "[SUCCESS] Shell command executed once."
    : approval.failureKind === "non_zero_exit"
      ? "[FAILED] Execution completed with non-zero exit code."
      : "[FAILED] Shell command failed.";
  return [
    header,
    `Approval: ${approval.id}`,
    `Status: ${approval.status}`,
    approval.exitCode !== undefined ? `Exit code: ${approval.exitCode}` : undefined,
    approval.durationMs !== undefined ? `Duration: ${approval.durationMs}ms` : undefined,
    approval.failureKind ? `Failure kind: ${approval.failureKind}` : undefined,
    approval.failureReason ? `Failure reason: ${approval.failureReason}` : undefined,
    "",
    outputSummary || "No output."
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function shellApprovalDbExists(workspaceRoot: string): boolean {
  return existsSync(join(workspaceRoot, "memory", "longterm.sqlite"));
}
