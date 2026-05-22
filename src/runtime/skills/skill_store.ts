import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentManifestSchema,
  skillMetadataSchema,
  type AgentManifest,
  type SkillCandidateRecord,
  type SkillMetadata
} from "../types.js";
import { clampSkillWeight } from "./skill_text.js";

export type SkillRecord = SkillMetadata & {
  path: string;
  metadataPath: string;
  content: string;
  manualOnly: boolean;
};

export class SkillStore {
  constructor(private readonly workspaceRoot: string) {}

  ensureSkillsDir(): void {
    if (!existsSync(this.skillsDir())) {
      mkdirSync(this.skillsDir(), { recursive: true });
    }
  }

  ensureMemoryDir(): void {
    const dir = join(this.workspaceRoot, "memory");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  listSkills(): SkillRecord[] {
    this.ensureSkillsDir();
    return this.readSkillRecords();
  }

  getSkill(skillId: string): SkillRecord {
    const resolvedSkillId = this.resolveSkillId(skillId);
    const skill = this.readSkillRecord(resolvedSkillId);
    if (!existsSync(skill.path)) {
      throw new Error(`Skill file not found: ${resolvedSkillId}`);
    }
    return skill;
  }

  resolveSkillId(skillId: string): string {
    return resolveSkillId(this.readSkillRecords().map((skill) => skill.id), skillId);
  }

  readAgentManifest(agentId: string): AgentManifest {
    const manifestPath = join(this.agentDir(agentId), "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`Agent manifest not found: ${agentId}`);
    }
    return agentManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  }

  writeAgentManifest(agentId: string, manifest: AgentManifest): void {
    writeFileSync(join(this.agentDir(agentId), "manifest.json"), `${JSON.stringify(serializeAgentManifest(agentManifestSchema.parse(manifest)), null, 2)}\n`, "utf8");
  }

  preferSkill(skillId: string, agentId: string, weight?: number): AgentManifest {
    const resolvedSkillId = this.resolveSkillId(skillId);
    const manifest = this.readAgentManifest(agentId);
    if (manifest.blockedSkills.includes(resolvedSkillId)) {
      throw new Error(`Cannot prefer a blocked skill: ${resolvedSkillId}`);
    }
    const next: AgentManifest = {
      ...manifest,
      preferredSkills: [...new Set([...manifest.preferredSkills, resolvedSkillId])],
      skillWeights: weight === undefined
        ? manifest.skillWeights
        : { ...manifest.skillWeights, [resolvedSkillId]: clampSkillWeight(weight) }
    };
    this.writeAgentManifest(agentId, next);
    return next;
  }

  unpreferSkill(skillId: string, agentId: string): AgentManifest {
    const resolvedSkillId = this.resolveSkillId(skillId);
    const manifest = this.readAgentManifest(agentId);
    const next: AgentManifest = {
      ...manifest,
      preferredSkills: manifest.preferredSkills.filter((id) => id !== resolvedSkillId),
      skillWeights: Object.fromEntries(Object.entries(manifest.skillWeights).filter(([id]) => id !== resolvedSkillId))
    };
    this.writeAgentManifest(agentId, next);
    return next;
  }

  blockSkill(skillId: string, agentId: string): AgentManifest {
    const resolvedSkillId = this.resolveSkillId(skillId);
    const manifest = this.readAgentManifest(agentId);
    const next: AgentManifest = {
      ...manifest,
      blockedSkills: [...new Set([...manifest.blockedSkills, resolvedSkillId])],
      preferredSkills: manifest.preferredSkills.filter((id) => id !== resolvedSkillId),
      skillWeights: Object.fromEntries(Object.entries(manifest.skillWeights).filter(([id]) => id !== resolvedSkillId))
    };
    this.writeAgentManifest(agentId, next);
    return next;
  }

  unblockSkill(skillId: string, agentId: string): AgentManifest {
    const resolvedSkillId = this.resolveSkillId(skillId);
    const manifest = this.readAgentManifest(agentId);
    const next: AgentManifest = {
      ...manifest,
      blockedSkills: manifest.blockedSkills.filter((id) => id !== resolvedSkillId)
    };
    this.writeAgentManifest(agentId, next);
    return next;
  }

  writeSkillFromCandidate(record: SkillCandidateRecord, metadata: SkillMetadata): void {
    writeFileSync(this.skillPath(record.skillId), renderSkillFile(record), "utf8");
    writeFileSync(this.skillMetadataPath(record.skillId), `${JSON.stringify(skillMetadataSchema.parse(metadata), null, 2)}\n`, "utf8");
  }

  writeSkillFiles(skillId: string, content: string, metadata: SkillMetadata): void {
    writeFileSync(this.skillPath(skillId), content, "utf8");
    writeFileSync(this.skillMetadataPath(skillId), `${JSON.stringify(skillMetadataSchema.parse(metadata), null, 2)}\n`, "utf8");
  }

  deleteSkillFiles(skillId: string): void {
    for (const filePath of [this.skillPath(skillId), this.skillMetadataPath(skillId)]) {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    }
  }

  readSkillRecords(): SkillRecord[] {
    this.ensureSkillsDir();
    return readdirSync(this.skillsDir(), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -5))
      .map((skillId) => this.readSkillRecord(skillId))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  readSkillRecord(skillId: string): SkillRecord {
    const metadataPath = this.skillMetadataPath(skillId);
    if (!existsSync(metadataPath)) {
      throw new Error(`Skill metadata not found: ${skillId}`);
    }
    const metadata = skillMetadataSchema.parse(JSON.parse(readFileSync(metadataPath, "utf8")));
    const path = this.skillPath(metadata.id);
    const content = existsSync(path) ? readFileSync(path, "utf8") : "";
    return {
      ...metadata,
      path,
      metadataPath,
      content,
      manualOnly: metadata.triggers.length === 0
    };
  }

  readSkillMarkdownIds(): string[] {
    this.ensureSkillsDir();
    return readdirSync(this.skillsDir(), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "SKILLS.md")
      .map((entry) => entry.name.slice(0, -3));
  }

  agentDir(agentId: string): string {
    return join(this.workspaceRoot, "agents", agentId);
  }

  skillsDir(): string {
    return join(this.workspaceRoot, "skills");
  }

  skillPath(skillId: string): string {
    return join(this.skillsDir(), `${skillId}.md`);
  }

  skillMetadataPath(skillId: string): string {
    return join(this.skillsDir(), `${skillId}.json`);
  }

  globalSkillsIndexPath(): string {
    return join(this.skillsDir(), "SKILLS.md");
  }

  agentSkillsIndexPath(agentId: string): string {
    return join(this.agentDir(agentId), "SKILLS.md");
  }
}

export function resolveSkillId(skills: string[], skillId: string): string {
  const normalized = skillId.trim();
  const matches = skills.filter((id) => id === normalized || id.startsWith(normalized));
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`Skill id prefix is ambiguous: ${skillId}. Matches: ${matches.join(", ")}`);
  }
  throw new Error(`Skill not found: ${skillId}`);
}

function renderSkillFile(record: SkillCandidateRecord): string {
  return `# ${record.skillName}

<!-- COSIA global skill id: ${record.skillId} -->

## Purpose

${record.reason}

## Instructions

${record.content.trim()}
`;
}

function serializeAgentManifest(manifest: AgentManifest): Record<string, unknown> {
  const output: Record<string, unknown> = { ...manifest };
  if (!manifest.skills.length) {
    delete output.skills;
  }
  if (!Object.keys(manifest.skillTriggers ?? {}).length) {
    delete output.skillTriggers;
  }
  return output;
}
