import type { AgentManifest } from "../types.js";
import { SkillStore, type SkillRecord } from "./skill_store.js";
import {
  clampSkillWeight,
  escapeXmlAttribute,
  indentXmlText,
  neutralizeXmlBoundaries,
  normalizeTriggerText,
  normalizeTriggers,
  triggerMatches,
  truncateSkillContent
} from "./skill_text.js";

export type SkillTriggerMatch = {
  skillId: string;
  score: number;
  matchedTriggers: string[];
  matchedFrom: Array<"current_request" | "session_goal">;
};

export type SkillSelectionStatus = "SELECTED" | "OMITTED" | "BLOCKED";

export type SkillSelectionManifest = {
  skillId: string;
  selected: boolean;
  selectedBy: "manual" | "trigger";
  triggerScore: number;
  preferredBonus: number;
  weightBonus: number;
  finalScore: number;
  matchedTriggers: string[];
  matchedFrom: Array<"current_request" | "session_goal">;
  originalChars: number;
  retainedChars: number;
  truncated: boolean;
  omittedReason?: string;
};

export type SkillSelectionExplainRow = {
  skillId: string;
  status: SkillSelectionStatus;
  selectedBy: "manual" | "trigger" | "none";
  triggerScore: number;
  preferredBonus: number;
  weightBonus: number;
  finalScore: number;
  matchedTriggers: string[];
  matchedFrom: Array<"current_request" | "session_goal">;
  reason: string;
  originalChars: number;
  retainedChars: number;
  truncated: boolean;
};

export type SkillPromptBlock = {
  title: string;
  content: string;
  manifest: SkillSelectionManifest[];
};

export type SkillBudget = {
  skillMaxItems: number;
  skillMaxChars: number;
  skillItemMaxChars: number;
};

type RankedSkill = {
  skill: SkillRecord;
  selectedBy: "manual" | "trigger";
  match: SkillTriggerMatch;
  preferredBonus: number;
  weightBonus: number;
  finalScore: number;
};

const preferredSkillBonus = 3;

export class SkillSelector {
  constructor(private readonly store: SkillStore) {}

  selectSkillPromptBlock(input: {
    agent: AgentManifest;
    sessionGoal: string;
    currentRequest: string;
    manualSkillIds?: string[];
    budget: SkillBudget;
  }): SkillPromptBlock | undefined {
    const selection = this.buildSkillSelection(input, false);
    if (!selection.renderedSkills.length && !selection.manifest.length) {
      return undefined;
    }
    return {
      title: "SELECTED SKILLS",
      content: `<available_skills>\n${selection.renderedSkills.join("\n")}\n</available_skills>`,
      manifest: selection.manifest
    };
  }

  explainSkillSelection(input: {
    agent: AgentManifest;
    sessionGoal: string;
    currentRequest: string;
    manualSkillIds?: string[];
    budget: SkillBudget;
  }): SkillSelectionExplainRow[] {
    return this.buildSkillSelection(input, true).explainRows;
  }

  private buildSkillSelection(input: {
    agent: AgentManifest;
    sessionGoal: string;
    currentRequest: string;
    manualSkillIds?: string[];
    budget: SkillBudget;
  }, includeAllRows: boolean): {
    renderedSkills: string[];
    manifest: SkillSelectionManifest[];
    explainRows: SkillSelectionExplainRow[];
  } {
    const skills = this.store.readSkillRecords();
    const blockedSkills = new Set(input.agent.blockedSkills);
    const preferredSkills = new Set(input.agent.preferredSkills);
    const manualSkillIds = [...new Set(input.manualSkillIds ?? [])].map((skillId) => this.store.resolveSkillId(skillId));
    const manualSet = new Set(manualSkillIds);
    for (const skillId of manualSet) {
      if (blockedSkills.has(skillId)) {
        throw new Error(`Skill is blocked for ${input.agent.id}: ${skillId}`);
      }
    }
    const explainRows = new Map<string, SkillSelectionExplainRow>();
    const ranked: RankedSkill[] = [];
    for (const skill of skills) {
      const match = calculateSkillTriggerMatch({
        skillId: skill.id,
        triggers: skill.triggers,
        sessionGoal: input.sessionGoal,
        currentRequest: input.currentRequest
      });
      const preferredBonus = preferredSkills.has(skill.id) ? preferredSkillBonus : 0;
      const weightBonus = clampSkillWeight(input.agent.skillWeights?.[skill.id] ?? 0);
      const finalScore = match.score + preferredBonus + weightBonus;
      if (blockedSkills.has(skill.id)) {
        explainRows.set(skill.id, selectionExplainRow(skill, "BLOCKED", "none", match, 0, 0, 0, "blockedByAgent"));
        continue;
      }
      const selectedBy = manualSet.has(skill.id) ? "manual" as const : "trigger" as const;
      if (selectedBy === "manual" || match.score > 0) {
        ranked.push({ skill, selectedBy, match, preferredBonus, weightBonus, finalScore });
        continue;
      }
      if (includeAllRows) {
        explainRows.set(skill.id, selectionExplainRow(skill, "OMITTED", "none", match, preferredBonus, weightBonus, finalScore, "noTriggerMatch"));
      }
    }
    ranked.sort(compareRankedSkills(input.agent));

    const renderedSkills: string[] = [];
    const manifest: SkillSelectionManifest[] = [];
    let retainedTotal = 0;
    for (const item of ranked) {
      const original = item.skill.content;
      let content = neutralizeXmlBoundaries(original);
      let truncated = false;
      if (content.length > input.budget.skillItemMaxChars) {
        content = truncateSkillContent(content, input.budget.skillItemMaxChars, item.skill.id);
        truncated = true;
      }
      const rendered = renderSkillPromptItem(item.skill, item, content);
      if (renderedSkills.length >= input.budget.skillMaxItems) {
        const row = selectionExplainRow(item.skill, "OMITTED", item.selectedBy, item.match, item.preferredBonus, item.weightBonus, item.finalScore, "skillMaxItems", original.length, 0, false);
        explainRows.set(item.skill.id, row);
        manifest.push(selectionManifest(item, original.length, 0, false, "skillMaxItems"));
        continue;
      }
      if (retainedTotal + rendered.length > input.budget.skillMaxChars) {
        const row = selectionExplainRow(item.skill, "OMITTED", item.selectedBy, item.match, item.preferredBonus, item.weightBonus, item.finalScore, "skillMaxChars", original.length, 0, false);
        explainRows.set(item.skill.id, row);
        manifest.push(selectionManifest(item, original.length, 0, false, "skillMaxChars"));
        continue;
      }
      renderedSkills.push(rendered);
      retainedTotal += rendered.length;
      explainRows.set(item.skill.id, selectionExplainRow(item.skill, "SELECTED", item.selectedBy, item.match, item.preferredBonus, item.weightBonus, item.finalScore, "selected", original.length, content.length, truncated));
      manifest.push(selectionManifest(item, original.length, content.length, truncated));
    }
    const rows = includeAllRows
      ? [...explainRows.values()].sort(compareExplainRows)
      : [...explainRows.values()].filter((row) => row.status !== "OMITTED" || row.reason !== "noTriggerMatch").sort(compareExplainRows);
    return { renderedSkills, manifest, explainRows: rows };
  }
}

export function calculateSkillTriggerMatch(input: {
  skillId: string;
  triggers: string[];
  sessionGoal: string;
  currentRequest: string;
}): SkillTriggerMatch {
  const current = normalizeTriggerText(input.currentRequest);
  const goal = normalizeTriggerText(input.sessionGoal);
  const matchedTriggers: string[] = [];
  const matchedFrom = new Set<"current_request" | "session_goal">();
  let score = 0;
  for (const trigger of normalizeTriggers(input.triggers)) {
    if (trigger.length <= 2) {
      continue;
    }
    const currentMatch = triggerMatches(trigger, current);
    const goalMatch = triggerMatches(trigger, goal);
    if (currentMatch || goalMatch) {
      matchedTriggers.push(trigger);
    }
    if (currentMatch) {
      score += 5;
      matchedFrom.add("current_request");
    }
    if (goalMatch) {
      score += 2;
      matchedFrom.add("session_goal");
    }
  }
  return {
    skillId: input.skillId,
    score,
    matchedTriggers,
    matchedFrom: [...matchedFrom]
  };
}

function renderSkillPromptItem(skill: SkillRecord, item: RankedSkill, content: string): string {
  const source = `skills/${skill.id}.md`;
  return `  <skill id="${escapeXmlAttribute(skill.id)}" trigger_score="${item.match.score}" final_score="${item.finalScore}" selected_by="${item.selectedBy}" source="${escapeXmlAttribute(source)}">
    <skill_markdown>
${indentXmlText(content, "      ")}
    </skill_markdown>
  </skill>`;
}

function selectionManifest(
  item: RankedSkill,
  originalChars: number,
  retainedChars: number,
  truncated: boolean,
  omittedReason?: string
): SkillSelectionManifest {
  return {
    skillId: item.skill.id,
    selected: !omittedReason,
    selectedBy: item.selectedBy,
    triggerScore: item.match.score,
    preferredBonus: item.preferredBonus,
    weightBonus: item.weightBonus,
    finalScore: item.finalScore,
    matchedTriggers: item.match.matchedTriggers,
    matchedFrom: item.match.matchedFrom,
    originalChars,
    retainedChars,
    truncated,
    omittedReason
  };
}

function selectionExplainRow(
  skill: SkillRecord,
  status: SkillSelectionStatus,
  selectedBy: "manual" | "trigger" | "none",
  match: SkillTriggerMatch,
  preferredBonus: number,
  weightBonus: number,
  finalScore: number,
  reason: string,
  originalChars = skill.content.length,
  retainedChars = 0,
  truncated = false
): SkillSelectionExplainRow {
  return {
    skillId: skill.id,
    status,
    selectedBy,
    triggerScore: match.score,
    preferredBonus,
    weightBonus,
    finalScore,
    matchedTriggers: match.matchedTriggers,
    matchedFrom: match.matchedFrom,
    reason,
    originalChars,
    retainedChars,
    truncated
  };
}

function compareRankedSkills(agent: AgentManifest): (left: RankedSkill, right: RankedSkill) => number {
  const preferred = new Set(agent.preferredSkills);
  return (left, right) => {
    if (left.selectedBy !== right.selectedBy) {
      return left.selectedBy === "manual" ? -1 : 1;
    }
    if (right.finalScore !== left.finalScore) {
      return right.finalScore - left.finalScore;
    }
    if (preferred.has(left.skill.id) !== preferred.has(right.skill.id)) {
      return preferred.has(left.skill.id) ? -1 : 1;
    }
    const created = left.skill.createdAt.localeCompare(right.skill.createdAt);
    if (created !== 0) {
      return created;
    }
    return left.skill.id.localeCompare(right.skill.id);
  };
}

function compareExplainRows(left: SkillSelectionExplainRow, right: SkillSelectionExplainRow): number {
  const statusRank: Record<SkillSelectionStatus, number> = {
    SELECTED: 0,
    OMITTED: 1,
    BLOCKED: 2
  };
  if (statusRank[left.status] !== statusRank[right.status]) {
    return statusRank[left.status] - statusRank[right.status];
  }
  if (right.finalScore !== left.finalScore) {
    return right.finalScore - left.finalScore;
  }
  return left.skillId.localeCompare(right.skillId);
}
