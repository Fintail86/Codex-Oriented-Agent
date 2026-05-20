import { relative } from "node:path";
import { detectSecrets } from "../risk_classifier.js";
import type { SkillCandidateRecord } from "../types.js";
import { highRiskConfirmPhrase, type PromoteSkillResult } from "./skill_candidates.js";
import type { SkillCheckResult } from "./skill_mirror.js";
import type { SkillMigrationResult } from "./skill_migration.js";
import type { SkillSelectionExplainRow } from "./skill_selector.js";
import { pad, preview } from "./skill_text.js";

export function formatSkillCandidate(record: SkillCandidateRecord): string {
  const secret = detectSecrets(record.content);
  const content = secret.matched ? secret.redactedPreview : preview(record.content);
  const triggerText = record.triggers.length ? record.triggers.join(", ") : "manual-only";
  const suggestedBy = record.suggestedByAgentId ?? record.agentId;
  return `${record.id}\t${record.status}\t${record.riskLevel}\t${record.skillId}\tsuggestedBy:${suggestedBy}\ttriggers:${triggerText}\t${content}`;
}

export function formatSkillPromotionPreview(result: PromoteSkillResult): string {
  const secret = detectSecrets(result.record.content);
  const content = secret.matched ? secret.redactedPreview : preview(result.record.content);
  const lines = [
    result.changed ? "Promoted skill candidate." : "Skill promotion preview. No changes made.",
    `Candidate: ${result.record.id}`,
    `Suggested by: ${result.record.suggestedByAgentId ?? result.record.agentId}`,
    `Skill: ${result.record.skillId}`,
    `Risk: ${result.record.riskLevel}`,
    `Triggers: ${result.record.triggers.length ? result.record.triggers.join(", ") : "manual-only"}`,
    `Skill file: ${relative(process.cwd(), result.skillPath)}`,
    `Metadata: ${relative(process.cwd(), result.metadataPath)}`,
    `SKILLS mirror: ${relative(process.cwd(), result.skillsIndexPath)}`,
    `Prefer for: ${result.preferredAgentId ?? "none"}`,
    `Content: ${content}`
  ];
  if (result.warning) {
    lines.push(result.warning);
  }
  if (!result.changed) {
    lines.push("Re-run with --yes to apply this promotion.");
  }
  if (result.record.riskLevel === "high") {
    lines.push(`High-risk confirmation: --confirm-high-risk "${highRiskConfirmPhrase}"`);
  }
  return lines.join("\n");
}

export function formatSkillCheckResult(result: SkillCheckResult): string {
  const lines = [
    `Scope: ${result.scope}${result.agentId ? ` ${result.agentId}` : ""}`,
    `SKILLS.md: ${result.mirrorMatches ? "ok" : "stale/missing"}`,
    `Skill files: ${result.missingSkillFiles.length ? "missing files" : "ok"}`,
    `Skill metadata: ${result.missingMetadataFiles.length ? "missing metadata" : "ok"}`
  ];
  if (result.repaired) {
    lines.push("Repaired: SKILLS.md");
  }
  for (const skillId of result.manualOnlySkills) {
    lines.push(`Warning: ${skillId} is manual-only because it has no triggers.`);
  }
  for (const skillId of result.orphanSkillFiles) {
    lines.push(`Warning: orphan skill file is not listed in global metadata: ${skillId}.md`);
  }
  for (const skillId of result.missingSkillFiles) {
    lines.push(`Error: skill metadata is missing its file: ${skillId}.md`);
  }
  for (const skillId of result.missingPreferredSkills) {
    lines.push(`Error: preferred skill does not exist: ${skillId}`);
  }
  for (const skillId of result.missingBlockedSkills) {
    lines.push(`Error: blocked skill does not exist: ${skillId}`);
  }
  return lines.join("\n");
}

export function formatSkillSelectionExplanation(rows: SkillSelectionExplainRow[]): string {
  if (!rows.length) {
    return "No skills.";
  }
  const header = [
    pad("Skill", 28),
    pad("Status", 8),
    pad("Total", 5),
    pad("Trigger", 7),
    pad("Pref", 4),
    pad("Weight", 6),
    "Reason"
  ].join("  ");
  const body = rows.map((row) => [
    pad(row.skillId, 28),
    pad(row.status, 8),
    pad(String(row.finalScore), 5),
    pad(String(row.triggerScore), 7),
    pad(String(row.preferredBonus), 4),
    pad(String(row.weightBonus), 6),
    row.reason
  ].join("  "));
  return [header, ...body].join("\n");
}

export function formatSkillMigrationResult(result: SkillMigrationResult): string {
  const lines = [
    result.changed ? "Migrated legacy agent skills." : "Skill migration preview. No changes made.",
    `Agent: ${result.agentId}`,
    `Migratable: ${result.migrated.length ? result.migrated.join(", ") : "none"}`
  ];
  for (const skipped of result.skipped) {
    lines.push(`Skipped: ${skipped.skillId} (${skipped.reason})`);
  }
  if (!result.changed && result.migrated.length) {
    lines.push("Re-run with --yes to migrate these skills.");
  }
  return lines.join("\n");
}
