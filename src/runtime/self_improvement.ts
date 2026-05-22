import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { MemoryManager, type CandidateReview, type MemoryReviewSummary } from "./memory_manager.js";
import { PolicyAuditLog } from "./policy_audit.js";
import type { PolicyConfig } from "./policy_manager.js";
import { detectSecrets } from "./risk_classifier.js";
import { SkillManager } from "./skill_manager.js";
import type { MemoryCandidateRecord, PolicyAuditEvent, RiskLevel, SessionMetadata, SkillCandidateRecord } from "./types.js";

export type ImprovementType = "memory_auto_promote" | "skill_auto_promote" | "tool_recommendation";
export type ImprovementStatus = "previewed" | "applied" | "blocked" | "discarded" | "reverted" | "apply_failed" | "revert_failed";

export type ImprovementRecord = {
  id: string;
  type: ImprovementType;
  status: ImprovementStatus;
  riskLevel: RiskLevel;
  sourceRunId?: string;
  sourceSessionId?: string;
  sourceAgentId?: string;
  sourceCandidateId?: string;
  targetId?: string;
  evaluationHash?: string;
  rationale: string;
  policySnapshot: Record<string, unknown>;
  evidence: Record<string, unknown>;
  createdAt: string;
  appliedAt?: string;
  revertedAt?: string;
  discardedAt?: string;
  reason?: string;
};

export type ImprovementDecision = {
  type: ImprovementType;
  sourceCandidateId?: string;
  sourceRunId?: string;
  sourceSessionId?: string;
  sourceAgentId?: string;
  riskLevel: RiskLevel;
  eligible: boolean;
  rationale: string;
  evidence: Record<string, unknown>;
  memoryCandidate?: MemoryCandidateRecord;
  skillCandidate?: SkillCandidateRecord;
};

export type ImprovementPreview = {
  evaluationHash: string;
  evaluatedAt: string;
  decisions: ImprovementDecision[];
};

export type ImprovementApplyResult = {
  evaluationHash: string;
  reEvaluatedAt: string;
  applied: ImprovementRecord[];
  blocked: ImprovementRecord[];
  failed: ImprovementRecord[];
  memorySummary?: MemoryReviewSummary;
};

export type ImprovementStatusReport = {
  preview: ImprovementPreview;
  records: ImprovementRecord[];
};

type ImprovementRow = {
  record_json: string;
};

const recommendationReasons = new Set([
  "tool.not_registered",
  "tool.config_disabled",
  "tool.not_allowed_for_agent",
  "permission.disabled"
]);

export class SelfImprovementGovernor {
  private readonly memory: MemoryManager;
  private readonly skills: SkillManager;
  private readonly audit: PolicyAuditLog;
  private readonly dbPath: string;

  constructor(private readonly workspaceRoot: string) {
    this.memory = new MemoryManager(workspaceRoot);
    this.skills = new SkillManager(workspaceRoot);
    this.audit = new PolicyAuditLog(workspaceRoot);
    this.dbPath = join(workspaceRoot, "memory", "longterm.sqlite");
  }

  ensureSchema(): void {
    const memoryDir = join(this.workspaceRoot, "memory");
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }
    this.memory.ensureSchema();
    this.skills.ensureSchema();
    const db = this.open();
    try {
      ensureImprovementTable(db);
    } finally {
      db.close();
    }
  }

  async status(policy: PolicyConfig): Promise<ImprovementStatusReport> {
    const preview = await this.preview(policy);
    return {
      preview,
      records: this.listRecords(true)
    };
  }

  async preview(policy: PolicyConfig, scope: { memoryCandidates?: MemoryCandidateRecord[]; skillCandidates?: SkillCandidateRecord[] } = {}): Promise<ImprovementPreview> {
    const decisions = await this.evaluate(policy, scope);
    return {
      evaluationHash: evaluationHash(decisions, policySnapshot(policy)),
      evaluatedAt: new Date().toISOString(),
      decisions
    };
  }

  async applyBacklog(policy: PolicyConfig): Promise<ImprovementApplyResult> {
    const preview = await this.preview(policy);
    return this.applyDecisions(preview, policy);
  }

  async afterRun(input: {
    policy: PolicyConfig;
    session: SessionMetadata;
    agentId: string;
    runId: string;
    memoryCandidates: MemoryCandidateRecord[];
    skillCandidates: SkillCandidateRecord[];
  }): Promise<ImprovementApplyResult> {
    const preview = await this.preview(input.policy, {
      memoryCandidates: input.memoryCandidates,
      skillCandidates: input.skillCandidates
    });
    const result = await this.applyDecisions(preview, input.policy);
    await this.recordToolRecommendations(input.session, input.agentId, input.runId, input.policy);
    return result;
  }

  listRecords(includeAll = false): ImprovementRecord[] {
    this.ensureSchema();
    const db = this.open();
    try {
      const rows = db.prepare("SELECT record_json FROM improvement_records ORDER BY created_at ASC, rowid ASC").all() as ImprovementRow[];
      const records = rows.map((row) => JSON.parse(row.record_json) as ImprovementRecord);
      return includeAll ? records : records.filter((record) => record.status !== "discarded");
    } finally {
      db.close();
    }
  }

  getRecord(ref: string): ImprovementRecord {
    const normalized = ref.trim();
    const records = this.listRecords(true);
    const exact = records.find((record) => record.id === normalized);
    if (exact) {
      return exact;
    }
    const matches = records.filter((record) => record.id.startsWith(normalized));
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      throw new Error(`Improvement id prefix is ambiguous: ${ref}. Matches: ${matches.map((record) => record.id).join(", ")}`);
    }
    throw new Error(`Improvement not found: ${ref}`);
  }

  async discard(ref: string, reason: string): Promise<ImprovementRecord> {
    if (!reason.trim()) {
      throw new Error("--reason is required.");
    }
    const record = this.getRecord(ref);
    const updated = {
      ...record,
      status: "discarded" as const,
      discardedAt: new Date().toISOString(),
      reason
    };
    this.upsertRecord(updated);
    return updated;
  }

  async revert(ref: string, reason: string): Promise<ImprovementRecord> {
    if (!reason.trim()) {
      throw new Error("--reason is required.");
    }
    const record = this.getRecord(ref);
    if (record.status !== "applied") {
      throw new Error(`Improvement is not applied: ${ref}`);
    }
    try {
      if (record.type === "memory_auto_promote") {
        const promotionId = typeof record.evidence.memoryPromotionId === "string" ? record.evidence.memoryPromotionId : undefined;
        if (!promotionId) {
          throw new Error("Applied memory improvement has no linked memory promotion id.");
        }
        this.memory.revertPromotion(promotionId, reason);
      } else if (record.type === "skill_auto_promote") {
        if (!record.sourceCandidateId) {
          throw new Error("Applied skill improvement has no source candidate id.");
        }
        this.skills.revertPromotedCandidate(record.sourceCandidateId, reason);
      } else {
        throw new Error("Tool recommendations do not have runtime changes to revert.");
      }
      const updated = {
        ...record,
        status: "reverted" as const,
        revertedAt: new Date().toISOString(),
        reason
      };
      this.upsertRecord(updated);
      return updated;
    } catch (error) {
      const failed = {
        ...record,
        status: "revert_failed" as const,
        reason: `${reason}; failure: ${(error as Error).message}`,
        evidence: redactEvidence({
          ...record.evidence,
          revertFailure: (error as Error).message
        })
      };
      this.upsertRecord(failed);
      throw error;
    }
  }

  private async evaluate(policy: PolicyConfig, scope: { memoryCandidates?: MemoryCandidateRecord[]; skillCandidates?: SkillCandidateRecord[] }): Promise<ImprovementDecision[]> {
    const memoryReviews = scope.memoryCandidates
      ? await this.memory.reviewCandidates(scope.memoryCandidates, { ...policy.memory.autoPromotion, mode: "manual" })
      : undefined;
    const memoryDecisions = memoryReviews
      ? memoryReviews.reviews.map((review) => memoryDecision(review, policy))
      : (await this.memory.reviewPendingCandidates()).map((review) => memoryDecision(review, policy));

    const skillRecords = scope.skillCandidates ?? this.skills.listCandidates(false).map((view) => view.record);
    const skillDecisions = skillRecords.map((candidate) => skillDecision(candidate, this.skills, policy));

    return [...memoryDecisions, ...skillDecisions]
      .sort((left, right) => `${left.type}:${left.sourceCandidateId ?? ""}`.localeCompare(`${right.type}:${right.sourceCandidateId ?? ""}`));
  }

  private async applyDecisions(preview: ImprovementPreview, policy: PolicyConfig): Promise<ImprovementApplyResult> {
    const memoryCandidates = preview.decisions
      .filter((decision) => decision.type === "memory_auto_promote")
      .flatMap((decision) => decision.memoryCandidate)
      .filter((candidate): candidate is MemoryCandidateRecord => Boolean(candidate));
    const memorySummary = memoryCandidates.length
      ? await this.memory.reviewCandidates(memoryCandidates, policy.memory.autoPromotion)
      : undefined;

    const applied: ImprovementRecord[] = [];
    const blocked: ImprovementRecord[] = [];
    const failed: ImprovementRecord[] = [];

    if (memorySummary) {
      for (const review of memorySummary.reviews) {
        const decision = memoryDecision(review, policy);
        if (review.autoPromoted) {
          const record = this.buildRecord(decision, "applied", {
            targetId: review.autoPromoted.promotedMemoryId,
            appliedAt: review.autoPromoted.createdAt,
            evidence: {
              ...decision.evidence,
              memoryPromotionId: review.autoPromoted.id,
              promotedMemoryId: review.autoPromoted.promotedMemoryId
            },
            evaluationHash: preview.evaluationHash
          });
          this.upsertRecord(record);
          applied.push(record);
        } else {
          const record = this.buildRecord(decision, "blocked", { evaluationHash: preview.evaluationHash });
          this.upsertRecord(record);
          blocked.push(record);
        }
      }
    }

    for (const decision of preview.decisions.filter((item) => item.type === "skill_auto_promote")) {
      if (!decision.eligible) {
        const record = this.buildRecord(decision, "blocked", { evaluationHash: preview.evaluationHash });
        this.upsertRecord(record);
        blocked.push(record);
        continue;
      }
      const candidate = decision.skillCandidate;
      if (!candidate) {
        continue;
      }
      try {
        const result = this.skills.promoteCandidate(candidate.id, {
          yes: true,
          preferFor: policy.selfImprovement.skillAutoPromotion.preferForAgent ? candidate.agentId : undefined
        });
        const record = this.buildRecord(decision, "applied", {
          targetId: result.record.promotedSkillId ?? candidate.skillId,
          appliedAt: new Date().toISOString(),
          evaluationHash: preview.evaluationHash,
          evidence: {
            ...decision.evidence,
            skillId: result.record.promotedSkillId ?? candidate.skillId,
            skillPath: result.skillPath,
            metadataPath: result.metadataPath,
            skillsIndexPath: result.skillsIndexPath
          }
        });
        this.upsertRecord(record);
        applied.push(record);
      } catch (error) {
        const failure = this.buildRecord(decision, "apply_failed", {
          evaluationHash: preview.evaluationHash,
          evidence: {
            ...decision.evidence,
            applyFailure: (error as Error).message
          },
          reason: (error as Error).message
        });
        this.upsertRecord(failure);
        failed.push(failure);
      }
    }

    return {
      evaluationHash: preview.evaluationHash,
      reEvaluatedAt: new Date().toISOString(),
      applied,
      blocked,
      failed,
      memorySummary
    };
  }

  private buildRecord(
    decision: ImprovementDecision,
    status: ImprovementStatus,
    extra: Partial<Pick<ImprovementRecord, "targetId" | "appliedAt" | "evaluationHash" | "evidence" | "reason">> = {}
  ): ImprovementRecord {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      type: decision.type,
      status,
      riskLevel: decision.riskLevel,
      sourceRunId: decision.sourceRunId,
      sourceSessionId: decision.sourceSessionId,
      sourceAgentId: decision.sourceAgentId,
      sourceCandidateId: decision.sourceCandidateId,
      targetId: extra.targetId,
      evaluationHash: extra.evaluationHash,
      rationale: decision.rationale,
      policySnapshot: decisionPolicySnapshot(decision),
      evidence: redactEvidence(extra.evidence ?? decision.evidence),
      createdAt: now,
      appliedAt: extra.appliedAt,
      reason: extra.reason
    };
  }

  private async recordToolRecommendations(session: SessionMetadata, agentId: string, runId: string, policy: PolicyConfig): Promise<void> {
    const events = await this.audit.list(session.id, { runId, limit: 100 });
    for (const event of events.filter(isToolRecommendationEvent)) {
      const suggestedAction = recommendationAction(event);
      const dedupeKey = [
        "tool_recommendation",
        event.tool ?? "unknown",
        event.ruleId || event.reason,
        agentId,
        session.id,
        suggestedAction
      ].join("|");
      if (this.hasRecommendation(dedupeKey)) {
        continue;
      }
      const record: ImprovementRecord = {
        id: randomUUID(),
        type: "tool_recommendation",
        status: "blocked",
        riskLevel: "low",
        sourceRunId: runId,
        sourceSessionId: session.id,
        sourceAgentId: agentId,
        targetId: event.tool,
        rationale: `Tool recommendation from denied tool event: ${event.reason}`,
        policySnapshot: redactEvidence({
          disabledPermissions: policy.disabledPermissions
        }),
        evidence: redactEvidence({
          dedupeKey,
          auditEventId: event.id,
          tool: event.tool,
          ruleId: event.ruleId,
          reason: event.reason,
          suggestedAction
        }),
        createdAt: new Date().toISOString()
      };
      this.upsertRecord(record);
    }
  }

  private hasRecommendation(dedupeKey: string): boolean {
    return this.listRecords(true).some((record) => record.type === "tool_recommendation"
      && record.status !== "discarded"
      && record.evidence.dedupeKey === dedupeKey);
  }

  private upsertRecord(record: ImprovementRecord): void {
    this.ensureSchema();
    const db = this.open();
    try {
      upsertImprovementRow(db, record);
    } finally {
      db.close();
    }
  }

  private open(): DatabaseSync {
    return new DatabaseSync(this.dbPath);
  }
}

export function formatImproveStatus(report: ImprovementStatusReport): string {
  const eligible = report.preview.decisions.filter((decision) => decision.eligible);
  const blocked = report.preview.decisions.filter((decision) => !decision.eligible);
  const recordsByStatus = countBy(report.records, (record) => record.status);
  return [
    "COSIA Improvement Status",
    `Evaluation: ${report.preview.evaluationHash}`,
    `Eligible now: ${eligible.length}`,
    `Blocked now: ${blocked.length}`,
    `Records: ${report.records.length}`,
    `Applied: ${recordsByStatus.applied ?? 0}`,
    `Blocked records: ${recordsByStatus.blocked ?? 0}`,
    `Tool recommendations: ${report.records.filter((record) => record.type === "tool_recommendation" && record.status !== "discarded").length}`,
    "",
    "Recommended:",
    "  cosia improve preview",
    "  cosia improve apply --yes"
  ].join("\n");
}

export function formatImprovePreview(preview: ImprovementPreview): string {
  const eligible = preview.decisions.filter((decision) => decision.eligible);
  const blocked = preview.decisions.filter((decision) => !decision.eligible);
  return [
    "COSIA Improvement Preview",
    `Evaluation: ${preview.evaluationHash}`,
    `Evaluated at: ${preview.evaluatedAt}`,
    `Eligible: ${eligible.length}`,
    `Blocked: ${blocked.length}`,
    "",
    ...preview.decisions.map((decision) => `${decision.eligible ? "[ELIGIBLE]" : "[BLOCKED]"} ${decision.type} ${shortId(decision.sourceCandidateId)} ${decision.riskLevel} - ${decision.rationale}`),
    "",
    "Run `cosia improve apply --yes` to re-evaluate and apply eligible improvements."
  ].join("\n");
}

export function formatImproveApply(result: ImprovementApplyResult): string {
  return [
    "COSIA Improvement Apply",
    `Evaluation: ${result.evaluationHash}`,
    `Re-evaluated at: ${result.reEvaluatedAt}`,
    `Applied: ${result.applied.length}`,
    `Blocked: ${result.blocked.length}`,
    `Failed: ${result.failed.length}`,
    ...result.applied.map((record) => `[APPLIED] ${record.type} ${record.id.slice(0, 8)} target:${record.targetId ?? "-"}`),
    ...result.failed.map((record) => `[FAILED] ${record.type} ${record.id.slice(0, 8)} ${record.reason ?? ""}`),
    ...result.blocked.slice(0, 8).map((record) => `[BLOCKED] ${record.type} ${shortId(record.sourceCandidateId)} ${record.rationale}`),
    result.blocked.length > 8 ? `... ${result.blocked.length - 8} more blocked` : ""
  ].filter(Boolean).join("\n");
}

export function formatImproveRecords(records: ImprovementRecord[]): string {
  if (!records.length) {
    return "No improvement records.";
  }
  return [
    "Improvement Records",
    "#  ID        Type                  Status       Risk   Target",
    ...records.map((record, index) => `${String(index + 1).padEnd(2)} ${record.id.slice(0, 8).padEnd(8)}  ${record.type.padEnd(21)} ${record.status.padEnd(12)} ${record.riskLevel.padEnd(6)} ${record.targetId ?? "-"}`)
  ].join("\n");
}

export function formatImprovementDetail(record: ImprovementRecord): string {
  return JSON.stringify(record, null, 2);
}

export function formatImprovementMutation(action: "Discarded" | "Reverted", record: ImprovementRecord): string {
  return `${action} improvement ${record.id}\nStatus: ${record.status}\nReason: ${record.reason ?? "-"}`;
}

function memoryDecision(review: CandidateReview, policy: PolicyConfig): ImprovementDecision {
  const reasons: string[] = [];
  if (policy.memory.autoPromotion.mode === "manual") {
    reasons.push("memory auto promotion disabled by policy");
  }
  if (review.candidate.tier !== "session") {
    reasons.push(`tier ${review.candidate.tier} is not session`);
  }
  if (!policy.memory.autoPromotion.allowRiskLevels.includes(review.classification.riskLevel)) {
    reasons.push(`risk ${review.classification.riskLevel} is not allowed`);
  }
  if (policy.memory.autoPromotion.requireNoConflict && review.conflicts.length) {
    reasons.push(`${review.conflicts.length} conflict(s)`);
  }
  if (review.classification.secretDetection?.matched) {
    reasons.push("secret-like content");
  }
  if (policy.memory.autoPromotion.denyTiers.includes(review.candidate.tier)) {
    reasons.push(`tier ${review.candidate.tier} is denied`);
  }
  if (!policy.memory.autoPromotion.allowTiers.includes(review.candidate.tier)) {
    reasons.push(`tier ${review.candidate.tier} is not in allowed tiers`);
  }
  if (!policy.memory.autoPromotion.allowScopes.includes(review.candidate.scope)) {
    reasons.push(`scope ${review.candidate.scope} is not allowed`);
  }
  if (policy.memory.autoPromotion.denyScopes.includes(review.candidate.scope)) {
    reasons.push(`scope ${review.candidate.scope} is denied`);
  }
  if (policy.memory.autoPromotion.denyKinds.includes(review.candidate.kind.toLowerCase())) {
    reasons.push(`kind ${review.candidate.kind} is denied`);
  }
  return {
    type: "memory_auto_promote",
    sourceCandidateId: review.candidate.id,
    sourceRunId: review.candidate.runId,
    sourceSessionId: review.candidate.sourceSessionId,
    sourceAgentId: review.candidate.sourceAgentId,
    riskLevel: review.classification.riskLevel,
    eligible: reasons.length === 0,
    rationale: reasons.length ? reasons.join("; ") : "low-risk session memory candidate is eligible",
    evidence: redactEvidence({
      candidate: review.candidate,
      conflicts: review.conflicts.map((conflict) => ({ type: conflict.type, targetId: conflict.memory.id })),
      classification: review.classification,
      policy: {
        mode: policy.memory.autoPromotion.mode,
        allowRiskLevels: policy.memory.autoPromotion.allowRiskLevels,
        allowTiers: policy.memory.autoPromotion.allowTiers,
        requireNoConflict: policy.memory.autoPromotion.requireNoConflict
      }
    }),
    memoryCandidate: review.candidate
  };
}

function skillDecision(candidate: SkillCandidateRecord, skills: SkillManager, policy: PolicyConfig): ImprovementDecision {
  const cfg = policy.selfImprovement.skillAutoPromotion;
  const reasons: string[] = [];
  if (!cfg.enabled) {
    reasons.push("skill auto promotion disabled by policy");
  }
  if (!cfg.allowRiskLevels.includes(candidate.riskLevel)) {
    reasons.push(`risk ${candidate.riskLevel} is not allowed`);
  }
  if (cfg.requireTriggers && !candidate.triggers.length) {
    reasons.push("missing trigger");
  }
  const secret = detectSecrets(candidate.content);
  if (cfg.denySecretLike && secret.matched) {
    reasons.push("secret-like content");
  }
  if (candidate.content.length > cfg.maxContentChars) {
    reasons.push(`content exceeds ${cfg.maxContentChars} chars`);
  }
  if (!isSafeSkillId(candidate.skillId)) {
    reasons.push("skill id is reserved or path-unsafe");
  }
  if (skills.listSkills().some((skill) => skill.id === candidate.skillId)) {
    reasons.push(`skill already exists: ${candidate.skillId}`);
  }
  return {
    type: "skill_auto_promote",
    sourceCandidateId: candidate.id,
    sourceRunId: candidate.runId,
    sourceSessionId: candidate.sourceSessionId,
    sourceAgentId: candidate.sourceAgentId,
    riskLevel: secret.matched ? "high" : candidate.riskLevel,
    eligible: reasons.length === 0,
    rationale: reasons.length ? reasons.join("; ") : "low-risk skill candidate with trigger is eligible",
    evidence: redactEvidence({
      candidate,
      secretReasons: secret.reasons,
      policy: {
        enabled: cfg.enabled,
        allowRiskLevels: cfg.allowRiskLevels,
        requireTriggers: cfg.requireTriggers,
        denySecretLike: cfg.denySecretLike,
        maxContentChars: cfg.maxContentChars,
        preferForAgent: cfg.preferForAgent
      }
    }),
    skillCandidate: candidate
  };
}

function ensureImprovementTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS improvement_records (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      source_run_id TEXT,
      source_session_id TEXT,
      source_agent_id TEXT,
      source_candidate_id TEXT,
      target_id TEXT,
      evaluation_hash TEXT,
      rationale TEXT NOT NULL,
      policy_snapshot_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      applied_at TEXT,
      reverted_at TEXT,
      discarded_at TEXT,
      reason TEXT,
      record_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function upsertImprovementRow(db: DatabaseSync, record: ImprovementRecord): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO improvement_records (
      id, type, status, risk_level, source_run_id, source_session_id, source_agent_id,
      source_candidate_id, target_id, evaluation_hash, rationale, policy_snapshot_json,
      evidence_json, created_at, applied_at, reverted_at, discarded_at, reason, record_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      target_id = excluded.target_id,
      evaluation_hash = excluded.evaluation_hash,
      rationale = excluded.rationale,
      policy_snapshot_json = excluded.policy_snapshot_json,
      evidence_json = excluded.evidence_json,
      applied_at = excluded.applied_at,
      reverted_at = excluded.reverted_at,
      discarded_at = excluded.discarded_at,
      reason = excluded.reason,
      record_json = excluded.record_json,
      updated_at = excluded.updated_at
  `).run(
    record.id,
    record.type,
    record.status,
    record.riskLevel,
    record.sourceRunId ?? null,
    record.sourceSessionId ?? null,
    record.sourceAgentId ?? null,
    record.sourceCandidateId ?? null,
    record.targetId ?? null,
    record.evaluationHash ?? null,
    record.rationale,
    JSON.stringify(record.policySnapshot),
    JSON.stringify(record.evidence),
    record.createdAt,
    record.appliedAt ?? null,
    record.revertedAt ?? null,
    record.discardedAt ?? null,
    record.reason ?? null,
    JSON.stringify(record),
    now
  );
}

function policySnapshot(policy: PolicyConfig): Record<string, unknown> {
  return redactEvidence({
    memory: {
      autoPromotion: policy.memory.autoPromotion
    },
    selfImprovement: policy.selfImprovement,
    disabledPermissions: policy.disabledPermissions,
    codex: {
      amendment: policy.codex.amendment
    }
  });
}

function decisionPolicySnapshot(decision: ImprovementDecision): Record<string, unknown> {
  const policy = decision.evidence.policy;
  return redactEvidence(policy && typeof policy === "object" ? policy as Record<string, unknown> : {});
}

function evaluationHash(decisions: ImprovementDecision[], snapshot: Record<string, unknown>): string {
  const payload = {
    snapshot,
    decisions: decisions.map((decision) => ({
      type: decision.type,
      sourceCandidateId: decision.sourceCandidateId,
      eligible: decision.eligible,
      rationale: decision.rationale,
      riskLevel: decision.riskLevel
    }))
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function redactEvidence(value: unknown): Record<string, unknown> {
  const redacted = redactValue("", value);
  return redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : { value: redacted };
}

function redactValue(key: string, value: unknown): unknown {
  if (/token|secret|password|credential|api[_-]?key/i.test(key)) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    const secret = detectSecrets(value);
    return secret.matched ? secret.redactedPreview : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(key, item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, redactValue(childKey, childValue)]));
  }
  return value;
}

function isSafeSkillId(skillId: string): boolean {
  const reserved = new Set(["con", "prn", "aux", "nul", "com1", "com2", "lpt1", "skills"]);
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(skillId)
    && !reserved.has(skillId)
    && !skillId.includes("..")
    && !skillId.includes("/")
    && !skillId.includes("\\");
}

function isToolRecommendationEvent(event: PolicyAuditEvent): boolean {
  return event.eventType === "tool_decision" && !event.allowed && Boolean(event.tool)
    && (recommendationReasons.has(event.ruleId) || recommendationReasons.has(event.reason));
}

function recommendationAction(event: PolicyAuditEvent): string {
  if (event.ruleId === "tool.config_disabled" || event.reason === "tool.config_disabled") {
    return `Review runtime config for ${event.tool}.`;
  }
  if (event.ruleId === "tool.not_allowed_for_agent" || event.reason === "tool.not_allowed_for_agent") {
    return `Review agent allowedTools for ${event.tool}.`;
  }
  if (event.ruleId === "permission.disabled" || event.reason === "permission.disabled") {
    return `Review disabled permission policy for ${event.permission ?? "tool permission"}.`;
  }
  return `Review whether ${event.tool ?? "the requested tool"} should exist as a governed tool.`;
}

function countBy<T>(items: T[], selector: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = selector(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function shortId(value?: string): string {
  return value ? value.slice(0, 8) : "-";
}
