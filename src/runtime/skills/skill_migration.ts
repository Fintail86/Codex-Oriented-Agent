import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { skillMetadataSchema, type AgentManifest, type SkillMetadata } from "../types.js";
import { SkillMirror } from "./skill_mirror.js";
import { SkillStore } from "./skill_store.js";
import { normalizeTriggers, titleFromMarkdown } from "./skill_text.js";

export type SkillMigrationResult = {
  agentId: string;
  changed: boolean;
  migrated: string[];
  skipped: Array<{ skillId: string; reason: string }>;
};

export class SkillMigration {
  constructor(
    private readonly store: SkillStore,
    private readonly mirror: SkillMirror
  ) {}

  migrateAgentSkills(agentId: string, yes = false): SkillMigrationResult {
    const manifest = this.store.readAgentManifest(agentId);
    const legacyDir = join(this.store.agentDir(agentId), "skills");
    const result: SkillMigrationResult = {
      agentId,
      changed: false,
      migrated: [],
      skipped: []
    };
    if (!existsSync(legacyDir)) {
      return result;
    }
    const legacyFiles = readdirSync(legacyDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -3))
      .sort((left, right) => left.localeCompare(right));
    const now = new Date().toISOString();
    const preferred = new Set(manifest.preferredSkills);
    for (const skillId of legacyFiles) {
      if (existsSync(this.store.skillPath(skillId)) || existsSync(this.store.skillMetadataPath(skillId))) {
        result.skipped.push({ skillId, reason: "global skill already exists" });
        continue;
      }
      result.migrated.push(skillId);
      if (!yes) {
        continue;
      }
      const legacyPath = join(legacyDir, `${skillId}.md`);
      const content = readFileSync(legacyPath, "utf8");
      const metadata: SkillMetadata = {
        id: skillId,
        name: titleFromMarkdown(content) ?? skillId,
        triggers: normalizeTriggers(manifest.skillTriggers?.[skillId] ?? []),
        riskLevel: "low",
        createdAt: now,
        updatedAt: now,
        suggestedByAgentId: agentId
      };
      this.store.writeSkillFiles(skillId, content, skillMetadataSchema.parse(metadata));
      preferred.add(skillId);
    }
    if (yes && result.migrated.length) {
      const nextManifest: AgentManifest = {
        ...manifest,
        preferredSkills: [...preferred].sort((left, right) => left.localeCompare(right))
      };
      this.store.writeAgentManifest(agentId, nextManifest);
      this.mirror.syncSkillsIndex();
      this.mirror.syncSkillsIndex(agentId);
      result.changed = true;
    }
    return result;
  }
}
