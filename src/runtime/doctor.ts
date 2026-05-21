import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { AgentManager } from "./agent_manager.js";
import { ensureDir, pathExists, writeText } from "./fs_utils.js";
import { initProject } from "./init_project.js";
import { MemoryManager } from "./memory_manager.js";
import { PolicyManager } from "./policy_manager.js";
import { SkillManager } from "./skill_manager.js";
import { formatStatusReport, getStatusReport, type StatusReport } from "./status_report.js";

export type DoctorRepairResult = {
  changed: boolean;
  created: string[];
  repaired: string[];
  warnings: string[];
};

export type ResetMode = "state" | "factory";

export type ResetEntry = {
  source: string;
  backup: string;
  copied: boolean;
  verified: boolean;
  deleted: boolean;
};

export type ResetPlan = {
  id: string;
  mode: ResetMode;
  workspaceRoot: string;
  backupRoot: string;
  entries: ResetEntry[];
};

export type ResetResult = ResetPlan & {
  applied: boolean;
  phase: "preview" | "copy" | "verify" | "delete_originals" | "recreate" | "completed";
  status: "preview" | "completed" | "failed";
  error?: string;
  recoveryManifestPath?: string;
};

const stateConfirmPhrase = "RESET COSIA STATE";
const factoryConfirmPhrase = "RESET COSIA WORKSPACE";

export async function getDoctorReport(workspaceRoot: string, providerId = "default"): Promise<StatusReport> {
  return getStatusReport(workspaceRoot, providerId);
}

export async function repairDoctor(workspaceRoot: string): Promise<DoctorRepairResult> {
  const created: string[] = [];
  const repaired: string[] = [];
  const warnings: string[] = [];
  const policyManager = new PolicyManager(workspaceRoot);
  const policyResult = await policyManager.checkPolicy(true, true);
  created.push(...policyResult.created);
  repaired.push(...policyResult.repaired);
  if (policyResult.errors.length) {
    warnings.push(...policyResult.errors);
  }

  let policy;
  try {
    policy = await policyManager.loadPolicy();
  } catch (error) {
    warnings.push((error as Error).message);
  }

  const agents = new AgentManager(workspaceRoot);
  if (policy) {
    created.push(...await agents.ensureDefaultAgent(policy.agents.defaultAgentId));
  }
  for (const agent of await agents.listAgents()) {
    await agents.loadAgent(agent.id);
  }

  const skills = new SkillManager(workspaceRoot);
  skills.ensureSkillFiles();
  const globalSkillCheck = skills.checkSkills(undefined, true);
  if (globalSkillCheck.repaired) {
    repaired.push("skills/SKILLS.md");
  }
  for (const agent of await agents.listAgents()) {
    const agentSkillCheck = skills.checkSkills(agent.id, true);
    if (agentSkillCheck.repaired) {
      repaired.push(`agents/${agent.id}/SKILLS.md`);
    }
    for (const warning of [
      ...agentSkillCheck.missingPreferredSkills.map((skill) => `Agent ${agent.id} prefers missing skill ${skill}`),
      ...agentSkillCheck.missingBlockedSkills.map((skill) => `Agent ${agent.id} blocks missing skill ${skill}`)
    ]) {
      warnings.push(warning);
    }
  }

  new MemoryManager(workspaceRoot).ensureSchema();
  skills.ensureSchema();
  return {
    changed: created.length > 0 || repaired.length > 0,
    created: uniqueSorted(created),
    repaired: uniqueSorted(repaired),
    warnings: uniqueSorted(warnings)
  };
}

export async function previewReset(workspaceRoot: string, mode: ResetMode): Promise<ResetResult> {
  return {
    ...await buildResetPlan(workspaceRoot, mode),
    applied: false,
    phase: "preview",
    status: "preview"
  };
}

export async function applyReset(workspaceRoot: string, mode: ResetMode, confirm: string | undefined): Promise<ResetResult> {
  const expectedConfirm = mode === "state" ? stateConfirmPhrase : factoryConfirmPhrase;
  if (confirm !== expectedConfirm) {
    throw new Error(`Reset requires --confirm "${expectedConfirm}".`);
  }
  const plan = await buildResetPlan(workspaceRoot, mode);
  const result: ResetResult = {
    ...plan,
    applied: true,
    phase: "copy",
    status: "completed"
  };
  try {
    await mkdir(plan.backupRoot, { recursive: true });
    for (const entry of result.entries) {
      await mkdir(dirname(absBackup(workspaceRoot, entry)), { recursive: true });
      await cp(absSource(workspaceRoot, entry), absBackup(workspaceRoot, entry), {
        recursive: true,
        errorOnExist: true,
        force: false
      });
      entry.copied = true;
    }

    result.phase = "verify";
    for (const entry of result.entries) {
      await verifyCopied(absSource(workspaceRoot, entry), absBackup(workspaceRoot, entry));
      entry.verified = true;
    }

    result.phase = "delete_originals";
    for (const entry of result.entries) {
      await rm(absSource(workspaceRoot, entry), { recursive: true, force: true });
      entry.deleted = true;
    }

    result.phase = "recreate";
    if (mode === "factory") {
      await initProject(workspaceRoot);
    } else {
      await ensureDir(join(workspaceRoot, "sessions"));
      await ensureDir(join(workspaceRoot, "memory"));
      new MemoryManager(workspaceRoot).ensureSchema();
    }
    result.phase = "completed";
    return result;
  } catch (error) {
    result.status = "failed";
    result.error = (error as Error).message;
    result.recoveryManifestPath = await writeRecoveryManifest(result);
    throw new Error(`Reset failed during ${result.phase}. Recovery manifest: ${result.recoveryManifestPath}. ${result.error}`);
  }
}

export function formatDoctorReport(report: StatusReport): string {
  return [
    "COSIA Doctor",
    "",
    formatStatusReport(report, { compact: true }),
    "",
    "Findings:",
    ...(report.issues.length
      ? report.issues.map((issue) => `- [${issue.severity}] ${issue.title}: ${issue.detail}${issue.action ? `\n  Action: ${issue.action}` : ""}`)
      : ["- No issues detected."]),
    "",
    "Safe repair:",
    "  cosia doctor repair"
  ].join("\n");
}

export function formatDoctorRepair(result: DoctorRepairResult): string {
  return [
    "COSIA Doctor Repair",
    `Changed: ${result.changed}`,
    `Created: ${result.created.length ? result.created.join(", ") : "none"}`,
    `Repaired: ${result.repaired.length ? result.repaired.join(", ") : "none"}`,
    `Warnings: ${result.warnings.length ? result.warnings.join("; ") : "none"}`
  ].join("\n");
}

export function formatResetResult(result: ResetResult): string {
  const lines = [
    `COSIA ${result.mode} reset ${result.applied ? "result" : "preview"}`,
    `Applied: ${result.applied}`,
    `Status: ${result.status}`,
    `Reset id: ${result.id}`,
    `Backup: ${relative(result.workspaceRoot, result.backupRoot)}`,
    "Entries:"
  ];
  if (!result.entries.length) {
    lines.push("  none");
  } else {
    for (const entry of result.entries) {
      lines.push(`  ${entry.source} -> ${entry.backup} copied:${entry.copied} verified:${entry.verified} deleted:${entry.deleted}`);
    }
  }
  if (!result.applied) {
    const confirm = result.mode === "state" ? stateConfirmPhrase : factoryConfirmPhrase;
    lines.push("");
    lines.push("No files changed.");
    lines.push(`Re-run with --yes --confirm "${confirm}" to apply.`);
  }
  if (result.recoveryManifestPath) {
    lines.push(`Recovery manifest: ${result.recoveryManifestPath}`);
  }
  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }
  return lines.join("\n");
}

async function buildResetPlan(workspaceRoot: string, mode: ResetMode): Promise<ResetPlan> {
  const id = `reset_${timestampId(new Date())}`;
  const backupRoot = join(workspaceRoot, ".cosia-reset-backups", id);
  const sources = mode === "factory"
    ? await factoryResetSources(workspaceRoot)
    : await stateResetSources(workspaceRoot);
  return {
    id,
    mode,
    workspaceRoot,
    backupRoot,
    entries: sources.map((source) => ({
      source,
      backup: join(".cosia-reset-backups", id, source).replaceAll("\\", "/"),
      copied: false,
      verified: false,
      deleted: false
    }))
  };
}

async function factoryResetSources(workspaceRoot: string): Promise<string[]> {
  const candidates = ["codex", "agents", "skills", "sessions", "memory"];
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(join(workspaceRoot, candidate))) {
      existing.push(candidate);
    }
  }
  return existing;
}

async function stateResetSources(workspaceRoot: string): Promise<string[]> {
  const sources: string[] = [];
  if (await pathExists(join(workspaceRoot, "sessions"))) {
    sources.push("sessions");
  }
  const memoryRoot = join(workspaceRoot, "memory");
  if (await pathExists(memoryRoot)) {
    for (const entry of await readdir(memoryRoot, { withFileTypes: true })) {
      sources.push(`memory/${entry.name}`);
    }
  }
  return sources.sort();
}

async function verifyCopied(source: string, backup: string): Promise<void> {
  const [sourceStat, backupStat] = await Promise.all([stat(source), stat(backup)]);
  if (sourceStat.isFile() && backupStat.isFile() && sourceStat.size !== backupStat.size) {
    throw new Error(`Backup size mismatch: ${source}`);
  }
}

async function writeRecoveryManifest(result: ResetResult): Promise<string> {
  const path = join(result.backupRoot, "recovery_manifest.json");
  await writeText(path, `${JSON.stringify({
    id: result.id,
    mode: result.mode,
    createdAt: new Date().toISOString(),
    workspaceRoot: result.workspaceRoot,
    backupRoot: result.backupRoot,
    phase: result.phase,
    status: result.status,
    entries: result.entries,
    error: result.error
  }, null, 2)}\n`);
  return path;
}

function absSource(workspaceRoot: string, entry: ResetEntry): string {
  return join(workspaceRoot, entry.source);
}

function absBackup(workspaceRoot: string, entry: ResetEntry): string {
  return join(workspaceRoot, entry.backup);
}

function timestampId(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
