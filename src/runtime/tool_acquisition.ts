import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { z } from "zod";
import { AgentManager } from "./agent_manager.js";
import { CapabilityPlanner, type CapabilityFamily, type CapabilityProposal, stableJsonStringify } from "./capability.js";
import { readText } from "./fs_utils.js";
import { createProvider } from "./model/provider_registry.js";
import { PolicyManager, type PolicyConfig } from "./policy_manager.js";
import { detectSecrets } from "./risk_classifier.js";
import { ShellApprovalLedger, type ShellApproval } from "./shell_approval.js";
import { isToolId } from "./tool_catalog.js";
import type { ToolPermission } from "./types.js";

const execFileAsync = promisify(execFile);

export type ToolExecutorKind = "command_adapter" | "ts_module";
export type ToolExposure = "model" | "cli_only" | "internal";
export type ToolCandidateStatus =
  | "draft"
  | "pending"
  | "test_ready"
  | "test_failed"
  | "approved"
  | "activated"
  | "discarded"
  | "rejected";
export type ActiveToolStatus = "active" | "disabled" | "deactivated";
export type ToolActivationStatus = "previewed" | "applying" | "active" | "activation_failed" | "deactivated" | "rollback_failed";
export type ToolCandidateTestStatus = "passed" | "failed";
export type CwdPolicy = "workspace_root";

export type CommandAdapterPlan = {
  executable: string;
  args: string[];
  cwdPolicy: CwdPolicy;
  timeoutMs: number;
  outputCapBytes: number;
  redaction: true;
};

export type TsModulePlan = {
  designNote: string;
  redaction: true;
};

export type ToolDraftRecord = {
  id: string;
  sourceCapabilityId: string;
  sourceShellApprovalIds: string[];
  rawDraft: Record<string, unknown>;
  status: "drafted" | "candidate_created" | "candidate_not_created";
  candidateId?: string;
  evidence: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ToolCandidateRecord = {
  id: string;
  draftId: string;
  sourceCapabilityId: string;
  sourceShellApprovalIds: string[];
  targetToolId: string;
  capabilityFamily: CapabilityFamily;
  permission: ToolPermission;
  exposure: ToolExposure;
  executorKind: ToolExecutorKind;
  executorPlan: CommandAdapterPlan | TsModulePlan;
  inputSchemaDraft: Record<string, unknown>;
  safetyRationale: string;
  testPlan: string;
  rollbackPlan: string;
  groundingReferences: string[];
  status: ToolCandidateStatus;
  candidateContentHash: string;
  evidence: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  discardedAt?: string;
  discardReason?: string;
  rejectedAt?: string;
  rejectReason?: string;
};

export type ActiveToolRecord = {
  id: string;
  candidateId: string;
  capabilityFamily: CapabilityFamily;
  executorKind: ToolExecutorKind;
  permission: ToolPermission;
  exposure: ToolExposure;
  targetAgentIds: string[];
  status: ActiveToolStatus;
  executorPlan: CommandAdapterPlan | TsModulePlan;
  createdAt: string;
  activatedAt: string;
  deactivatedAt?: string;
  deactivateReason?: string;
  policySnapshot: Record<string, unknown>;
  evidence: Record<string, unknown>;
};

export type ToolActivationRecord = {
  id: string;
  candidateId: string;
  toolId: string;
  targetAgentId: string;
  status: ToolActivationStatus;
  activeToolRecordId?: string;
  agentManifestSnapshotId?: string;
  policySnapshot: Record<string, unknown>;
  evidence: Record<string, unknown>;
  createdAt: string;
  appliedAt?: string;
  failedAt?: string;
  reason?: string;
};

export type ToolCandidateTestRun = {
  id: string;
  candidateId: string;
  candidateContentHash: string;
  status: ToolCandidateTestStatus;
  testedAt: string;
  evidence: Record<string, unknown>;
  outputSummary?: string;
};

export type ToolDraftResult = {
  draft: ToolDraftRecord;
  candidate?: ToolCandidateRecord;
  warnings: string[];
  reason?: string;
};

const reservedToolIds = new Set([
  "read_file",
  "write_file",
  "search_files",
  "shell_request",
  "git_status",
  "git_diff",
  "git_log",
  "npm_test",
  "npm_typecheck"
]);

const allowedPermissions = new Set<ToolPermission>(["read_only", "project_check"]);
const outputSummaryMaxChars = 2000;

const rawDraftSchema = z.object({
  targetToolId: z.string().optional(),
  capabilityFamily: z.string().optional(),
  permission: z.string().optional(),
  exposure: z.string().optional(),
  executorKind: z.string().optional(),
  executorPlan: z.record(z.string(), z.unknown()).optional(),
  inputSchemaDraft: z.record(z.string(), z.unknown()).optional(),
  safetyRationale: z.string().optional(),
  testPlan: z.string().optional(),
  rollbackPlan: z.string().optional(),
  groundingReferences: z.array(z.string()).optional()
}).passthrough();

export class ToolAcquisitionManager {
  constructor(private readonly workspaceRoot: string) {}

  async draftFromCapability(capabilityId: string, options: { providerId?: string; rawDraft?: Record<string, unknown> } = {}): Promise<ToolDraftResult> {
    const capability = new CapabilityPlanner(this.workspaceRoot).getProposal(capabilityId);
    const sourceShellApprovalIds = capability.convertedShellApprovalId ? [capability.convertedShellApprovalId] : [];
    const rawDraft = options.rawDraft ?? await this.createLlmDraft(capability, sourceShellApprovalIds, options.providerId);
    const now = new Date().toISOString();
    const draft: ToolDraftRecord = {
      id: `draft_${randomUUID().slice(0, 8)}`,
      sourceCapabilityId: capability.id,
      sourceShellApprovalIds,
      rawDraft,
      status: "drafted",
      evidence: {
        sourceCapabilityId: capability.id,
        sourceShellApprovalIds
      },
      createdAt: now,
      updatedAt: now
    };
    const normalized = this.normalizeDraft(draft, capability);
    let candidate: ToolCandidateRecord | undefined;
    if (normalized.candidate) {
      candidate = normalized.candidate;
      draft.status = "candidate_created";
      draft.candidateId = candidate.id;
    } else {
      draft.status = "candidate_not_created";
      draft.evidence = {
        ...draft.evidence,
        candidateNotCreatedReason: normalized.reason
      };
    }
    draft.evidence = {
      ...draft.evidence,
      normalizationWarnings: normalized.warnings
    };
    this.withDb((db) => {
      insertDraft(db, draft);
      if (candidate) {
        insertCandidate(db, candidate);
      }
    });
    return { draft, candidate, warnings: normalized.warnings, reason: normalized.reason };
  }

  listCandidates(options: { all?: boolean } = {}): ToolCandidateRecord[] {
    return this.withDb((db) => {
      const rows = options.all
        ? db.prepare("SELECT record_json FROM tool_candidates ORDER BY created_at DESC").all() as Array<{ record_json: string }>
        : db.prepare("SELECT record_json FROM tool_candidates WHERE status NOT IN ('discarded', 'rejected') ORDER BY created_at DESC").all() as Array<{ record_json: string }>;
      return rows.map((row) => normalizeCandidate(JSON.parse(row.record_json) as ToolCandidateRecord));
    });
  }

  getCandidate(id: string): ToolCandidateRecord {
    const candidate = this.withDb((db) => {
      const row = db.prepare("SELECT record_json FROM tool_candidates WHERE id = ?").get(id) as { record_json: string } | undefined;
      return row ? normalizeCandidate(JSON.parse(row.record_json) as ToolCandidateRecord) : undefined;
    });
    if (!candidate) {
      throw new Error(`Tool candidate not found: ${id}`);
    }
    return candidate;
  }

  discardCandidate(id: string, reason: string): ToolCandidateRecord {
    const candidate = this.getCandidate(id);
    assertMutableCandidate(candidate);
    const now = new Date().toISOString();
    const next = normalizeCandidate({
      ...candidate,
      status: "discarded",
      discardedAt: now,
      discardReason: redactText(reason),
      updatedAt: now
    });
    this.saveCandidate(next);
    return next;
  }

  rejectCandidate(id: string, reason: string): ToolCandidateRecord {
    const candidate = this.getCandidate(id);
    assertMutableCandidate(candidate);
    const now = new Date().toISOString();
    const next = normalizeCandidate({
      ...candidate,
      status: "rejected",
      rejectedAt: now,
      rejectReason: redactText(reason),
      updatedAt: now
    });
    this.saveCandidate(next);
    return next;
  }

  approveCandidate(id: string): ToolCandidateRecord {
    const candidate = this.getCandidate(id);
    if (!["pending", "test_ready", "test_failed"].includes(candidate.status)) {
      throw new Error(`Tool candidate cannot be approved from status: ${candidate.status}`);
    }
    const next = normalizeCandidate({
      ...candidate,
      status: "approved",
      updatedAt: new Date().toISOString()
    });
    this.saveCandidate(next);
    return next;
  }

  async testCandidate(id: string): Promise<ToolCandidateTestRun> {
    const candidate = this.getCandidate(id);
    if (candidate.executorKind === "ts_module") {
      const run = this.recordTest(candidate, "failed", "ts_module execution is blocked until the ts_module security roadmap.");
      this.saveCandidate({ ...candidate, status: "test_failed", updatedAt: new Date().toISOString() });
      return run;
    }
    const plan = candidate.executorPlan as CommandAdapterPlan;
    try {
      const result = await execFileAsync(plan.executable, plan.args, {
        cwd: this.workspaceRoot,
        timeout: plan.timeoutMs,
        maxBuffer: plan.outputCapBytes
      });
      const summary = summarizeOutput(`${result.stdout ?? ""}${result.stderr ? `\nstderr:\n${result.stderr}` : ""}`);
      const run = this.recordTest(candidate, "passed", summary);
      this.saveCandidate({ ...candidate, status: "test_ready", updatedAt: new Date().toISOString() });
      return run;
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
      const summary = summarizeOutput(`Exit code: ${String(err.code ?? "unknown")}\n${err.stdout ?? ""}\n${err.stderr ?? err.message}`);
      const run = this.recordTest(candidate, "failed", summary);
      this.saveCandidate({ ...candidate, status: "test_failed", updatedAt: new Date().toISOString() });
      return run;
    }
  }

  async activateCandidate(id: string, agentId: string, options: { yes?: boolean } = {}): Promise<ToolActivationRecord> {
    if (!options.yes) {
      throw new Error("Tool activation requires --yes.");
    }
    const candidate = this.getCandidate(id);
    const createdAt = new Date().toISOString();
    const activation: ToolActivationRecord = {
      id: `act_${randomUUID().slice(0, 8)}`,
      candidateId: candidate.id,
      toolId: candidate.targetToolId,
      targetAgentId: agentId,
      status: "applying",
      policySnapshot: await this.policySnapshot(),
      evidence: {},
      createdAt
    };
    try {
      this.assertActivatable(candidate);
      const latestTest = this.latestPassedTest(candidate.id);
      if (!latestTest || latestTest.candidateContentHash !== candidate.candidateContentHash) {
        throw new Error("Tool activation requires a latest passed candidate test for the current candidate content.");
      }
      const agents = new AgentManager(this.workspaceRoot);
      const manifest = await agents.loadAgent(agentId);
      const snapshotId = `agent_snapshot_${randomUUID().slice(0, 8)}`;
      const snapshotPath = join(this.workspaceRoot, "memory", `${snapshotId}.json`);
      await writeFile(snapshotPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      const now = new Date().toISOString();
      const active: ActiveToolRecord = {
        id: candidate.targetToolId,
        candidateId: candidate.id,
        capabilityFamily: candidate.capabilityFamily,
        executorKind: candidate.executorKind,
        permission: candidate.permission,
        exposure: candidate.exposure,
        targetAgentIds: [agentId],
        status: "active",
        executorPlan: candidate.executorPlan,
        createdAt: now,
        activatedAt: now,
        policySnapshot: activation.policySnapshot,
        evidence: {
          candidateId: candidate.id,
          testRunId: latestTest.id
        }
      };
      const nextManifest = {
        ...manifest,
        allowedTools: [...new Set([...manifest.allowedTools, active.id])]
      };
      await writeFile(join(this.workspaceRoot, "agents", agentId, "manifest.json"), `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
      this.withDb((db) => {
        db.exec("BEGIN");
        try {
          insertActiveTool(db, active);
          insertActivation(db, {
            ...activation,
            status: "active",
            activeToolRecordId: active.id,
            agentManifestSnapshotId: snapshotId,
            appliedAt: now,
            evidence: active.evidence
          });
          insertCandidate(db, { ...candidate, status: "activated", updatedAt: now });
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
      return { ...activation, status: "active", activeToolRecordId: active.id, agentManifestSnapshotId: snapshotId, appliedAt: now, evidence: active.evidence };
    } catch (error) {
      const failed: ToolActivationRecord = {
        ...activation,
        status: "activation_failed",
        failedAt: new Date().toISOString(),
        reason: (error as Error).message,
        evidence: {
          error: (error as Error).message
        }
      };
      this.withDb((db) => insertActivation(db, failed));
      throw error;
    }
  }

  async deactivateTool(toolId: string, reason: string): Promise<ActiveToolRecord> {
    const active = this.getActiveTool(toolId);
    const now = new Date().toISOString();
    const next: ActiveToolRecord = {
      ...active,
      status: "deactivated",
      deactivatedAt: now,
      deactivateReason: redactText(reason)
    };
    const agents = new AgentManager(this.workspaceRoot);
    for (const agentId of active.targetAgentIds) {
      const manifest = await agents.loadAgent(agentId);
      const updated = {
        ...manifest,
        allowedTools: manifest.allowedTools.filter((tool) => tool !== toolId)
      };
      await writeFile(join(this.workspaceRoot, "agents", agentId, "manifest.json"), `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    }
    this.withDb((db) => insertActiveTool(db, next));
    return next;
  }

  listActiveTools(options: { includeInactive?: boolean } = {}): ActiveToolRecord[] {
    return this.withDb((db) => {
      const rows = options.includeInactive
        ? db.prepare("SELECT record_json FROM active_tools ORDER BY activated_at DESC").all() as Array<{ record_json: string }>
        : db.prepare("SELECT record_json FROM active_tools WHERE status = 'active' ORDER BY activated_at DESC").all() as Array<{ record_json: string }>;
      return rows.map((row) => normalizeActiveTool(JSON.parse(row.record_json) as ActiveToolRecord));
    });
  }

  getActiveTool(id: string): ActiveToolRecord {
    const active = getActiveToolRecord(this.workspaceRoot, id);
    if (!active) {
      throw new Error(`Active tool not found: ${id}`);
    }
    return active;
  }

  latestPassedTest(candidateId: string): ToolCandidateTestRun | undefined {
    return this.withDb((db) => {
      const row = db.prepare("SELECT record_json FROM tool_candidate_test_runs WHERE candidate_id = ? AND status = 'passed' ORDER BY tested_at DESC LIMIT 1")
        .get(candidateId) as { record_json: string } | undefined;
      return row ? JSON.parse(row.record_json) as ToolCandidateTestRun : undefined;
    });
  }

  private async createLlmDraft(capability: CapabilityProposal, sourceShellApprovalIds: string[], providerId = "default"): Promise<Record<string, unknown>> {
    const policy = await new PolicyManager(this.workspaceRoot).loadPolicy();
    const resolvedProviderId = providerId === "default" ? policy.model.defaultProvider : providerId;
    const provider = createProvider(resolvedProviderId, this.workspaceRoot, { policy });
    const linkedShell = sourceShellApprovalIds
      .map((id) => new ShellApprovalLedger(this.workspaceRoot).get(id))
      .filter((approval): approval is ShellApproval => Boolean(approval));
    const prompt = toolDraftPrompt(capability, linkedShell, policy);
    const output = await provider.complete({ prompt, sessionId: "tool_draft" });
    if (output.step.type !== "final") {
      throw new Error("ToolDraft provider must return a final AgentStep with JSON content.");
    }
    return parseDraftJson(output.step.content);
  }

  private normalizeDraft(draft: ToolDraftRecord, capability: CapabilityProposal): { candidate?: ToolCandidateRecord; warnings: string[]; reason?: string } {
    const raw = rawDraftSchema.parse(draft.rawDraft);
    const warnings: string[] = [];
    for (const key of Object.keys(draft.rawDraft)) {
      if (!(key in rawDraftSchema.shape)) {
        warnings.push(`unknown field discarded: ${key}`);
      }
    }
    const executorKind = raw.executorKind === "command_adapter" || raw.executorKind === "ts_module" ? raw.executorKind : undefined;
    if (!executorKind) {
      warnings.push(`unknown executorKind rejected: ${String(raw.executorKind ?? "missing")}`);
      return { warnings, reason: "executorKind rejected" };
    }
    const permission = normalizePermission(raw.permission, warnings);
    if (!permission) {
      return { warnings, reason: "permission rejected" };
    }
    const targetToolId = normalizeToolId(raw.targetToolId, capability.capabilityFamily, this.listActiveTools({ includeInactive: true }), warnings);
    if (!targetToolId) {
      return { warnings, reason: "targetToolId rejected" };
    }
    const exposure = normalizeExposure(raw.exposure, warnings);
    const executorPlan = executorKind === "command_adapter"
      ? normalizeCommandAdapterPlan(raw.executorPlan, warnings)
      : normalizeTsModulePlan(raw.executorPlan, warnings);
    if (!executorPlan) {
      return { warnings, reason: "executorPlan rejected" };
    }
    const groundingReferences = normalizeGroundingReferences(raw.groundingReferences, draft, capability, warnings);
    const now = new Date().toISOString();
    const candidate: ToolCandidateRecord = {
      id: `cand_${randomUUID().slice(0, 8)}`,
      draftId: draft.id,
      sourceCapabilityId: capability.id,
      sourceShellApprovalIds: draft.sourceShellApprovalIds,
      targetToolId,
      capabilityFamily: capability.capabilityFamily,
      permission,
      exposure,
      executorKind,
      executorPlan,
      inputSchemaDraft: raw.inputSchemaDraft ?? {},
      safetyRationale: redactText(raw.safetyRationale ?? "Review required before activation."),
      testPlan: redactText(raw.testPlan ?? "Run candidate test before activation."),
      rollbackPlan: redactText(raw.rollbackPlan ?? "Deactivate active tool and remove it from agent allowedTools."),
      groundingReferences,
      status: "pending",
      candidateContentHash: "",
      evidence: {
        normalizationWarnings: warnings,
        sourceShellApprovalIds: draft.sourceShellApprovalIds
      },
      createdAt: now,
      updatedAt: now
    };
    return {
      candidate: {
        ...candidate,
        candidateContentHash: candidateContentHash(candidate)
      },
      warnings
    };
  }

  private recordTest(candidate: ToolCandidateRecord, status: ToolCandidateTestStatus, outputSummary: string): ToolCandidateTestRun {
    const run: ToolCandidateTestRun = {
      id: `test_${randomUUID().slice(0, 8)}`,
      candidateId: candidate.id,
      candidateContentHash: candidate.candidateContentHash,
      status,
      testedAt: new Date().toISOString(),
      evidence: {
        executorKind: candidate.executorKind
      },
      outputSummary: summarizeOutput(outputSummary)
    };
    this.withDb((db) => insertTestRun(db, run));
    return run;
  }

  private saveCandidate(candidate: ToolCandidateRecord): void {
    this.withDb((db) => insertCandidate(db, candidate));
  }

  private assertActivatable(candidate: ToolCandidateRecord): void {
    if (candidate.status !== "approved") {
      throw new Error(`Tool candidate must be approved before activation: ${candidate.status}`);
    }
    if (candidate.executorKind !== "command_adapter") {
      throw new Error("ts_module activation is blocked until the ts_module security roadmap.");
    }
    if (!allowedPermissions.has(candidate.permission)) {
      throw new Error(`Tool candidate permission cannot be activated in the MVP: ${candidate.permission}`);
    }
  }

  private async policySnapshot(): Promise<Record<string, unknown>> {
    const policy = await new PolicyManager(this.workspaceRoot).loadPolicy();
    return {
      disabledPermissions: policy.disabledPermissions,
      tools: Object.fromEntries(Object.entries(policy.tools).map(([id, tool]) => [id, { permission: tool.permission, enabled: tool.enabled }]))
    };
  }

  private withDb<T>(fn: (db: DatabaseSync) => T): T {
    return withToolDb(this.workspaceRoot, fn);
  }
}

export function getActiveToolRecord(workspaceRoot: string, id: string): ActiveToolRecord | undefined {
  return withToolDb(workspaceRoot, (db) => {
    const row = db.prepare("SELECT record_json FROM active_tools WHERE id = ?").get(id) as { record_json: string } | undefined;
    return row ? normalizeActiveTool(JSON.parse(row.record_json) as ActiveToolRecord) : undefined;
  });
}

export function listEffectiveActiveModelToolIds(workspaceRoot: string, allowedTools: string[], policy: PolicyConfig | undefined): string[] {
  return withToolDb(workspaceRoot, (db) => {
    const rows = db.prepare("SELECT record_json FROM active_tools WHERE status = 'active'").all() as Array<{ record_json: string }>;
    return rows
      .map((row) => normalizeActiveTool(JSON.parse(row.record_json) as ActiveToolRecord))
      .filter((tool) => tool.exposure === "model")
      .filter((tool) => allowedTools.includes(tool.id))
      .filter((tool) => !(policy?.disabledPermissions ?? []).includes(tool.permission))
      .map((tool) => tool.id);
  });
}

export function candidateContentHash(candidate: ToolCandidateRecord): string {
  const meaningful = {
    capabilityFamily: candidate.capabilityFamily,
    executorKind: candidate.executorKind,
    executorPlan: candidate.executorPlan,
    exposure: candidate.exposure,
    groundingReferences: candidate.groundingReferences,
    inputSchemaDraft: candidate.inputSchemaDraft,
    permission: candidate.permission,
    rollbackPlan: candidate.rollbackPlan,
    safetyRationale: candidate.safetyRationale,
    targetToolId: candidate.targetToolId,
    testPlan: candidate.testPlan
  };
  return hashText(stableJsonStringify(meaningful));
}

export function formatToolDraftResult(result: ToolDraftResult): string {
  const lines = [`Draft created: ${result.draft.id}`];
  if (result.candidate) {
    lines.push(`Candidate created from normalized draft: ${result.candidate.id}`);
  } else {
    lines.push("Candidate not created.");
    lines.push(`Reason: ${result.reason ?? "normalizer rejected the draft"}`);
  }
  lines.push(`Unsafe fields discarded: ${result.warnings.length}`);
  for (const warning of result.warnings.slice(0, 5)) {
    lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}

export function formatToolCandidate(candidate: ToolCandidateRecord): string {
  const warnings = Array.isArray(candidate.evidence.normalizationWarnings) ? candidate.evidence.normalizationWarnings as string[] : [];
  return [
    `Tool candidate: ${candidate.id}`,
    `Status: ${candidate.status}`,
    `Target tool: ${candidate.targetToolId}`,
    `Capability: ${candidate.capabilityFamily}`,
    `Permission: ${candidate.permission}`,
    `Exposure: ${candidate.exposure}`,
    `Executor: ${candidate.executorKind}`,
    candidate.executorKind === "ts_module" ? "Activation: blocked until ts_module security roadmap" : undefined,
    `Content hash: ${candidate.candidateContentHash}`,
    `Source capability: ${candidate.sourceCapabilityId}`,
    candidate.sourceShellApprovalIds.length ? `Source shell approvals: ${candidate.sourceShellApprovalIds.join(", ")}` : undefined,
    "",
    "Safety rationale:",
    candidate.safetyRationale,
    "",
    "Test plan:",
    candidate.testPlan,
    "",
    "Rollback plan:",
    candidate.rollbackPlan,
    "",
    "Normalization warnings:",
    warnings.length ? warnings.map((warning) => `- ${warning}`).join("\n") : "- none"
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function formatToolCandidateReview(candidates: ToolCandidateRecord[]): string {
  if (!candidates.length) {
    return "No tool candidates.";
  }
  return candidates.map((candidate) => [
    `${candidate.id}\t${candidate.status}\t${candidate.targetToolId}\t${candidate.executorKind}\t${candidate.permission}`,
    `Source capability: ${candidate.sourceCapabilityId}`
  ].join("\n")).join("\n\n");
}

export function formatToolCandidateTestRun(run: ToolCandidateTestRun): string {
  return [
    `Tool candidate test: ${run.id}`,
    `Candidate: ${run.candidateId}`,
    `Status: ${run.status}`,
    `Candidate hash: ${run.candidateContentHash}`,
    `Tested at: ${run.testedAt}`,
    "",
    run.outputSummary ?? "No output summary."
  ].join("\n");
}

export function formatActiveTool(tool: ActiveToolRecord): string {
  return [
    `Active tool: ${tool.id}`,
    `Status: ${tool.status}`,
    `Candidate: ${tool.candidateId}`,
    `Capability: ${tool.capabilityFamily}`,
    `Executor: ${tool.executorKind}`,
    `Permission: ${tool.permission}`,
    `Exposure: ${tool.exposure}`,
    `Target agents: ${tool.targetAgentIds.join(", ") || "none"}`,
    `Activated at: ${tool.activatedAt}`,
    tool.deactivatedAt ? `Deactivated at: ${tool.deactivatedAt}` : undefined,
    tool.deactivateReason ? `Deactivate reason: ${tool.deactivateReason}` : undefined
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function formatActiveToolList(tools: ActiveToolRecord[]): string {
  if (!tools.length) {
    return "No active tools.";
  }
  return tools.map((tool) => `${tool.id}\t${tool.status}\t${tool.executorKind}\t${tool.permission}\tagents:${tool.targetAgentIds.join(",")}`).join("\n");
}

export function formatToolActivation(record: ToolActivationRecord): string {
  return [
    `Tool activation: ${record.id}`,
    `Status: ${record.status}`,
    `Candidate: ${record.candidateId}`,
    `Tool: ${record.toolId}`,
    `Agent: ${record.targetAgentId}`,
    record.reason ? `Reason: ${record.reason}` : undefined
  ].filter((line): line is string => line !== undefined).join("\n");
}

function toolDraftPrompt(capability: CapabilityProposal, shellApprovals: ShellApproval[], policy: PolicyConfig): string {
  return `TOOL_DRAFT_REQUEST

Return one AgentStep JSON object with type "final". The final.content MUST be a JSON object string for an untrusted ToolDraft proposal package.

Do not create files. Do not request shell execution. Do not change policy. Do not add permissions.

Allowed executorKind values: command_adapter, ts_module.
Allowed permissions for command_adapter MVP: read_only, project_check.
ts_module is design/review-only and must not be executable.

Capability proposal:
${JSON.stringify(capability, null, 2)}

Linked shell approval evidence:
${JSON.stringify(shellApprovals.map((approval) => ({
  id: approval.id,
  command: approval.command,
  risk: approval.risk,
  blocked: approval.blocked,
  status: approval.status
})), null, 2)}

Current disabled permissions:
${JSON.stringify(policy.disabledPermissions)}

Expected final.content JSON fields:
targetToolId, capabilityFamily, permission, exposure, executorKind, executorPlan, inputSchemaDraft, safetyRationale, testPlan, rollbackPlan, groundingReferences.`;
}

function parseDraftJson(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const json = fenced?.[1] ?? trimmed;
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ToolDraft final content must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function withToolDb<T>(workspaceRoot: string, fn: (db: DatabaseSync) => T): T {
  const memoryDir = join(workspaceRoot, "memory");
  mkdirSync(memoryDir, { recursive: true });
  const db = new DatabaseSync(join(memoryDir, "longterm.sqlite"));
  try {
    ensureToolTables(db);
    return fn(db);
  } finally {
    db.close();
  }
}

function ensureToolTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_drafts (
      id TEXT PRIMARY KEY,
      source_capability_id TEXT NOT NULL,
      status TEXT NOT NULL,
      candidate_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tool_candidates (
      id TEXT PRIMARY KEY,
      target_tool_id TEXT NOT NULL,
      source_capability_id TEXT NOT NULL,
      executor_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      candidate_content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tool_candidate_test_runs (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      candidate_content_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      tested_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS active_tools (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      executor_kind TEXT NOT NULL,
      permission TEXT NOT NULL,
      exposure TEXT NOT NULL,
      status TEXT NOT NULL,
      activated_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tool_activation_records (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
  `);
}

function insertDraft(db: DatabaseSync, draft: ToolDraftRecord): void {
  db.prepare(`
    INSERT OR REPLACE INTO tool_drafts (id, source_capability_id, status, candidate_id, created_at, updated_at, record_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(draft.id, draft.sourceCapabilityId, draft.status, draft.candidateId ?? null, draft.createdAt, draft.updatedAt, JSON.stringify(draft));
}

function insertCandidate(db: DatabaseSync, candidate: ToolCandidateRecord): void {
  db.prepare(`
    INSERT OR REPLACE INTO tool_candidates (id, target_tool_id, source_capability_id, executor_kind, status, candidate_content_hash, created_at, updated_at, record_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(candidate.id, candidate.targetToolId, candidate.sourceCapabilityId, candidate.executorKind, candidate.status, candidate.candidateContentHash, candidate.createdAt, candidate.updatedAt, JSON.stringify(candidate));
}

function insertTestRun(db: DatabaseSync, run: ToolCandidateTestRun): void {
  db.prepare(`
    INSERT OR REPLACE INTO tool_candidate_test_runs (id, candidate_id, candidate_content_hash, status, tested_at, record_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(run.id, run.candidateId, run.candidateContentHash, run.status, run.testedAt, JSON.stringify(run));
}

function insertActiveTool(db: DatabaseSync, tool: ActiveToolRecord): void {
  db.prepare(`
    INSERT OR REPLACE INTO active_tools (id, candidate_id, executor_kind, permission, exposure, status, activated_at, record_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tool.id, tool.candidateId, tool.executorKind, tool.permission, tool.exposure, tool.status, tool.activatedAt, JSON.stringify(tool));
}

function insertActivation(db: DatabaseSync, record: ToolActivationRecord): void {
  db.prepare(`
    INSERT OR REPLACE INTO tool_activation_records (id, candidate_id, tool_id, target_agent_id, status, created_at, record_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(record.id, record.candidateId, record.toolId, record.targetAgentId, record.status, record.createdAt, JSON.stringify(record));
}

function normalizeCandidate(candidate: ToolCandidateRecord): ToolCandidateRecord {
  const hash = candidate.candidateContentHash || candidateContentHash(candidate);
  return {
    ...candidate,
    candidateContentHash: hash,
    evidence: candidate.evidence ?? {},
    sourceShellApprovalIds: candidate.sourceShellApprovalIds ?? [],
    groundingReferences: candidate.groundingReferences ?? []
  };
}

function normalizeActiveTool(tool: ActiveToolRecord): ActiveToolRecord {
  return {
    ...tool,
    targetAgentIds: tool.targetAgentIds ?? [],
    evidence: tool.evidence ?? {},
    policySnapshot: tool.policySnapshot ?? {}
  };
}

function normalizePermission(value: unknown, warnings: string[]): ToolPermission | undefined {
  if (value === "read_only" || value === "project_check") {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    warnings.push(`permission rejected: ${value}`);
  } else {
    warnings.push("permission missing; downgraded to read_only");
    return "read_only";
  }
  return undefined;
}

function normalizeExposure(value: unknown, warnings: string[]): ToolExposure {
  if (value === "model" || value === "cli_only" || value === "internal") {
    return value;
  }
  warnings.push(`exposure downgraded to model: ${String(value ?? "missing")}`);
  return "model";
}

function normalizeToolId(value: unknown, family: CapabilityFamily, existing: ActiveToolRecord[], warnings: string[]): string | undefined {
  const candidate = typeof value === "string" && value.trim()
    ? value.trim()
    : `local.${family}.${randomUUID().slice(0, 4)}`;
  if (!/^[a-z][a-z0-9_.-]{2,80}$/.test(candidate)) {
    warnings.push(`invalid targetToolId rejected: ${candidate}`);
    return undefined;
  }
  if (candidate.includes("..") || /[\s\\/;&|$()<>]/.test(candidate)) {
    warnings.push(`path-unsafe or command-like targetToolId rejected: ${candidate}`);
    return undefined;
  }
  if (reservedToolIds.has(candidate) || isToolId(candidate) || existing.some((tool) => tool.id === candidate)) {
    warnings.push(`targetToolId collision rejected: ${candidate}`);
    return undefined;
  }
  return candidate;
}

function normalizeCommandAdapterPlan(value: unknown, warnings: string[]): CommandAdapterPlan | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("command_adapter executorPlan rejected: expected object");
    return undefined;
  }
  const plan = value as Record<string, unknown>;
  const executable = typeof plan.executable === "string" ? plan.executable.trim() : "";
  const args = Array.isArray(plan.args) && plan.args.every((arg) => typeof arg === "string")
    ? plan.args as string[]
    : undefined;
  if (!executable || !args) {
    warnings.push("command_adapter executorPlan rejected: fixed executable and fixed args are required");
    return undefined;
  }
  if (/[;&|$()<>]/.test(executable) || args.some((arg) => /[;&|$()<>]/.test(arg))) {
    warnings.push("command_adapter executorPlan rejected: shell metacharacters are not allowed");
    return undefined;
  }
  if (/[{}]/.test(executable) || args.some((arg) => /[{}]/.test(arg))) {
    warnings.push("command_adapter executorPlan rejected: model-provided interpolation placeholders are not allowed");
    return undefined;
  }
  if (plan.cwdPolicy && plan.cwdPolicy !== "workspace_root") {
    warnings.push(`cwdPolicy forced to workspace_root from ${String(plan.cwdPolicy)}`);
  }
  if (plan.redaction !== true) {
    warnings.push("redaction forced to true");
  }
  return {
    executable,
    args,
    cwdPolicy: "workspace_root",
    timeoutMs: clampNumber(plan.timeoutMs, 1000, 30_000, 30_000),
    outputCapBytes: clampNumber(plan.outputCapBytes, 1000, 12000, 12000),
    redaction: true
  };
}

function normalizeTsModulePlan(value: unknown, warnings: string[]): TsModulePlan {
  warnings.push("ts_module is draft/review-only and cannot be activated");
  const text = typeof value === "object" && value !== null
    ? JSON.stringify(value)
    : String(value ?? "No ts_module design note provided.");
  return {
    designNote: redactText(text).slice(0, 2000),
    redaction: true
  };
}

function normalizeGroundingReferences(
  value: unknown,
  draft: ToolDraftRecord,
  capability: CapabilityProposal,
  warnings: string[]
): string[] {
  const references = new Set<string>([
    capability.id,
    ...draft.sourceShellApprovalIds.map((id) => `shell:${id}`)
  ]);
  const raw = Array.isArray(value) ? value : [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      warnings.push("invalid grounding reference pruned");
      continue;
    }
    const ref = item.trim();
    if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(ref) || ref.includes("..")) {
      warnings.push(`invalid grounding reference pruned: ${ref.slice(0, 80)}`);
      continue;
    }
    references.add(ref);
  }
  return [...references];
}

function assertMutableCandidate(candidate: ToolCandidateRecord): void {
  if (candidate.status === "approved" || candidate.status === "activated") {
    throw new Error(`Tool candidate is immutable in status: ${candidate.status}. Create a new candidate for changes.`);
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function summarizeOutput(value: string): string {
  return redactText(value.replace(/\s+$/g, "")).slice(0, outputSummaryMaxChars) || "No output.";
}

function redactText(value: string): string {
  const secret = detectSecrets(value);
  let redacted = secret.matched ? secret.redactedPreview : value;
  redacted = redacted.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]");
  return redacted;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
