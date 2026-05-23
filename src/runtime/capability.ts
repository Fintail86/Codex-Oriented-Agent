import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { formatShellApprovalPreview, type ShellApproval } from "./shell_approval.js";

export const legacyEnvironmentScanId = "legacy_v0.29";
const defaultMaxDepth = 3;
const defaultPlannerMaxStaleAgeMs = 300_000;
const structuredFileSizeCap = 500 * 1024;
const readmeFileSizeCap = 128 * 1024;
const maxDirectoryEntries = 250;

export const environmentFactKindSchema = z.enum([
  "top_level_entry",
  "hidden_entry",
  "manifest_like_file",
  "config_like_file",
  "lock_like_file",
  "test_like_path",
  "script_like_key",
  "readme_summary",
  "user_request"
]);
export type EnvironmentFactKind = z.infer<typeof environmentFactKindSchema>;

export const environmentScanWarningKindSchema = z.enum([
  "unreadable_path",
  "symlink_cycle",
  "max_depth_reached",
  "size_cap_exceeded",
  "parse_failed",
  "skipped_directory"
]);
export type EnvironmentScanWarningKind = z.infer<typeof environmentScanWarningKindSchema>;

export type EnvironmentScan = {
  scanId: string;
  observedAt: string;
  workspaceRoot: string;
};

export type EnvironmentFact = {
  id: string;
  scanId: string;
  kind: EnvironmentFactKind;
  path?: string;
  summary?: string;
  keys?: string[];
  observedAt: string;
};

export type EnvironmentScanWarning = {
  id: string;
  scanId: string;
  kind: EnvironmentScanWarningKind;
  path?: string;
  message: string;
  createdAt: string;
};

export type EnvironmentScanResult = {
  scan: EnvironmentScan;
  facts: EnvironmentFact[];
  warnings: EnvironmentScanWarning[];
};

export const capabilityFamilySchema = z.enum([
  "change_tracking",
  "project_check",
  "dependency_management",
  "formatting",
  "search_observation",
  "runtime_execution",
  "unknown"
]);
export type CapabilityFamily = z.infer<typeof capabilityFamilySchema>;

export const capabilityNextStepSchema = z.enum([
  "ask_user",
  "shell_preview",
  "tool_draft",
  "current_tools_only",
  "ignore"
]);

export const capabilityStatusSchema = z.enum([
  "pending",
  "ignored",
  "discarded",
  "converted_to_shell",
  "converted_to_draft"
]);

export type CapabilityHypothesis = {
  text: string;
  groundingFactIds: string[];
};

export type CapabilityApproach = {
  title: string;
  summary: string;
  groundingFactIds: string[];
  riskLevel: "low" | "medium" | "high";
  kind: z.infer<typeof capabilityNextStepSchema>;
};

export type CapabilityProposal = {
  id: string;
  sourceScanId: string;
  userNeed: string;
  capabilityFamily: CapabilityFamily;
  groundingFactIds: string[];
  hypotheses: CapabilityHypothesis[];
  possibleApproaches: CapabilityApproach[];
  recommendedNextStep: z.infer<typeof capabilityNextStepSchema>;
  riskLevel: "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
  status: z.infer<typeof capabilityStatusSchema>;
  discardedAt?: string;
  discardReason?: string;
};

export type CapabilityScanResult = EnvironmentScanResult & {
  proposals: CapabilityProposal[];
};

export type CapabilityPlanResult = {
  scan: EnvironmentScan;
  proposal: CapabilityProposal;
  groundingFacts: EnvironmentFact[];
};

type JsonRecord = Record<string, unknown>;

type DiscoveryContext = {
  scan: EnvironmentScan;
  facts: EnvironmentFact[];
  warnings: EnvironmentScanWarning[];
  visitedRealpaths: Set<string>;
  skippedDirectoryCounts: Map<string, number>;
  maxDepth: number;
};

export class EnvironmentDiscovery {
  constructor(private readonly workspaceRoot: string) {}

  async scan(options: { userNeed?: string; maxDepth?: number } = {}): Promise<EnvironmentScanResult> {
    const observedAt = new Date().toISOString();
    const scan: EnvironmentScan = {
      scanId: createScanId(new Date(observedAt)),
      observedAt,
      workspaceRoot: resolve(this.workspaceRoot)
    };
    const context: DiscoveryContext = {
      scan,
      facts: [],
      warnings: [],
      visitedRealpaths: new Set(),
      skippedDirectoryCounts: new Map(),
      maxDepth: options.maxDepth ?? defaultMaxDepth
    };

    if (options.userNeed?.trim()) {
      addFact(context, {
        kind: "user_request",
        summary: options.userNeed.trim()
      });
    }

    try {
      context.visitedRealpaths.add(await realpath(scan.workspaceRoot));
    } catch {
      context.visitedRealpaths.add(scan.workspaceRoot);
    }

    await scanDirectory(scan.workspaceRoot, "", 0, context);
    addSkippedDirectorySummaries(context);

    const result = {
      scan,
      facts: sortFacts(context.facts),
      warnings: sortWarnings(context.warnings)
    };
    this.saveScan(result);
    return result;
  }

  listFacts(options: { latest?: boolean; scanId?: string } = {}): EnvironmentScanResult {
    return readEnvironmentScan(this.workspaceRoot, options);
  }

  private saveScan(result: EnvironmentScanResult): void {
    withCapabilityDb(this.workspaceRoot, (db) => {
      db.exec("BEGIN");
      try {
        db.prepare(`
          INSERT INTO environment_scans (scan_id, observed_at, workspace_root, record_json)
          VALUES (?, ?, ?, ?)
        `).run(
          result.scan.scanId,
          result.scan.observedAt,
          result.scan.workspaceRoot,
          JSON.stringify(result.scan)
        );
        for (const fact of result.facts) {
          db.prepare(`
            INSERT INTO environment_facts (id, scan_id, kind, path, summary, keys_json, observed_at, record_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            fact.id,
            fact.scanId,
            fact.kind,
            fact.path ?? null,
            fact.summary ?? null,
            JSON.stringify(fact.keys ?? []),
            fact.observedAt,
            JSON.stringify(fact)
          );
        }
        for (const warning of result.warnings) {
          db.prepare(`
            INSERT INTO environment_scan_warnings (id, scan_id, kind, path, message, created_at, record_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            warning.id,
            warning.scanId,
            warning.kind,
            warning.path ?? null,
            warning.message,
            warning.createdAt,
            JSON.stringify(warning)
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }
}

export class CapabilityPlanner {
  constructor(private readonly workspaceRoot: string) {}

  async scan(options: { userNeed?: string } = {}): Promise<EnvironmentScanResult> {
    return new EnvironmentDiscovery(this.workspaceRoot).scan(options);
  }

  plan(options: { userNeed: string; now?: Date; maxStaleAgeMs?: number }): CapabilityPlanResult {
    const userNeed = options.userNeed.trim();
    if (!userNeed) {
      throw new Error("Capability request is required.");
    }
    const scanResult = this.loadLatestValidScan(userNeed, options);
    const proposal = this.propose(userNeed, scanResult);
    this.saveProposals([proposal]);
    return {
      scan: scanResult.scan,
      proposal,
      groundingFacts: selectFactsByIds(scanResult.facts, proposal.groundingFactIds)
    };
  }

  listFacts(options: { latest?: boolean; scanId?: string } = {}): EnvironmentScanResult {
    return new EnvironmentDiscovery(this.workspaceRoot).listFacts(options);
  }

  listProposals(options: { all?: boolean } = {}): CapabilityProposal[] {
    return withCapabilityDb(this.workspaceRoot, (db) => {
      const rows = options.all
        ? db.prepare("SELECT record_json FROM capability_proposals ORDER BY created_at DESC").all() as Array<{ record_json: string }>
        : db.prepare("SELECT record_json FROM capability_proposals WHERE status = 'pending' ORDER BY created_at DESC").all() as Array<{ record_json: string }>;
      return rows.map((row) => normalizeStoredProposal(row.record_json));
    });
  }

  getProposal(id: string): CapabilityProposal {
    const proposal = withCapabilityDb(this.workspaceRoot, (db) => {
      const row = db.prepare("SELECT record_json FROM capability_proposals WHERE id = ?").get(id) as { record_json: string } | undefined;
      return row ? normalizeStoredProposal(row.record_json) : undefined;
    });
    if (!proposal) {
      throw new Error(`Capability proposal not found: ${id}`);
    }
    return proposal;
  }

  discardProposal(id: string, reason: string): CapabilityProposal {
    const proposal = this.getProposal(id);
    if (proposal.status === "discarded") {
      return proposal;
    }
    if (proposal.status !== "pending" && proposal.status !== "ignored") {
      throw new Error(`Capability proposal cannot be discarded from status: ${proposal.status}`);
    }
    const next = normalizeCapabilityProposal({
      ...proposal,
      status: "discarded",
      discardedAt: new Date().toISOString(),
      discardReason: redactText(reason)
    });
    this.saveProposals([next]);
    return next;
  }

  convertToShell(id: string, _source: { sourceChannel: "cli" | "repl" | "gateway"; sourceSessionId?: string; sourceAgentId?: string; sourceRunId?: string }): ShellApproval {
    this.getProposal(id);
    throw new Error("Capability proposal has no v0.31 shell preview. Shell proposal mapping is deferred to v0.32+.");
  }

  groundingFactsForProposal(id: string): EnvironmentFact[] {
    const proposal = this.getProposal(id);
    const scanResult = this.listFacts({ scanId: proposal.sourceScanId });
    return selectFactsByIds(scanResult.facts, proposal.groundingFactIds);
  }

  private loadLatestValidScan(userNeed: string, options: { now?: Date; maxStaleAgeMs?: number }): EnvironmentScanResult {
    let scanResult;
    try {
      scanResult = this.listFacts({ latest: true });
    } catch {
      throw new Error([
        "No environment scan found.",
        "Run:",
        `  cosia capability scan --request "${userNeed}"`
      ].join("\n"));
    }
    const now = options.now ?? new Date();
    const maxStaleAgeMs = options.maxStaleAgeMs ?? defaultPlannerMaxStaleAgeMs;
    const observedMs = Date.parse(scanResult.scan.observedAt);
    if (!Number.isFinite(observedMs) || now.getTime() - observedMs > maxStaleAgeMs) {
      throw new Error([
        "Latest environment scan is stale.",
        "Run:",
        `  cosia capability scan --request "${userNeed}"`
      ].join("\n"));
    }
    return scanResult;
  }

  private propose(userNeed: string, scanResult: EnvironmentScanResult): CapabilityProposal {
    const facts = scanResult.facts;
    const family = detectCapabilityFamily(userNeed);
    const userFact = facts.find((fact) => fact.kind === "user_request");
    const relevantFacts = relevantFactIds(family, facts);
    const workspaceRelevantFacts = relevantFacts.filter((id) => !userFact || id !== userFact.id);
    const groundingFactIds = [...new Set([...(userFact ? [userFact.id] : []), ...relevantFacts])];
    const hasCrossGrounding = workspaceRelevantFacts.length > 0;
    return normalizeCapabilityProposal({
      id: `cap_${randomUUID().slice(0, 8)}`,
      sourceScanId: scanResult.scan.scanId,
      userNeed: redactText(userNeed),
      capabilityFamily: family,
      groundingFactIds,
      hypotheses: buildHypotheses(family, facts, groundingFactIds),
      possibleApproaches: buildApproaches(family, facts, groundingFactIds),
      recommendedNextStep: recommendNextStep(family, hasCrossGrounding),
      riskLevel: family === "runtime_execution" ? "medium" : "low",
      confidence: hasCrossGrounding ? "medium" : "low",
      status: "pending"
    });
  }

  private saveProposals(proposals: CapabilityProposal[]): void {
    withCapabilityDb(this.workspaceRoot, (db) => {
      for (const proposal of proposals) {
        db.prepare(`
          INSERT OR REPLACE INTO capability_proposals (
            id, source_scan_id, user_need, capability_family, status, risk_level, confidence,
            recommended_next_step, grounding_facts_json, grounding_fact_ids_json, hypotheses_json, possible_approaches_json,
            record_json, created_at, updated_at, discarded_at, discard_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM capability_proposals WHERE id = ?), ?), ?, ?, ?)
        `).run(
          proposal.id,
          proposal.sourceScanId,
          proposal.userNeed,
          proposal.capabilityFamily,
          proposal.status,
          proposal.riskLevel,
          proposal.confidence,
          proposal.recommendedNextStep,
          JSON.stringify(proposal.groundingFactIds),
          JSON.stringify(proposal.groundingFactIds),
          JSON.stringify(proposal.hypotheses),
          JSON.stringify(proposal.possibleApproaches),
          JSON.stringify(proposal),
          proposal.id,
          new Date().toISOString(),
          new Date().toISOString(),
          proposal.discardedAt ?? null,
          proposal.discardReason ?? null
        );
      }
    });
  }
}

export function normalizeCapabilityProposal(proposal: CapabilityProposal): CapabilityProposal {
  const groundingFactIds = uniqueStrings(proposal.groundingFactIds);
  const validFacts = new Set(groundingFactIds);
  const hypotheses = proposal.hypotheses
    .map((item) => ({
      text: sanitizeCapabilityText(item.text, "A capability may be needed."),
      groundingFactIds: uniqueStrings(item.groundingFactIds.filter((id) => validFacts.has(id)))
    }))
    .filter((item) => item.groundingFactIds.length > 0);
  const possibleApproaches = proposal.possibleApproaches
    .map((item) => ({
      title: sanitizeCapabilityText(item.title, "Capability boundary review"),
      summary: sanitizeCapabilityText(item.summary, "Review the capability boundary before creating execution proposals."),
      riskLevel: (item.riskLevel === "high" || item.riskLevel === "medium" ? item.riskLevel : "low") as "low" | "medium" | "high",
      kind: capabilityNextStepSchema.safeParse(item.kind).success ? item.kind : "ask_user",
      groundingFactIds: uniqueStrings(item.groundingFactIds.filter((id) => validFacts.has(id)))
    }))
    .filter((item) => item.groundingFactIds.length > 0);
  const allRemoved = proposal.hypotheses.length + proposal.possibleApproaches.length > 0
    && hypotheses.length + possibleApproaches.length === 0;
  const normalizedConfidence = proposal.confidence === "medium" ? "medium" : "low";
  return {
    ...proposal,
    sourceScanId: proposal.sourceScanId,
    capabilityFamily: capabilityFamilySchema.safeParse(proposal.capabilityFamily).success ? proposal.capabilityFamily : "unknown",
    recommendedNextStep: capabilityNextStepSchema.safeParse(proposal.recommendedNextStep).success ? proposal.recommendedNextStep : "ask_user",
    riskLevel: proposal.riskLevel === "high" || proposal.riskLevel === "medium" ? proposal.riskLevel : "low",
    confidence: normalizedConfidence,
    groundingFactIds,
    hypotheses,
    possibleApproaches,
    status: allRemoved ? "ignored" : proposal.status
  };
}

export function formatCapabilityScan(result: EnvironmentScanResult): string {
  return [
    "Capability scan",
    `Scan: ${result.scan.scanId}`,
    "",
    formatFactKindSummary(result.facts, result.warnings)
  ].join("\n");
}

export function formatCapabilityFacts(result: EnvironmentScanResult): string {
  return [
    "Capability facts",
    `Scan: ${result.scan.scanId}`,
    "",
    formatFactKindSummary(result.facts, result.warnings),
    "",
    "Facts:",
    result.facts.length ? result.facts.map(formatFact).join("\n") : "- none",
    "",
    "Warnings:",
    result.warnings.length ? result.warnings.map(formatWarning).join("\n") : "- none"
  ].join("\n");
}

export function capabilityScanJson(result: EnvironmentScanResult): string {
  const output = {
    facts: sortFacts(result.facts).map(publicFact),
    scan: publicScan(result.scan),
    warnings: sortWarnings(result.warnings).map(publicWarning)
  };
  return stableJsonStringify(output);
}

export function formatCapabilityPlan(result: CapabilityPlanResult): string {
  return formatCapabilityProposal(result.proposal, result.groundingFacts);
}

export function formatCapabilityReview(proposals: CapabilityProposal[]): string {
  if (!proposals.length) {
    return "No capability proposals.";
  }
  return proposals.map(formatCapabilityProposalCompact).join("\n\n");
}

export function formatCapabilityProposal(proposal: CapabilityProposal, groundingFacts: EnvironmentFact[] = []): string {
  return [
    `Capability proposal: ${proposal.id}`,
    `Status: ${proposal.status}`,
    `Source scan: ${proposal.sourceScanId}`,
    `Need: ${proposal.userNeed}`,
    `Family: ${proposal.capabilityFamily}`,
    `Risk: ${proposal.riskLevel}`,
    `Confidence: ${proposal.confidence}`,
    `Next: ${proposal.recommendedNextStep}`,
    `Grounding facts: ${proposal.groundingFactIds.join(", ") || "none"}`,
    "",
    "Grounding fact summary:",
    groundingFacts.length ? groundingFacts.map(formatFact).join("\n") : "- none",
    "",
    "Hypotheses:",
    proposal.hypotheses.length ? proposal.hypotheses.map((item) => `- ${item.text} [${item.groundingFactIds.join(", ")}]`).join("\n") : "- none",
    "",
    "Approaches:",
    proposal.possibleApproaches.length ? proposal.possibleApproaches.map((item) => `- ${item.title} (${item.kind}, ${item.riskLevel}) [${item.groundingFactIds.join(", ")}]\n  ${item.summary}`).join("\n") : "- none"
  ].join("\n");
}

export function formatCapabilityShellPreview(approval: ShellApproval): string {
  return formatShellApprovalPreview(approval);
}

export function normalizeForStableJson(value: unknown): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableJson(item));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalized = normalizeForStableJson((value as Record<string, unknown>)[key]);
      if (normalized !== undefined) {
        output[key] = normalized;
      }
    }
    return output;
  }
  return value;
}

export function stableJsonStringify(value: unknown): string {
  return `${JSON.stringify(normalizeForStableJson(value), null, 2)}\n`;
}

function withCapabilityDb<T>(workspaceRoot: string, work: (db: DatabaseSync) => T): T {
  mkdirSync(join(workspaceRoot, "memory"), { recursive: true });
  const db = new DatabaseSync(join(workspaceRoot, "memory", "longterm.sqlite"));
  try {
    ensureCapabilityTables(db, workspaceRoot);
    return work(db);
  } finally {
    db.close();
  }
}

function ensureCapabilityTables(db: DatabaseSync, workspaceRoot: string): void {
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS environment_scans (
        scan_id TEXT PRIMARY KEY,
        observed_at TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS environment_facts (
        id TEXT PRIMARY KEY,
        scan_id TEXT,
        kind TEXT NOT NULL,
        path TEXT,
        summary TEXT,
        keys_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS environment_scan_warnings (
        id TEXT PRIMARY KEY,
        scan_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capability_proposals (
        id TEXT PRIMARY KEY,
        source_scan_id TEXT,
        user_need TEXT NOT NULL,
        capability_family TEXT NOT NULL,
        status TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        confidence TEXT NOT NULL,
        recommended_next_step TEXT NOT NULL,
        grounding_facts_json TEXT,
        grounding_fact_ids_json TEXT,
        hypotheses_json TEXT,
        possible_approaches_json TEXT,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        discarded_at TEXT,
        discard_reason TEXT
      );
    `);
    if (!hasColumn(db, "environment_facts", "scan_id")) {
      db.exec("ALTER TABLE environment_facts ADD COLUMN scan_id TEXT");
    }
    ensureColumn(db, "capability_proposals", "source_scan_id", "TEXT");
    ensureColumn(db, "capability_proposals", "grounding_fact_ids_json", "TEXT");
    ensureColumn(db, "capability_proposals", "hypotheses_json", "TEXT");
    ensureColumn(db, "capability_proposals", "possible_approaches_json", "TEXT");
    ensureColumn(db, "capability_proposals", "discarded_at", "TEXT");
    ensureColumn(db, "capability_proposals", "discard_reason", "TEXT");
    const legacyCount = db.prepare("SELECT COUNT(*) AS count FROM environment_facts WHERE scan_id IS NULL OR scan_id = ''").get() as { count: number };
    if (legacyCount.count > 0) {
      const observedAt = new Date(0).toISOString();
      const legacyScan: EnvironmentScan = {
        scanId: legacyEnvironmentScanId,
        observedAt,
        workspaceRoot: resolve(workspaceRoot)
      };
      db.prepare(`
        INSERT OR IGNORE INTO environment_scans (scan_id, observed_at, workspace_root, record_json)
        VALUES (?, ?, ?, ?)
      `).run(legacyScan.scanId, legacyScan.observedAt, legacyScan.workspaceRoot, JSON.stringify(legacyScan));
      db.prepare("UPDATE environment_facts SET scan_id = ? WHERE scan_id IS NULL OR scan_id = ''").run(legacyEnvironmentScanId);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_environment_facts_scan_id ON environment_facts(scan_id);
      CREATE INDEX IF NOT EXISTS idx_environment_scan_warnings_scan_id ON environment_scan_warnings(scan_id);
      CREATE INDEX IF NOT EXISTS idx_environment_scans_observed_at ON environment_scans(observed_at);
      CREATE INDEX IF NOT EXISTS idx_capability_proposals_status ON capability_proposals(status);
      CREATE INDEX IF NOT EXISTS idx_capability_proposals_source_scan_id ON capability_proposals(source_scan_id);
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function readEnvironmentScan(workspaceRoot: string, options: { latest?: boolean; scanId?: string }): EnvironmentScanResult {
  return withCapabilityDb(workspaceRoot, (db) => {
    const scan = selectScan(db, options);
    const facts = (db.prepare("SELECT scan_id, record_json FROM environment_facts WHERE scan_id = ?").all(scan.scanId) as Array<{ scan_id: string; record_json: string }>)
      .map((row) => normalizeFactFromRow(row.record_json, row.scan_id, scan.observedAt));
    const warnings = (db.prepare("SELECT record_json FROM environment_scan_warnings WHERE scan_id = ?").all(scan.scanId) as Array<{ record_json: string }>)
      .map((row) => JSON.parse(row.record_json) as EnvironmentScanWarning);
    return {
      scan,
      facts: sortFacts(facts),
      warnings: sortWarnings(warnings)
    };
  });
}

function selectScan(db: DatabaseSync, options: { latest?: boolean; scanId?: string }): EnvironmentScan {
  if (options.scanId) {
    const row = db.prepare("SELECT record_json FROM environment_scans WHERE scan_id = ?").get(options.scanId) as { record_json: string } | undefined;
    if (!row) throw new Error(`Environment scan not found: ${options.scanId}`);
    return JSON.parse(row.record_json) as EnvironmentScan;
  }
  const row = db.prepare("SELECT record_json FROM environment_scans ORDER BY observed_at DESC, scan_id DESC LIMIT 1").get() as { record_json: string } | undefined;
  if (!row) throw new Error("No environment scans found. Run `cosia capability scan` first.");
  return JSON.parse(row.record_json) as EnvironmentScan;
}

function hasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return columns.some((column) => column.name === columnName);
}

function ensureColumn(db: DatabaseSync, tableName: string, columnName: string, definition: string): void {
  if (!hasColumn(db, tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

async function scanDirectory(absDirectory: string, relDirectory: string, depth: number, context: DiscoveryContext): Promise<void> {
  let entries;
  try {
    entries = await readdir(absDirectory, { withFileTypes: true });
  } catch {
    addWarning(context, "unreadable_path", relDirectory, "Path could not be read.");
    return;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, maxDirectoryEntries)) {
    const relPath = joinRel(relDirectory, entry.name);
    const absPath = join(absDirectory, entry.name);
    let entryStat;
    try {
      entryStat = await lstat(absPath);
    } catch {
      addWarning(context, "unreadable_path", relPath, "Path could not be read.");
      continue;
    }

    if (entryStat.isSymbolicLink()) {
      await handleSymlink(absPath, relPath, depth, context);
      continue;
    }

    if (isHiddenOrMetaLooking(entry.name)) {
      addFact(context, { kind: "hidden_entry", path: relPath, summary: "Hidden or metadata-looking workspace entry." });
      continue;
    }

    if (entryStat.isDirectory()) {
      if (depth === 0) {
        addFact(context, { kind: "top_level_entry", path: relPath, summary: "Top-level directory." });
      }
      const skip = skipDirectoryReason(entry.name);
      if (skip) {
        addSkippedDirectoryWarning(context, relPath, skip);
        continue;
      }
      if (depth >= context.maxDepth) {
        addWarning(context, "max_depth_reached", relPath, "Maximum scan depth reached.");
        continue;
      }
      let canonical;
      try {
        canonical = await realpath(absPath);
      } catch {
        addWarning(context, "unreadable_path", relPath, "Path could not be resolved.");
        continue;
      }
      if (context.visitedRealpaths.has(canonical)) {
        addWarning(context, "symlink_cycle", relPath, "Directory cycle detected.");
        continue;
      }
      context.visitedRealpaths.add(canonical);
      await scanDirectory(absPath, relPath, depth + 1, context);
      continue;
    }

    if (entryStat.isFile()) {
      await classifyFileFact(absPath, relPath, depth, context);
    }
  }

  if (entries.length > maxDirectoryEntries) {
    addWarning(context, "max_depth_reached", relDirectory, "Directory entry scan limit reached.");
  }
}

async function handleSymlink(absPath: string, relPath: string, depth: number, context: DiscoveryContext): Promise<void> {
  let target;
  try {
    target = await realpath(absPath);
  } catch {
    addWarning(context, "unreadable_path", relPath, "Symbolic link target could not be resolved.");
    return;
  }
  if (!isInsideWorkspace(context.scan.workspaceRoot, target)) {
    addWarning(context, "skipped_directory", relPath, "Symbolic link target is outside the workspace.");
    return;
  }
  if (context.visitedRealpaths.has(target)) {
    addWarning(context, "symlink_cycle", relPath, "Symbolic link cycle detected.");
    return;
  }
  let targetStat;
  try {
    targetStat = await stat(absPath);
  } catch {
    addWarning(context, "unreadable_path", relPath, "Symbolic link target could not be read.");
    return;
  }
  if (targetStat.isDirectory()) {
    if (depth >= context.maxDepth) {
      addWarning(context, "max_depth_reached", relPath, "Maximum scan depth reached.");
      return;
    }
    context.visitedRealpaths.add(target);
    await scanDirectory(absPath, relPath, depth + 1, context);
    return;
  }
  if (targetStat.isFile()) {
    await classifyFileFact(absPath, relPath, depth, context);
  }
}

async function classifyFileFact(absPath: string, relPath: string, depth: number, context: DiscoveryContext): Promise<void> {
  const lower = relPath.toLowerCase();
  let emitted = false;

  if (isReadmeLike(lower)) {
    addFact(context, {
      kind: "readme_summary",
      path: relPath,
      summary: await readSummary(absPath, relPath, context)
    });
    emitted = true;
  }

  if (isLockLike(lower)) {
    addFact(context, { kind: "lock_like_file", path: relPath, summary: "Lock/checksum-like file." });
    emitted = true;
  }

  if (isConfigLike(lower)) {
    addFact(context, { kind: "config_like_file", path: relPath, summary: "Config-like file." });
    emitted = true;
  }

  if (isStructuredCandidate(lower)) {
    const structured = await readStructuredShape(absPath, relPath, context);
    if (structured.keys.length) {
      addFact(context, {
        kind: "manifest_like_file",
        path: relPath,
        keys: structured.keys,
        summary: "Structured file with object-like keys."
      });
      emitted = true;
    }
    if (structured.scriptLikeKeys.length) {
      addFact(context, {
        kind: "script_like_key",
        path: relPath,
        keys: structured.scriptLikeKeys,
        summary: "Command-map-like keys in a structured file."
      });
      emitted = true;
    }
  }

  if (isTestLike(lower)) {
    addFact(context, { kind: "test_like_path", path: relPath, summary: "Test/spec-looking path." });
    emitted = true;
  }

  if (!emitted && depth === 0) {
    addFact(context, { kind: "top_level_entry", path: relPath, summary: "Top-level file." });
  }
}

async function readStructuredShape(absPath: string, relPath: string, context: DiscoveryContext): Promise<{ keys: string[]; scriptLikeKeys: string[] }> {
  let fileStat;
  try {
    fileStat = await stat(absPath);
  } catch {
    addWarning(context, "unreadable_path", relPath, "Path could not be read.");
    return { keys: [], scriptLikeKeys: [] };
  }
  if (fileStat.size > structuredFileSizeCap) {
    addWarning(context, "size_cap_exceeded", relPath, "Structured file size cap exceeded.");
    return { keys: [], scriptLikeKeys: [] };
  }

  let text;
  try {
    text = await readFile(absPath, "utf8");
  } catch {
    addWarning(context, "unreadable_path", relPath, "Path could not be read.");
    return { keys: [], scriptLikeKeys: [] };
  }

  const extension = extname(relPath).toLowerCase();
  if (extension === ".json" || text.trimStart().startsWith("{")) {
    try {
      const raw = JSON.parse(text) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { keys: [], scriptLikeKeys: [] };
      }
      const record = raw as JsonRecord;
      return {
        keys: sanitizeKeys(Object.keys(record)),
        scriptLikeKeys: commandMapLikeKeys(record)
      };
    } catch {
      addWarning(context, "parse_failed", relPath, "Structured file could not be parsed.");
      return { keys: [], scriptLikeKeys: [] };
    }
  }

  return { keys: sanitizeKeys(extractTextKeys(text)), scriptLikeKeys: [] };
}

async function readSummary(absPath: string, relPath: string, context: DiscoveryContext): Promise<string> {
  let fileStat;
  try {
    fileStat = await stat(absPath);
  } catch {
    addWarning(context, "unreadable_path", relPath, "Path could not be read.");
    return "Documentation-like file present.";
  }
  if (fileStat.size > readmeFileSizeCap) {
    addWarning(context, "size_cap_exceeded", relPath, "Documentation-like file size cap exceeded.");
    return "Documentation-like file present.";
  }
  try {
    return redactText((await readFile(absPath, "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 8)
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, 400));
  } catch {
    addWarning(context, "unreadable_path", relPath, "Path could not be read.");
    return "Documentation-like file present.";
  }
}

function detectCapabilityFamily(userNeed: string): CapabilityFamily {
  const normalized = userNeed.toLowerCase();
  if (/변경|추적|상태|status|change|diff|version control|버전/.test(normalized)) {
    return "change_tracking";
  }
  if (/테스트|검증|typecheck|test|build|빌드/.test(normalized)) {
    return "project_check";
  }
  if (/설치|dependency|package|의존성/.test(normalized)) {
    return "dependency_management";
  }
  if (/format|lint|포맷|정렬/.test(normalized)) {
    return "formatting";
  }
  if (/검색|찾아|search|find/.test(normalized)) {
    return "search_observation";
  }
  if (/실행|run|execute|shell|쉘/.test(normalized)) {
    return "runtime_execution";
  }
  return "unknown";
}

function relevantFactIds(family: CapabilityFamily, facts: EnvironmentFact[]): string[] {
  if (family === "change_tracking") {
    return facts.filter((fact) => fact.kind === "hidden_entry" || fact.kind === "user_request").map((fact) => fact.id);
  }
  if (family === "project_check") {
    return facts.filter((fact) => ["manifest_like_file", "script_like_key", "test_like_path", "user_request"].includes(fact.kind)).map((fact) => fact.id);
  }
  return facts.filter((fact) => fact.kind === "user_request" || fact.kind === "readme_summary").map((fact) => fact.id);
}

function buildHypotheses(family: CapabilityFamily, facts: EnvironmentFact[], groundingFacts: string[]): CapabilityHypothesis[] {
  if (!groundingFacts.length) {
    return [];
  }
  if (family === "change_tracking") {
    return [{ text: "The user may need a change-tracking capability, but no concrete version-control tool is assumed.", groundingFactIds: groundingFacts }];
  }
  if (family === "project_check") {
    const hasScripts = facts.some((fact) => fact.kind === "script_like_key");
    return [{ text: hasScripts ? "A structured file exposes command-map-like keys that may support project checks." : "The user asked for project checks, but no specific package runner is assumed.", groundingFactIds: groundingFacts }];
  }
  return [{ text: "A new capability may be useful, but it needs more grounding before execution.", groundingFactIds: groundingFacts }];
}

function buildApproaches(family: CapabilityFamily, _facts: EnvironmentFact[], groundingFacts: string[]): CapabilityApproach[] {
  if (!groundingFacts.length) {
    return [];
  }
  if (family === "change_tracking") {
    return [
      { title: "Current state report", summary: "Use current core tools to inspect relevant files and report observed state.", groundingFactIds: groundingFacts, riskLevel: "low", kind: "current_tools_only" },
      { title: "Local snapshot tracker", summary: "Propose a workspace-local snapshot capability for future comparisons.", groundingFactIds: groundingFacts, riskLevel: "medium", kind: "tool_draft" },
      { title: "External change-tracking setup", summary: "Ask the user whether an external change-tracking capability should be introduced.", groundingFactIds: groundingFacts, riskLevel: "medium", kind: "ask_user" }
    ];
  }
  if (family === "project_check") {
    return [
      { title: "Inspect manifest-like and test-like paths", summary: "Use core tools to inspect structured files and test-like paths before choosing any runner.", groundingFactIds: groundingFacts, riskLevel: "low", kind: "current_tools_only" },
      { title: "Project check execution preview", summary: "A project check capability may be prepared for a later reviewed execution preview.", groundingFactIds: groundingFacts, riskLevel: "low", kind: "shell_preview" },
      { title: "Ask for project check boundary", summary: "Ask the user how this workspace should run checks before creating shell or tool proposals.", groundingFactIds: groundingFacts, riskLevel: "low", kind: "ask_user" }
    ];
  }
  return [
    { title: "Ask user for capability boundary", summary: "Clarify what capability is needed before creating shell or tool proposals.", groundingFactIds: groundingFacts, riskLevel: "low", kind: "ask_user" }
  ];
}

function recommendNextStep(family: CapabilityFamily, hasCrossGrounding: boolean): CapabilityProposal["recommendedNextStep"] {
  if (family === "search_observation") {
    return "current_tools_only";
  }
  if (family === "unknown") {
    return "ignore";
  }
  if ((family === "project_check" || family === "runtime_execution") && hasCrossGrounding) {
    return "shell_preview";
  }
  return "ask_user";
}

function formatFactKindSummary(facts: EnvironmentFact[], warnings: EnvironmentScanWarning[]): string {
  const counts = new Map<EnvironmentFactKind, number>();
  for (const fact of facts) counts.set(fact.kind, (counts.get(fact.kind) ?? 0) + 1);
  return [
    `Top-level entries: ${counts.get("top_level_entry") ?? 0}`,
    `Hidden entries: ${counts.get("hidden_entry") ?? 0}`,
    `Manifest-like files: ${counts.get("manifest_like_file") ?? 0}`,
    `Config-like files: ${counts.get("config_like_file") ?? 0}`,
    `Lock-like files: ${counts.get("lock_like_file") ?? 0}`,
    `Test-like paths: ${counts.get("test_like_path") ?? 0}`,
    `Script-like keys: ${counts.get("script_like_key") ?? 0}`,
    `README summaries: ${counts.get("readme_summary") ?? 0}`,
    `Warnings: ${warnings.length}`
  ].join("\n");
}

function formatFact(fact: EnvironmentFact): string {
  const parts = [`- ${fact.id}`, fact.kind];
  if (fact.path) parts.push(fact.path);
  if (fact.keys?.length) parts.push(`keys:${fact.keys.join(",")}`);
  if (fact.summary) parts.push(fact.summary.replace(/\s+/g, " ").slice(0, 120));
  return parts.join(" | ");
}

function formatWarning(warning: EnvironmentScanWarning): string {
  const parts = [`- ${warning.id}`, warning.kind];
  if (warning.path) parts.push(warning.path);
  parts.push(warning.message);
  return parts.join(" | ");
}

function formatCapabilityProposalCompact(proposal: CapabilityProposal): string {
  return [
    `${proposal.id}\t${proposal.status}\t${proposal.capabilityFamily}\trisk:${proposal.riskLevel}\tconfidence:${proposal.confidence}`,
    `Need: ${proposal.userNeed}`,
    `Next: ${proposal.recommendedNextStep}`,
    `Source scan: ${proposal.sourceScanId}`,
    `Grounding: ${proposal.groundingFactIds.join(", ") || "none"}`
  ].join("\n");
}

function publicScan(scan: EnvironmentScan): Record<string, unknown> {
  return {
    observedAt: scan.observedAt,
    scanId: scan.scanId
  };
}

function publicFact(fact: EnvironmentFact): Record<string, unknown> {
  return {
    id: fact.id,
    keys: fact.keys,
    kind: fact.kind,
    observedAt: fact.observedAt,
    path: fact.path,
    scanId: fact.scanId,
    summary: fact.summary
  };
}

function publicWarning(warning: EnvironmentScanWarning): Record<string, unknown> {
  return {
    id: warning.id,
    kind: warning.kind,
    message: warning.message,
    path: warning.path,
    scanId: warning.scanId
  };
}

function selectFactsByIds(facts: EnvironmentFact[], ids: string[]): EnvironmentFact[] {
  const wanted = new Set(ids);
  return sortFacts(facts.filter((fact) => wanted.has(fact.id)));
}

function normalizeFactFromRow(recordJson: string, scanId: string, observedAt: string): EnvironmentFact {
  const parsed = JSON.parse(recordJson) as Partial<EnvironmentFact>;
  return {
    id: parsed.id ?? factId("fact"),
    scanId: parsed.scanId ?? scanId,
    kind: environmentFactKindSchema.safeParse(parsed.kind).success ? parsed.kind as EnvironmentFactKind : "top_level_entry",
    path: parsed.path ? redactPath(parsed.path) : undefined,
    summary: parsed.summary ? redactText(parsed.summary) : undefined,
    keys: parsed.keys ? sanitizeKeys(parsed.keys) : undefined,
    observedAt: parsed.observedAt ?? observedAt
  };
}

function normalizeStoredProposal(recordJson: string): CapabilityProposal {
  const parsed = JSON.parse(recordJson) as Partial<CapabilityProposal> & { groundingFacts?: string[] };
  return normalizeCapabilityProposal({
    id: parsed.id ?? `cap_${randomUUID().slice(0, 8)}`,
    sourceScanId: parsed.sourceScanId ?? legacyEnvironmentScanId,
    userNeed: parsed.userNeed ? redactText(parsed.userNeed) : "Unknown capability need.",
    capabilityFamily: capabilityFamilySchema.safeParse(parsed.capabilityFamily).success ? parsed.capabilityFamily as CapabilityFamily : "unknown",
    groundingFactIds: parsed.groundingFactIds ?? parsed.groundingFacts ?? [],
    hypotheses: parsed.hypotheses ?? [],
    possibleApproaches: parsed.possibleApproaches ?? [],
    recommendedNextStep: capabilityNextStepSchema.safeParse(parsed.recommendedNextStep).success ? parsed.recommendedNextStep as z.infer<typeof capabilityNextStepSchema> : "ask_user",
    riskLevel: parsed.riskLevel === "medium" || parsed.riskLevel === "high" ? parsed.riskLevel : "low",
    confidence: parsed.confidence === "medium" || parsed.confidence === "high" ? parsed.confidence : "low",
    status: capabilityStatusSchema.safeParse(parsed.status).success ? parsed.status as z.infer<typeof capabilityStatusSchema> : "pending",
    discardedAt: parsed.discardedAt,
    discardReason: parsed.discardReason
  });
}

function sortFacts(facts: EnvironmentFact[]): EnvironmentFact[] {
  return facts.slice().sort((a, b) => compareNullable(a.kind, b.kind) || compareNullable(a.path, b.path) || a.id.localeCompare(b.id));
}

function sortWarnings(warnings: EnvironmentScanWarning[]): EnvironmentScanWarning[] {
  return warnings.slice().sort((a, b) => compareNullable(a.kind, b.kind) || compareNullable(a.path, b.path) || a.id.localeCompare(b.id));
}

function compareNullable(left: string | undefined, right: string | undefined): number {
  return (left ?? "").localeCompare(right ?? "");
}

function factId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function createScanId(date: Date): string {
  const stamp = date.toISOString().replace(/[-:.]/g, "");
  return `scan_${stamp}_${randomBytes(3).toString("hex")}`;
}

function addFact(context: DiscoveryContext, input: Omit<EnvironmentFact, "id" | "scanId" | "observedAt">): void {
  context.facts.push({
    id: factId(input.kind.replace(/_.*$/, "")),
    scanId: context.scan.scanId,
    kind: input.kind,
    path: input.path ? redactPath(toWorkspaceRelative(context.scan.workspaceRoot, resolve(context.scan.workspaceRoot, input.path))) : undefined,
    summary: input.summary ? redactText(input.summary) : undefined,
    keys: input.keys ? sanitizeKeys(input.keys) : undefined,
    observedAt: context.scan.observedAt
  });
}

function addWarning(context: DiscoveryContext, kind: EnvironmentScanWarningKind, relPath: string | undefined, message: string): void {
  context.warnings.push({
    id: factId("warn"),
    scanId: context.scan.scanId,
    kind,
    path: relPath ? redactPath(relPath) : undefined,
    message: redactText(message),
    createdAt: context.scan.observedAt
  });
}

function addSkippedDirectoryWarning(context: DiscoveryContext, relPath: string, category: string): void {
  const count = context.skippedDirectoryCounts.get(category) ?? 0;
  context.skippedDirectoryCounts.set(category, count + 1);
  if (count === 0) {
    addWarning(context, "skipped_directory", relPath, `${category} skipped.`);
  }
}

function addSkippedDirectorySummaries(context: DiscoveryContext): void {
  for (const [category, count] of context.skippedDirectoryCounts.entries()) {
    if (count > 1) {
      addWarning(context, "skipped_directory", undefined, `${category} skipped ${count} times.`);
    }
  }
}

function joinRel(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function toWorkspaceRelative(workspaceRoot: string, absPath: string): string {
  const rel = relative(workspaceRoot, absPath).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") ? rel : basename(absPath);
}

function isInsideWorkspace(workspaceRoot: string, target: string): boolean {
  const rel = relative(workspaceRoot, target);
  return rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith(".."));
}

function isHiddenOrMetaLooking(name: string): boolean {
  return name.startsWith(".") || /^_(?!_)/.test(name);
}

function skipDirectoryReason(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (/^(node_modules|vendor|third_party|packages-cache)$/.test(lower)) return "Dependency-like directory";
  if (/^(\.cache|cache|\.turbo|\.next|\.vite|coverage|logs?)$/.test(lower)) return "Cache/state-like directory";
  if (/^(dist|build|out|target|bin|obj)$/.test(lower)) return "Build-like directory";
  if (/^(\.cosia-gateway|sessions|memory)$/.test(lower)) return "Runtime state-like directory";
  return undefined;
}

function isReadmeLike(path: string): boolean {
  return /^readme(?:[._-]|$)/i.test(basename(path));
}

function isLockLike(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name.endsWith(".lock") || /\b(lock|checksum|integrity|freeze)\b/.test(name);
}

function isConfigLike(path: string): boolean {
  const name = basename(path).toLowerCase();
  return /\b(config|settings|rc|env)\b/.test(name)
    || [".ini", ".conf", ".cfg", ".yaml", ".yml"].includes(extname(name));
}

function isStructuredCandidate(path: string): boolean {
  return [".json", ".toml", ".yaml", ".yml", ".xml", ".props", ".targets", ".csproj", ".fsproj", ".vbproj"].includes(extname(path).toLowerCase());
}

function isTestLike(path: string): boolean {
  return /(^|\/|\\)(__tests__|tests?|specs?)(\/|\\|$)/i.test(path) || /\.(test|spec)\./i.test(path);
}

function extractTextKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/).slice(0, 80)) {
    const match = /^\s*([A-Za-z0-9_.-]{2,})\s*[:=]/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys.slice(0, 20);
}

function commandMapLikeKeys(record: JsonRecord): string[] {
  const keys: string[] = [];
  for (const [sectionName, sectionValue] of Object.entries(record)) {
    if (!/scripts?|tasks?|commands?|targets?|jobs?|checks?|hooks?/i.test(sectionName)) {
      continue;
    }
    if (!sectionValue || typeof sectionValue !== "object" || Array.isArray(sectionValue)) {
      continue;
    }
    for (const [key, value] of Object.entries(sectionValue as JsonRecord)) {
      if (typeof value === "string") keys.push(key);
    }
  }
  return sanitizeKeys(keys);
}

function sanitizeKeys(keys: string[]): string[] {
  return [...new Set(keys.map(redactKey).filter(Boolean))].sort().slice(0, 20);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function sanitizeCapabilityText(value: string, fallback: string): string {
  const redacted = redactText(value).replace(/\s+/g, " ").trim();
  if (!redacted || concreteToolNamePattern.test(redacted) || commandLikePhrasePattern.test(redacted)) {
    return fallback;
  }
  return redacted;
}

function redactKey(key: string): string {
  return secretNamePattern.test(key) ? "[REDACTED_KEY]" : redactText(key);
}

function redactPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => secretNamePattern.test(segment) ? "[REDACTED]" : redactText(segment))
    .join("/");
}

function redactText(value: string): string {
  let redacted = value;
  for (const pattern of secretValuePatterns) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

const secretNamePattern = /(api[_ -]?key|token|secret|password|credential|private[_ -]?key)/i;
const concreteToolNamePattern = /\b(git|npm|pnpm|yarn|bun|python|pip|pytest|cargo|dotnet)\b/i;
const commandLikePhrasePattern = /\b(run|use|execute|invoke|call|실행|사용)\s+["']?[A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.:-]+){0,4}/i;
const secretValuePatterns = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(password|token|api[_ -]?key|secret|private[_ -]?key)\s*[:=]\s*["']?[^"'\s]{4,}/gi,
  /\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g
];
