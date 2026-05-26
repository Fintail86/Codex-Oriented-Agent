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
import { createProvider, resolveProviderSelection } from "./model/provider_registry.js";
import { PolicyManager, type PolicyConfig } from "./policy_manager.js";
import { detectSecrets } from "./risk_classifier.js";
import { ShellApprovalLedger, type ShellApproval } from "./shell_approval.js";
import { isToolId } from "./tool_catalog.js";
import type { GatewayAccessPolicy } from "./gateway_auth_types.js";
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
export type ActiveToolExecutionStatus = "passed" | "failed";
export type ActiveToolExecutionFailureKind =
  | "spawn_failed"
  | "timeout"
  | "non_zero_exit"
  | "output_handling_failed"
  | "policy_denied";
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
  gatewayAccess?: GatewayAccessPolicy;
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

export type ActiveToolExecutionRecord = {
  id: string;
  toolId: string;
  status: ActiveToolExecutionStatus;
  failureKind?: ActiveToolExecutionFailureKind;
  exitCode?: number;
  durationMs: number;
  outputSummary: string;
  evidence: Record<string, unknown>;
  createdAt: string;
};

export type CommandAdapterExecutionResult = {
  ok: boolean;
  exitCode?: number;
  durationMs: number;
  outputSummary: string;
  failureKind?: ActiveToolExecutionFailureKind;
  failureReason?: string;
};

export type ActiveToolVisibility = {
  agentId: string;
  visible: boolean;
  reasons: string[];
};

export type ToolActivationPreview = {
  candidate: ToolCandidateRecord;
  latestPassedTest?: ToolCandidateTestRun;
  targetAgentId: string;
  allowedToolsBefore: string[];
  allowedToolsAfter: string[];
  effectiveVisibility: ActiveToolVisibility;
  policySnapshot: Record<string, unknown>;
};

export type LearnedToolBlueprintRecord = {
  id: string;
  capabilityFamily: CapabilityFamily;
  executorKind: "command_adapter";
  commandAdapterPlan: CommandAdapterPlan;
  requiredPermission: ToolPermission;
  testPlan: string;
  rollbackNote: string;
  sourceActiveToolIds: string[];
  evidenceSummary: Record<string, unknown>;
  createdAt: string;
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
const blueprintSuccessThreshold = 2;
const envAllowlist = new Set(["PATH", "SYSTEMROOT", "WINDIR", "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE"]);

const rawDraftSchema = z.object({
  targetToolId: z.unknown().optional(),
  capabilityFamily: z.unknown().optional(),
  permission: z.unknown().optional(),
  exposure: z.unknown().optional(),
  executorKind: z.unknown().optional(),
  executorPlan: z.unknown().optional(),
  inputSchemaDraft: z.unknown().optional(),
  safetyRationale: z.unknown().optional(),
  testPlan: z.unknown().optional(),
  rollbackPlan: z.unknown().optional(),
  groundingReferences: z.unknown().optional()
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
      const run = this.recordTest(candidate, "failed", "ts_module execution is blocked until the ts_module security roadmap.", {
        failureKind: "policy_denied"
      });
      this.saveCandidate({ ...candidate, status: "test_failed", updatedAt: new Date().toISOString() });
      return run;
    }
    const plan = candidate.executorPlan as CommandAdapterPlan;
    const result = await executeCommandAdapterPlan(plan, this.workspaceRoot);
    if (result.ok) {
      const run = this.recordTest(candidate, "passed", result.outputSummary, {
        exitCode: result.exitCode,
        durationMs: result.durationMs
      });
      this.saveCandidate({ ...candidate, status: "test_ready", updatedAt: new Date().toISOString() });
      return run;
    }
    const run = this.recordTest(candidate, "failed", result.outputSummary, {
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      failureKind: result.failureKind,
      failureReason: result.failureReason
    });
    this.saveCandidate({ ...candidate, status: "test_failed", updatedAt: new Date().toISOString() });
    return run;
  }

  async previewActivation(id: string, agentId: string): Promise<ToolActivationPreview> {
    const candidate = this.getCandidate(id);
    this.assertActivatable(candidate);
    const latestTest = this.latestPassedTest(candidate.id);
    const agents = new AgentManager(this.workspaceRoot);
    const manifest = await agents.loadAgent(agentId);
    const policy = await new PolicyManager(this.workspaceRoot).loadPolicy();
    const allowedToolsAfter = [...new Set([...manifest.allowedTools, candidate.targetToolId])];
    const projected: ActiveToolRecord = {
      id: candidate.targetToolId,
      candidateId: candidate.id,
      capabilityFamily: candidate.capabilityFamily,
      executorKind: candidate.executorKind,
      permission: candidate.permission,
      exposure: candidate.exposure,
      targetAgentIds: [agentId],
      status: "active",
      executorPlan: candidate.executorPlan,
      createdAt: new Date().toISOString(),
      activatedAt: new Date().toISOString(),
      policySnapshot: await this.policySnapshot(),
      evidence: {
        preview: true,
        candidateId: candidate.id,
        latestTestId: latestTest?.id
      }
    };
    return {
      candidate,
      latestPassedTest: latestTest,
      targetAgentId: agentId,
      allowedToolsBefore: [...manifest.allowedTools],
      allowedToolsAfter,
      effectiveVisibility: evaluateActiveToolVisibility(projected, agentId, allowedToolsAfter, policy),
      policySnapshot: await this.policySnapshot()
    };
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
    let manifestPathForRollback: string | undefined;
    let manifestContentForRollback: string | undefined;
    try {
      this.assertActivatable(candidate);
      const latestTest = this.latestPassedTest(candidate.id);
      if (!latestTest || latestTest.candidateContentHash !== candidate.candidateContentHash) {
        throw new Error("Tool activation requires a latest passed candidate test for the current candidate content.");
      }
      const agents = new AgentManager(this.workspaceRoot);
      const manifest = await agents.loadAgent(agentId);
      manifestContentForRollback = `${JSON.stringify(manifest, null, 2)}\n`;
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
      const manifestPath = join(this.workspaceRoot, "agents", agentId, "manifest.json");
      manifestPathForRollback = manifestPath;
      await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
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
      const rollbackEvidence: Record<string, unknown> = {};
      try {
        if (manifestPathForRollback && manifestContentForRollback) {
          await writeFile(manifestPathForRollback, manifestContentForRollback, "utf8");
          rollbackEvidence.agentManifestRestored = true;
        }
      } catch (rollbackError) {
        rollbackEvidence.agentManifestRestoreFailed = (rollbackError as Error).message;
      }
      try {
        const existing = getActiveToolRecord(this.workspaceRoot, candidate.targetToolId);
        if (existing?.status === "active") {
          this.withDb((db) => insertActiveTool(db, {
            ...existing,
            status: "deactivated",
            deactivatedAt: new Date().toISOString(),
            deactivateReason: "activation failure compensation"
          }));
          rollbackEvidence.activeToolCompensated = true;
        }
      } catch (rollbackError) {
        rollbackEvidence.activeToolCompensationFailed = (rollbackError as Error).message;
      }
      const failed: ToolActivationRecord = {
        ...activation,
        status: rollbackEvidence.activeToolCompensationFailed || rollbackEvidence.agentManifestRestoreFailed ? "rollback_failed" : "activation_failed",
        failedAt: new Date().toISOString(),
        reason: (error as Error).message,
        evidence: {
          error: (error as Error).message,
          ...rollbackEvidence
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
    this.withDb((db) => {
      insertActiveTool(db, next);
      insertActivation(db, {
        id: `act_${randomUUID().slice(0, 8)}`,
        candidateId: active.candidateId,
        toolId,
        targetAgentId: active.targetAgentIds[0] ?? "unknown",
        status: "deactivated",
        activeToolRecordId: active.id,
        policySnapshot: active.policySnapshot,
        evidence: {
          reason: redactText(reason),
          removedFromAgents: active.targetAgentIds
        },
        createdAt: now,
        appliedAt: now,
        reason: redactText(reason)
      });
    });
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

  listActiveToolExecutions(toolId: string): ActiveToolExecutionRecord[] {
    return this.withDb((db) => listActiveToolExecutionsFromDb(db, toolId));
  }

  async activeToolVisibility(toolId: string): Promise<ActiveToolVisibility[]> {
    const tool = this.getActiveTool(toolId);
    const policy = await new PolicyManager(this.workspaceRoot).loadPolicy();
    const agents = new AgentManager(this.workspaceRoot);
    const result: ActiveToolVisibility[] = [];
    for (const agentId of tool.targetAgentIds) {
      const manifest = await agents.loadAgent(agentId);
      result.push(evaluateActiveToolVisibility(tool, agentId, manifest.allowedTools, policy));
    }
    return result;
  }

  listBlueprints(): LearnedToolBlueprintRecord[] {
    return this.withDb((db) => {
      const rows = db.prepare("SELECT record_json FROM learned_tool_blueprints ORDER BY created_at DESC").all() as Array<{ record_json: string }>;
      return rows.map((row) => JSON.parse(row.record_json) as LearnedToolBlueprintRecord);
    });
  }

  getBlueprint(id: string): LearnedToolBlueprintRecord {
    const blueprint = this.withDb((db) => {
      const row = db.prepare("SELECT record_json FROM learned_tool_blueprints WHERE id = ?").get(id) as { record_json: string } | undefined;
      return row ? JSON.parse(row.record_json) as LearnedToolBlueprintRecord : undefined;
    });
    if (!blueprint) {
      throw new Error(`Learned blueprint not found: ${id}`);
    }
    return blueprint;
  }

  createBlueprintFromActive(toolId: string, options: { yes?: boolean } = {}): LearnedToolBlueprintRecord {
    if (!options.yes) {
      throw new Error("Learned blueprint creation requires --yes.");
    }
    const tool = this.getActiveTool(toolId);
    if (tool.executorKind !== "command_adapter") {
      throw new Error("Only active command_adapter tools can become learned local blueprints.");
    }
    if (!allowedPermissions.has(tool.permission)) {
      throw new Error(`Permission is not safe enough for learned blueprint creation: ${tool.permission}`);
    }
    const executions = this.listActiveToolExecutions(toolId);
    const passed = executions.filter((execution) => execution.status === "passed");
    const failures = executions.filter((execution) => execution.status === "failed");
    if (passed.length < blueprintSuccessThreshold) {
      throw new Error(`Learned blueprint requires at least ${blueprintSuccessThreshold} successful executions.`);
    }
    const failureRate = failures.length / Math.max(1, executions.length);
    if (failureRate > 0.25) {
      throw new Error("Recent failure rate is too high for learned blueprint creation.");
    }
    const evidenceText = JSON.stringify(executions.map((execution) => execution.outputSummary));
    if (detectSecrets(evidenceText).matched) {
      throw new Error("Secret-like execution evidence blocks learned blueprint creation.");
    }
    const now = new Date().toISOString();
    const blueprint: LearnedToolBlueprintRecord = {
      id: `blueprint_${randomUUID().slice(0, 8)}`,
      capabilityFamily: tool.capabilityFamily,
      executorKind: "command_adapter",
      commandAdapterPlan: sanitizeCommandAdapterPlan(tool.executorPlan as CommandAdapterPlan),
      requiredPermission: tool.permission,
      testPlan: "Run the fixed command_adapter plan with timeout, output cap, and redaction before activation.",
      rollbackNote: "Deactivate active tool and remove it from agent allowedTools.",
      sourceActiveToolIds: [tool.id],
      evidenceSummary: {
        successfulExecutions: passed.length,
        failedExecutions: failures.length,
        failureRate,
        sourceCandidateId: tool.candidateId
      },
      createdAt: now
    };
    this.withDb((db) => insertLearnedBlueprint(db, blueprint));
    return blueprint;
  }

  private async createLlmDraft(capability: CapabilityProposal, sourceShellApprovalIds: string[], providerId = "default"): Promise<Record<string, unknown>> {
    const policy = await new PolicyManager(this.workspaceRoot).loadPolicy();
    const resolvedProviderId = resolveProviderSelection(policy, providerId);
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
      inputSchemaDraft: normalizeInputSchemaDraft(raw.inputSchemaDraft, warnings),
      safetyRationale: normalizeDraftText(raw.safetyRationale, "Review required before activation.", "safetyRationale", warnings),
      testPlan: normalizeDraftText(raw.testPlan, "Run candidate test before activation.", "testPlan", warnings),
      rollbackPlan: normalizeDraftText(raw.rollbackPlan, "Deactivate active tool and remove it from agent allowedTools.", "rollbackPlan", warnings),
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

  private recordTest(candidate: ToolCandidateRecord, status: ToolCandidateTestStatus, outputSummary: string, evidence: Record<string, unknown> = {}): ToolCandidateTestRun {
    const run: ToolCandidateTestRun = {
      id: `test_${randomUUID().slice(0, 8)}`,
      candidateId: candidate.id,
      candidateContentHash: candidate.candidateContentHash,
      status,
      testedAt: new Date().toISOString(),
      evidence: {
        executorKind: candidate.executorKind,
        ...evidence
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

export function recordActiveToolExecution(workspaceRoot: string, input: Omit<ActiveToolExecutionRecord, "id" | "createdAt">): ActiveToolExecutionRecord {
  const record: ActiveToolExecutionRecord = {
    id: `exec_${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    ...input,
    outputSummary: summarizeOutput(input.outputSummary)
  };
  withToolDb(workspaceRoot, (db) => insertActiveToolExecution(db, record));
  return record;
}

export async function executeCommandAdapterPlan(plan: CommandAdapterPlan, workspaceRoot: string): Promise<CommandAdapterExecutionResult> {
  const started = Date.now();
  const policyDenied = validateCommandAdapterPlanForExecution(plan);
  if (policyDenied) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      outputSummary: policyDenied,
      failureKind: "policy_denied",
      failureReason: policyDenied
    };
  }
  try {
    const result = await execFileAsync(plan.executable, plan.args, {
      cwd: workspaceRoot,
      timeout: plan.timeoutMs,
      maxBuffer: plan.outputCapBytes,
      env: commandAdapterEnv(),
      windowsHide: true
    });
    return {
      ok: true,
      exitCode: 0,
      durationMs: Date.now() - started,
      outputSummary: summarizeOutput(formatCommandAdapterOutput(result.stdout ?? "", result.stderr ?? ""))
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    const exitCode = typeof err.code === "number" ? err.code : undefined;
    const failureKind: ActiveToolExecutionFailureKind = err.killed
      ? "timeout"
      : typeof err.code === "number"
        ? "non_zero_exit"
        : "spawn_failed";
    return {
      ok: false,
      exitCode,
      durationMs: Date.now() - started,
      outputSummary: summarizeOutput(`Exit code: ${String(err.code ?? "unknown")}\n${formatCommandAdapterOutput(err.stdout ?? "", err.stderr ?? err.message)}`),
      failureKind,
      failureReason: redactText(err.message)
    };
  }
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
  return tools.map((tool) => `${tool.id}\t${tool.status}\t${tool.executorKind}\t${tool.permission}\texposure:${tool.exposure}\tagents:${tool.targetAgentIds.join(",")}`).join("\n");
}

export function formatActiveToolVisibility(visibility: ActiveToolVisibility[]): string {
  if (!visibility.length) {
    return "Effective visibility: no target agents";
  }
  return [
    "Effective visibility:",
    ...visibility.map((item) => `- ${item.agentId}: ${item.visible ? "visible" : "hidden"}${item.reasons.length ? ` (${item.reasons.join("; ")})` : ""}`)
  ].join("\n");
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

export function formatToolActivationPreview(preview: ToolActivationPreview): string {
  return [
    "Tool activation preview",
    `Candidate: ${preview.candidate.id}`,
    `Target tool: ${preview.candidate.targetToolId}`,
    `Target agent: ${preview.targetAgentId}`,
    `Executor: ${preview.candidate.executorKind}`,
    `Permission: ${preview.candidate.permission}`,
    `Exposure: ${preview.candidate.exposure}`,
    preview.latestPassedTest
      ? `Latest passed test: ${preview.latestPassedTest.id} hash:${preview.latestPassedTest.candidateContentHash}`
      : "Latest passed test: none",
    `Allowed tools before: ${preview.allowedToolsBefore.join(", ") || "-"}`,
    `Allowed tools after: ${preview.allowedToolsAfter.join(", ") || "-"}`,
    `Expected model visibility: ${preview.effectiveVisibility.visible ? "visible" : "hidden"}`,
    preview.effectiveVisibility.reasons.length ? `Visibility reasons: ${preview.effectiveVisibility.reasons.join("; ")}` : undefined,
    "",
    "No changes made. Re-run with --yes to activate."
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function formatLearnedBlueprintList(blueprints: LearnedToolBlueprintRecord[]): string {
  if (!blueprints.length) {
    return "No learned local blueprints.";
  }
  return blueprints.map((blueprint) => `${blueprint.id}\t${blueprint.capabilityFamily}\t${blueprint.requiredPermission}\tsources:${blueprint.sourceActiveToolIds.join(",")}`).join("\n");
}

export function formatLearnedBlueprint(blueprint: LearnedToolBlueprintRecord): string {
  return [
    `Learned blueprint: ${blueprint.id}`,
    `Capability: ${blueprint.capabilityFamily}`,
    `Executor: ${blueprint.executorKind}`,
    `Permission: ${blueprint.requiredPermission}`,
    `Source active tools: ${blueprint.sourceActiveToolIds.join(", ")}`,
    "",
    "Command adapter plan:",
    JSON.stringify(blueprint.commandAdapterPlan, null, 2),
    "",
    "Evidence summary:",
    JSON.stringify(blueprint.evidenceSummary, null, 2),
    "",
    "This blueprint is advisory only and is not active automatically."
  ].join("\n");
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
    CREATE TABLE IF NOT EXISTS active_tool_executions (
      id TEXT PRIMARY KEY,
      tool_id TEXT NOT NULL,
      status TEXT NOT NULL,
      failure_kind TEXT,
      exit_code INTEGER,
      duration_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_active_tool_executions_tool_id ON active_tool_executions(tool_id);
    CREATE TABLE IF NOT EXISTS learned_tool_blueprints (
      id TEXT PRIMARY KEY,
      capability_family TEXT NOT NULL,
      executor_kind TEXT NOT NULL,
      required_permission TEXT NOT NULL,
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

function insertActiveToolExecution(db: DatabaseSync, record: ActiveToolExecutionRecord): void {
  db.prepare(`
    INSERT OR REPLACE INTO active_tool_executions (id, tool_id, status, failure_kind, exit_code, duration_ms, created_at, record_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.toolId,
    record.status,
    record.failureKind ?? null,
    record.exitCode ?? null,
    record.durationMs,
    record.createdAt,
    JSON.stringify(record)
  );
}

function listActiveToolExecutionsFromDb(db: DatabaseSync, toolId: string): ActiveToolExecutionRecord[] {
  const rows = db.prepare("SELECT record_json FROM active_tool_executions WHERE tool_id = ? ORDER BY created_at DESC").all(toolId) as Array<{ record_json: string }>;
  return rows.map((row) => JSON.parse(row.record_json) as ActiveToolExecutionRecord);
}

function insertLearnedBlueprint(db: DatabaseSync, blueprint: LearnedToolBlueprintRecord): void {
  db.prepare(`
    INSERT OR REPLACE INTO learned_tool_blueprints (id, capability_family, executor_kind, required_permission, created_at, record_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    blueprint.id,
    blueprint.capabilityFamily,
    blueprint.executorKind,
    blueprint.requiredPermission,
    blueprint.createdAt,
    JSON.stringify(blueprint)
  );
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

function normalizeInputSchemaDraft(value: unknown, warnings: string[]): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  warnings.push("inputSchemaDraft discarded: expected object");
  return {};
}

function normalizeDraftText(value: unknown, fallback: string, field: string, warnings: string[]): string {
  if (value === undefined || value === null) {
    return redactText(fallback);
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    warnings.push(`${field} normalized from array to text`);
    return redactText(value.map((item) => stringifyDraftTextPart(item)).join("\n"));
  }
  if (typeof value === "object") {
    warnings.push(`${field} normalized from object to text`);
    return redactText(stableStringifyDraftValue(value));
  }
  warnings.push(`${field} normalized from ${typeof value} to text`);
  return redactText(String(value));
}

function stringifyDraftTextPart(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "object") {
    return stableStringifyDraftValue(value);
  }
  return String(value);
}

function stableStringifyDraftValue(value: unknown): string {
  return JSON.stringify(sortDraftValue(value), null, 2);
}

function sortDraftValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDraftValue);
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = sortDraftValue((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  return value;
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

function formatCommandAdapterOutput(stdout: string, stderr: string): string {
  const sections: string[] = [];
  if (stdout.trim()) {
    sections.push(stdout.trimEnd());
  }
  if (stderr.trim()) {
    sections.push(`stderr:\n${stderr.trimEnd()}`);
  }
  return sections.join("\n\n") || "No output.";
}

function validateCommandAdapterPlanForExecution(plan: CommandAdapterPlan): string | undefined {
  if (plan.cwdPolicy !== "workspace_root") {
    return "command_adapter cwdPolicy must be workspace_root.";
  }
  if (plan.redaction !== true) {
    return "command_adapter redaction must be true.";
  }
  if (!plan.executable.trim() || !Array.isArray(plan.args) || plan.args.some((arg) => typeof arg !== "string")) {
    return "command_adapter requires fixed executable and fixed args.";
  }
  if (/[;&|$()<>]/.test(plan.executable) || plan.args.some((arg) => /[;&|$()<>]/.test(arg))) {
    return "command_adapter fixed executable/args cannot contain shell metacharacters.";
  }
  if (/[{}]/.test(plan.executable) || plan.args.some((arg) => /[{}]/.test(arg))) {
    return "command_adapter does not allow interpolation-like placeholders.";
  }
  return undefined;
}

function commandAdapterEnv(): NodeJS.ProcessEnv {
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

function evaluateActiveToolVisibility(tool: ActiveToolRecord, agentId: string, allowedTools: string[], policy: PolicyConfig | undefined): ActiveToolVisibility {
  const reasons: string[] = [];
  if (tool.status !== "active") {
    reasons.push(`status=${tool.status}`);
  }
  if (tool.exposure !== "model") {
    reasons.push(`exposure=${tool.exposure}`);
  }
  if (!tool.targetAgentIds.includes(agentId)) {
    reasons.push("agent not targeted");
  }
  if (!allowedTools.includes(tool.id)) {
    reasons.push("agent allowedTools missing tool id");
  }
  if ((policy?.disabledPermissions ?? []).includes(tool.permission)) {
    reasons.push(`permission disabled: ${tool.permission}`);
  }
  return {
    agentId,
    visible: reasons.length === 0,
    reasons
  };
}

function sanitizeCommandAdapterPlan(plan: CommandAdapterPlan): CommandAdapterPlan {
  return {
    executable: plan.executable,
    args: [...plan.args],
    cwdPolicy: "workspace_root",
    timeoutMs: plan.timeoutMs,
    outputCapBytes: plan.outputCapBytes,
    redaction: true
  };
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
