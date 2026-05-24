import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CapabilityPlanner } from "./capability.js";
import {
  formatToolActivation,
  formatToolCandidate,
  formatToolCandidateTestRun,
  ToolAcquisitionManager,
  type ToolActivationRecord,
  type ToolCandidateRecord,
  type ToolCandidateTestRun,
  type ToolDraftResult
} from "./tool_acquisition.js";

export type ToolGrowthRoutineStatus =
  | "candidate_ready"
  | "test_passed"
  | "test_failed"
  | "awaiting_activation"
  | "activated"
  | "rejected"
  | "cancelled";

export type ToolGrowthRoutine = {
  id: string;
  sourceRequest: string;
  sourceScanId?: string;
  sourceCapabilityId?: string;
  draftIds: string[];
  candidateIds: string[];
  selectedCandidateId?: string;
  targetAgentId?: string;
  providerId?: string;
  status: ToolGrowthRoutineStatus;
  attemptCount: number;
  evidence: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  reason?: string;
};

export type ToolGrowthStartResult = {
  routine: ToolGrowthRoutine;
  draftResult: ToolDraftResult;
};

export type ToolGrowthTestResult = {
  routine: ToolGrowthRoutine;
  testRun: ToolCandidateTestRun;
};

export type ToolGrowthActivationResult = {
  routine: ToolGrowthRoutine;
  activation: ToolActivationRecord;
  candidateApproved: boolean;
};

export type ToolGrowthFormatOptions = {
  advanced?: boolean;
};

type StartOptions = {
  request: string;
  agentId?: string;
  providerId?: string;
  rawDraft?: Record<string, unknown>;
};

type RetryOptions = {
  providerId?: string;
  rawDraft?: Record<string, unknown>;
};

export class ToolGrowthManager {
  constructor(private readonly workspaceRoot: string) {}

  async start(options: StartOptions): Promise<ToolGrowthStartResult> {
    const request = options.request.trim();
    if (!request) {
      throw new Error("Tool growth request is required.");
    }
    const planner = new CapabilityPlanner(this.workspaceRoot);
    const scan = await planner.scan({ userNeed: request });
    const plan = planner.plan({ userNeed: request });
    const acquisition = new ToolAcquisitionManager(this.workspaceRoot);
    const draftResult = await acquisition.draftFromCapability(plan.proposal.id, {
      providerId: options.providerId,
      rawDraft: options.rawDraft
    });
    const now = new Date().toISOString();
    const routine = normalizeRoutine({
      id: `grow_${randomUUID().slice(0, 8)}`,
      sourceRequest: request,
      sourceScanId: scan.scan.scanId,
      sourceCapabilityId: plan.proposal.id,
      draftIds: [draftResult.draft.id],
      candidateIds: draftResult.candidate ? [draftResult.candidate.id] : [],
      selectedCandidateId: draftResult.candidate?.id,
      targetAgentId: options.agentId,
      providerId: options.providerId,
      status: draftResult.candidate ? "candidate_ready" : "rejected",
      attemptCount: 1,
      evidence: {
        source: "tool_grow_start",
        proposalId: plan.proposal.id,
        draftId: draftResult.draft.id,
        candidateId: draftResult.candidate?.id,
        normalizationWarnings: draftResult.warnings,
        candidateNotCreatedReason: draftResult.reason
      },
      createdAt: now,
      updatedAt: now,
      completedAt: draftResult.candidate ? undefined : now,
      reason: draftResult.candidate ? undefined : (draftResult.reason ?? "candidate_not_created")
    });
    this.saveRoutine(routine);
    return { routine, draftResult };
  }

  list(options: { all?: boolean } = {}): ToolGrowthRoutine[] {
    return withGrowthDb(this.workspaceRoot, (db) => {
      const rows = options.all
        ? db.prepare("SELECT record_json FROM tool_growth_routines ORDER BY updated_at DESC").all() as Array<{ record_json: string }>
        : db.prepare("SELECT record_json FROM tool_growth_routines WHERE status NOT IN ('rejected', 'cancelled', 'activated') ORDER BY updated_at DESC").all() as Array<{ record_json: string }>;
      return rows.map((row) => normalizeRoutine(JSON.parse(row.record_json) as ToolGrowthRoutine));
    });
  }

  get(id: string): ToolGrowthRoutine {
    const routine = withGrowthDb(this.workspaceRoot, (db) => {
      const row = db.prepare("SELECT record_json FROM tool_growth_routines WHERE id = ?").get(id) as { record_json: string } | undefined;
      return row ? normalizeRoutine(JSON.parse(row.record_json) as ToolGrowthRoutine) : undefined;
    });
    if (!routine) {
      throw new Error(`Tool growth routine not found: ${id}`);
    }
    return routine;
  }

  async test(id: string, options: { yes?: boolean } = {}): Promise<ToolGrowthTestResult> {
    if (!options.yes) {
      throw new Error("Tool growth test requires --yes.");
    }
    const routine = this.assertRoutineCanContinue(this.get(id));
    if (!routine.selectedCandidateId) {
      throw new Error(`Tool growth routine has no selected candidate: ${routine.id}`);
    }
    const acquisition = new ToolAcquisitionManager(this.workspaceRoot);
    const testRun = await acquisition.testCandidate(routine.selectedCandidateId);
    const now = new Date().toISOString();
    const next = normalizeRoutine({
      ...routine,
      status: testRun.status === "passed" ? "awaiting_activation" : "test_failed",
      updatedAt: now,
      evidence: appendEvidenceArray(routine.evidence, "testRuns", {
        id: testRun.id,
        candidateId: testRun.candidateId,
        status: testRun.status,
        candidateContentHash: testRun.candidateContentHash,
        testedAt: testRun.testedAt
      })
    });
    this.saveRoutine(next);
    return { routine: next, testRun };
  }

  async activate(id: string, options: { agentId?: string; yes?: boolean } = {}): Promise<ToolGrowthActivationResult> {
    if (!options.yes) {
      throw new Error("Tool growth activation requires --yes.");
    }
    const routine = this.assertRoutineCanContinue(this.get(id));
    if (routine.status !== "test_passed" && routine.status !== "awaiting_activation") {
      throw new Error(`Tool growth routine is not ready for activation: ${routine.status}`);
    }
    if (!routine.selectedCandidateId) {
      throw new Error(`Tool growth routine has no selected candidate: ${routine.id}`);
    }
    const targetAgentId = options.agentId ?? routine.targetAgentId;
    if (!targetAgentId) {
      throw new Error("Tool growth activation requires --agent <agent-id>.");
    }
    const acquisition = new ToolAcquisitionManager(this.workspaceRoot);
    const before = acquisition.getCandidate(routine.selectedCandidateId);
    let candidateApproved = false;
    if (before.status !== "approved") {
      acquisition.approveCandidate(before.id);
      candidateApproved = true;
    }
    try {
      const activation = await acquisition.activateCandidate(before.id, targetAgentId, { yes: true });
      const now = new Date().toISOString();
      const next = normalizeRoutine({
        ...routine,
        targetAgentId,
        status: "activated",
        updatedAt: now,
        completedAt: now,
        evidence: appendEvidenceArray(routine.evidence, "activations", {
          id: activation.id,
          toolId: activation.toolId,
          status: activation.status,
          candidateApproved
        })
      });
      this.saveRoutine(next);
      return { routine: next, activation, candidateApproved };
    } catch (error) {
      const now = new Date().toISOString();
      const next = normalizeRoutine({
        ...routine,
        targetAgentId,
        status: "awaiting_activation",
        updatedAt: now,
        evidence: appendEvidenceArray(routine.evidence, "activationFailures", {
          candidateId: before.id,
          error: (error as Error).message,
          failedAt: now,
          candidateApproved
        })
      });
      this.saveRoutine(next);
      throw error;
    }
  }

  reject(id: string, reason: string): ToolGrowthRoutine {
    const routine = this.assertRoutineCanContinue(this.get(id));
    const redactedReason = reason.trim() || "rejected";
    const candidateMutation = this.rejectSelectedCandidate(routine, redactedReason);
    const now = new Date().toISOString();
    const next = normalizeRoutine({
      ...routine,
      status: "rejected",
      updatedAt: now,
      completedAt: now,
      reason: redactedReason,
      evidence: appendEvidenceArray(routine.evidence, "rejections", {
        reason: redactedReason,
        candidateId: routine.selectedCandidateId,
        candidateMutation
      })
    });
    this.saveRoutine(next);
    return next;
  }

  async retry(id: string, options: RetryOptions = {}): Promise<ToolGrowthStartResult> {
    const routine = this.get(id);
    if (routine.status === "activated" || routine.status === "cancelled") {
      throw new Error(`Tool growth routine cannot be retried from status: ${routine.status}`);
    }
    if (!routine.sourceCapabilityId) {
      throw new Error(`Tool growth routine has no source capability: ${routine.id}`);
    }
    const acquisition = new ToolAcquisitionManager(this.workspaceRoot);
    const draftResult = await acquisition.draftFromCapability(routine.sourceCapabilityId, {
      providerId: options.providerId ?? routine.providerId,
      rawDraft: options.rawDraft
    });
    const now = new Date().toISOString();
    const next = normalizeRoutine({
      ...routine,
      draftIds: [...routine.draftIds, draftResult.draft.id],
      candidateIds: draftResult.candidate ? [...routine.candidateIds, draftResult.candidate.id] : routine.candidateIds,
      selectedCandidateId: draftResult.candidate?.id ?? routine.selectedCandidateId,
      providerId: options.providerId ?? routine.providerId,
      status: draftResult.candidate ? "candidate_ready" : "rejected",
      attemptCount: routine.attemptCount + 1,
      updatedAt: now,
      completedAt: draftResult.candidate ? undefined : now,
      reason: draftResult.candidate ? undefined : (draftResult.reason ?? "candidate_not_created"),
      evidence: appendEvidenceArray(routine.evidence, "retryAttempts", {
        previousStatus: routine.status,
        previousReason: routine.reason,
        previousSelectedCandidateId: routine.selectedCandidateId,
        draftId: draftResult.draft.id,
        candidateId: draftResult.candidate?.id,
        warnings: draftResult.warnings,
        reason: draftResult.reason
      })
    });
    this.saveRoutine(next);
    return { routine: next, draftResult };
  }

  cancel(id: string, reason: string): ToolGrowthRoutine {
    const routine = this.get(id);
    if (routine.status === "activated") {
      throw new Error("Activated tool growth routines cannot be cancelled.");
    }
    if (routine.status === "cancelled") {
      return routine;
    }
    const redactedReason = reason.trim() || "cancelled";
    const candidateMutation = this.discardSelectedCandidate(routine, redactedReason);
    const now = new Date().toISOString();
    const next = normalizeRoutine({
      ...routine,
      status: "cancelled",
      updatedAt: now,
      completedAt: now,
      reason: redactedReason,
      evidence: appendEvidenceArray(routine.evidence, "cancellations", {
        reason: redactedReason,
        candidateId: routine.selectedCandidateId,
        candidateMutation
      })
    });
    this.saveRoutine(next);
    return next;
  }

  private rejectSelectedCandidate(routine: ToolGrowthRoutine, reason: string): Record<string, unknown> {
    if (!routine.selectedCandidateId) {
      return { status: "skipped", reason: "no selected candidate" };
    }
    try {
      const candidate = new ToolAcquisitionManager(this.workspaceRoot).rejectCandidate(routine.selectedCandidateId, reason);
      return { status: "rejected", candidateId: candidate.id };
    } catch (error) {
      return { status: "preserved", reason: (error as Error).message };
    }
  }

  private discardSelectedCandidate(routine: ToolGrowthRoutine, reason: string): Record<string, unknown> {
    if (!routine.selectedCandidateId) {
      return { status: "skipped", reason: "no selected candidate" };
    }
    try {
      const candidate = new ToolAcquisitionManager(this.workspaceRoot).discardCandidate(routine.selectedCandidateId, reason);
      return { status: "discarded", candidateId: candidate.id };
    } catch (error) {
      return { status: "preserved", reason: (error as Error).message };
    }
  }

  private assertRoutineCanContinue(routine: ToolGrowthRoutine): ToolGrowthRoutine {
    if (routine.status === "activated" || routine.status === "cancelled" || routine.status === "rejected") {
      throw new Error(`Tool growth routine is closed: ${routine.status}`);
    }
    return routine;
  }

  private saveRoutine(routine: ToolGrowthRoutine): void {
    withGrowthDb(this.workspaceRoot, (db) => insertRoutine(db, routine));
  }
}

export function formatToolGrowthStart(result: ToolGrowthStartResult, options: ToolGrowthFormatOptions = {}): string {
  const candidateReady = Boolean(result.draftResult.candidate);
  const lines = [
    `Tool growth routine created: ${result.routine.id}`,
    `Request: ${result.routine.sourceRequest}`,
    candidateReady ? "Reusable tool candidate: ready for review and test." : "Reusable tool candidate: not created.",
    `Status: ${result.routine.status}`
  ];
  if (!candidateReady) {
    lines.push(`Reason: ${result.draftResult.reason ?? "normalizer rejected the draft"}`);
  }
  if (options.advanced) {
    lines.push(
      "",
      "Advanced details:",
      result.routine.sourceScanId ? `  Source scan: ${result.routine.sourceScanId}` : "  Source scan: -",
      result.routine.sourceCapabilityId ? `  Capability proposal: ${result.routine.sourceCapabilityId}` : "  Capability proposal: -",
      `  Draft: ${result.draftResult.draft.id}`,
      `  Candidate: ${result.draftResult.candidate?.id ?? "-"}`,
      `  Normalization warnings: ${result.draftResult.warnings.length}`
    );
  }
  lines.push("");
  if (candidateReady) {
    lines.push("Next:");
    lines.push(`  cosia tool grow test ${result.routine.id} --yes`);
    lines.push(`  cosia tool grow show ${result.routine.id}`);
  } else {
    lines.push("Next:");
    lines.push(`  cosia tool grow retry ${result.routine.id}`);
    lines.push(`  cosia tool grow cancel ${result.routine.id} --reason "<reason>"`);
  }
  return lines.join("\n");
}

export function formatToolGrowthReview(routines: ToolGrowthRoutine[], options: ToolGrowthFormatOptions = {}): string {
  if (!routines.length) {
    return "No tool growth routines.";
  }
  return routines.map((routine) => {
    const lines = [
      `${routine.id}\t${routine.status}\tattempts:${routine.attemptCount}`,
      `Request: ${routine.sourceRequest}`,
      `Next: ${nextToolGrowthAction(routine)}`
    ];
    if (options.advanced) {
      lines.push(
        `Selected candidate: ${routine.selectedCandidateId ?? "-"}`,
        `Source capability: ${routine.sourceCapabilityId ?? "-"}`,
        `Evidence keys: ${Object.keys(routine.evidence).sort().join(", ") || "-"}`
      );
    }
    return lines.join("\n");
  }).join("\n\n");
}

export function formatToolGrowthRoutine(
  routine: ToolGrowthRoutine,
  candidate?: ToolCandidateRecord,
  options: ToolGrowthFormatOptions = {}
): string {
  const lines = [
    `Tool growth routine: ${routine.id}`,
    `Request: ${routine.sourceRequest}`,
    `Status: ${routine.status}`,
    `Attempts: ${routine.attemptCount}`,
    `Reusable tool candidate: ${routine.selectedCandidateId ? "present" : "not available"}`,
    routine.reason ? `Reason: ${routine.reason}` : undefined,
    "",
    "Next:",
    `  ${nextToolGrowthAction(routine)}`
  ].filter((line): line is string => line !== undefined);
  if (options.advanced) {
    lines.push(...[
      "",
      "Advanced details:",
      routine.sourceScanId ? `Source scan: ${routine.sourceScanId}` : "Source scan: -",
      routine.sourceCapabilityId ? `Capability proposal: ${routine.sourceCapabilityId}` : "Capability proposal: -",
      routine.providerId ? `Provider: ${routine.providerId}` : undefined,
      routine.targetAgentId ? `Target agent: ${routine.targetAgentId}` : undefined,
      `Drafts: ${routine.draftIds.join(", ") || "-"}`,
      `Candidates: ${routine.candidateIds.join(", ") || "-"}`,
      `Selected candidate: ${routine.selectedCandidateId ?? "-"}`,
      `Evidence keys: ${Object.keys(routine.evidence).sort().join(", ") || "-"}`
    ].filter((line): line is string => line !== undefined));
    if (candidate) {
      lines.push("", formatToolCandidate(candidate));
    }
  }
  return lines.join("\n");
}

export function formatToolGrowthTest(result: ToolGrowthTestResult, options: ToolGrowthFormatOptions = {}): string {
  const passed = result.testRun.status === "passed";
  const lines = [
    passed ? "Tool candidate test passed." : "Tool candidate test failed.",
    `Routine: ${result.routine.id}`,
    `Status: ${result.routine.status}`,
    "",
    passed
      ? [
          "Next:",
          `  cosia tool grow activate ${result.routine.id} --agent <agent-id> --yes`
        ].join("\n")
      : [
          "Next:",
          `  cosia tool grow retry ${result.routine.id}`,
          `  cosia tool grow cancel ${result.routine.id} --reason "<reason>"`
        ].join("\n")
  ];
  if (options.advanced) {
    lines.push("", "Advanced details:", formatToolCandidateTestRun(result.testRun));
  }
  return lines.join("\n");
}

export function formatToolGrowthActivation(result: ToolGrowthActivationResult): string {
  return [
    "Candidate design approved.",
    "Active tool registration applied.",
    `Routine: ${result.routine.id}`,
    `Tool: ${result.activation.toolId}`,
    `Status: ${result.routine.status}`,
    "",
    formatToolActivation(result.activation)
  ].join("\n");
}

export function formatToolGrowthRejected(routine: ToolGrowthRoutine): string {
  return [
    "Candidate rejected and preserved as evidence.",
    `Routine: ${routine.id}`,
    `Reason: ${routine.reason ?? "rejected"}`,
    "Next:",
    `  cosia tool grow retry ${routine.id}`,
    `  cosia tool grow cancel ${routine.id} --reason "<reason>"`
  ].join("\n");
}

export function formatToolGrowthCancelled(routine: ToolGrowthRoutine): string {
  return [
    "Tool growth routine cancelled and preserved as evidence.",
    `Routine: ${routine.id}`,
    `Reason: ${routine.reason ?? "cancelled"}`
  ].join("\n");
}

function nextToolGrowthAction(routine: ToolGrowthRoutine): string {
  if (routine.status === "candidate_ready") {
    return `cosia tool grow test ${routine.id} --yes`;
  }
  if (routine.status === "test_failed") {
    return `cosia tool grow retry ${routine.id}`;
  }
  if (routine.status === "test_passed" || routine.status === "awaiting_activation") {
    return `cosia tool grow activate ${routine.id} --agent <agent-id> --yes`;
  }
  if (routine.status === "rejected") {
    return `cosia tool grow retry ${routine.id}`;
  }
  if (routine.status === "cancelled") {
    return "closed; no further action";
  }
  if (routine.status === "activated") {
    return "active tool registration already applied";
  }
  return "inspect routine";
}

function withGrowthDb<T>(workspaceRoot: string, fn: (db: DatabaseSync) => T): T {
  const memoryDir = join(workspaceRoot, "memory");
  mkdirSync(memoryDir, { recursive: true });
  const db = new DatabaseSync(join(memoryDir, "longterm.sqlite"));
  try {
    ensureGrowthTables(db);
    return fn(db);
  } finally {
    db.close();
  }
}

function ensureGrowthTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_growth_routines (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      source_request TEXT NOT NULL,
      selected_candidate_id TEXT,
      source_capability_id TEXT,
      target_agent_id TEXT,
      provider_id TEXT,
      attempt_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_growth_routines_status ON tool_growth_routines(status);
    CREATE INDEX IF NOT EXISTS idx_tool_growth_routines_updated_at ON tool_growth_routines(updated_at);
  `);
}

function insertRoutine(db: DatabaseSync, routine: ToolGrowthRoutine): void {
  db.prepare(`
    INSERT OR REPLACE INTO tool_growth_routines (
      id,
      status,
      source_request,
      selected_candidate_id,
      source_capability_id,
      target_agent_id,
      provider_id,
      attempt_count,
      created_at,
      updated_at,
      completed_at,
      record_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    routine.id,
    routine.status,
    routine.sourceRequest,
    routine.selectedCandidateId ?? null,
    routine.sourceCapabilityId ?? null,
    routine.targetAgentId ?? null,
    routine.providerId ?? null,
    routine.attemptCount,
    routine.createdAt,
    routine.updatedAt,
    routine.completedAt ?? null,
    JSON.stringify(routine)
  );
}

function normalizeRoutine(routine: ToolGrowthRoutine): ToolGrowthRoutine {
  return {
    ...routine,
    draftIds: routine.draftIds ?? [],
    candidateIds: routine.candidateIds ?? [],
    attemptCount: routine.attemptCount ?? 0,
    evidence: routine.evidence ?? {}
  };
}

function appendEvidenceArray(
  evidence: Record<string, unknown>,
  key: string,
  value: Record<string, unknown>
): Record<string, unknown> {
  const existing = Array.isArray(evidence[key]) ? evidence[key] as unknown[] : [];
  return {
    ...evidence,
    [key]: [...existing, value]
  };
}
