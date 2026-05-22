import {
  formatMemoryConflicts,
  MemoryManager,
  type MemoryConflict,
  type PromoteCandidateOptions
} from "./memory_manager.js";
import { classifyMemoryCandidate, detectSecrets, redactedCandidatePreview, type RiskClassification } from "./risk_classifier.js";
import {
  formatSkillCandidate,
  formatSkillPromotionPreview,
  SkillManager,
  type PromoteSkillOptions,
  type PromoteSkillResult
} from "./skill_manager.js";
import type { MemoryCandidateRecord, RiskLevel, SkillCandidateRecord } from "./types.js";

export type ReviewItemType = "memory" | "skill";
export type ReviewFilter = "all" | ReviewItemType;

export type ReviewInboxItem = {
  index: number;
  type: ReviewItemType;
  id: string;
  idPrefix: string;
  status: string;
  risk: RiskLevel;
  summary: string;
  conflictCount: number;
  recommendedAction: string;
  createdAt: string;
  memory?: {
    candidate: MemoryCandidateRecord;
    classification: RiskClassification;
    conflicts: MemoryConflict[];
  };
  skill?: {
    candidate: SkillCandidateRecord;
  };
};

export type ReviewInbox = {
  items: ReviewInboxItem[];
  totalPending: number;
  memoryPending: number;
  skillPending: number;
};

export type ReviewPromoteOptions = PromoteCandidateOptions & PromoteSkillOptions;

export type ReviewBatchDiscardResult = {
  applied: boolean;
  reason: string;
  matched: number;
  discarded: number;
  items: ReviewInboxItem[];
  inbox: ReviewInbox;
};

const idPrefixLength = 8;

export class ReviewInboxService {
  private readonly memory: MemoryManager;
  private readonly skills: SkillManager;

  constructor(private readonly workspaceRoot: string) {
    this.memory = new MemoryManager(workspaceRoot);
    this.skills = new SkillManager(workspaceRoot);
  }

  async list(filter: ReviewFilter = "all"): Promise<ReviewInbox> {
    const [memoryCandidates, skillCandidates] = await Promise.all([
      this.memory.listCandidates(false),
      Promise.resolve(this.skills.listCandidates(false))
    ]);
    const memoryItems: ReviewInboxItem[] = [];
    for (const view of memoryCandidates) {
      if (!view.record || view.record.status !== "pending") {
        continue;
      }
      const { candidate, conflicts } = await this.memory.findCandidateConflicts(view.record.id);
      const classification = classifyMemoryCandidate(candidate, conflicts.length > 0);
      const idPrefix = prefix(candidate.id);
      memoryItems.push({
        index: 0,
        type: "memory",
        id: candidate.id,
        idPrefix,
        status: candidate.status,
        risk: classification.riskLevel,
        summary: redactedCandidatePreview(candidate, classification),
        conflictCount: conflicts.length,
        recommendedAction: conflicts.length ? `/review conflicts ${idPrefix}` : `/review promote ${idPrefix}`,
        createdAt: candidate.createdAt,
        memory: { candidate, classification, conflicts }
      });
    }

    const skillItems = skillCandidates
      .filter((view) => view.record.status === "pending")
      .map((view): ReviewInboxItem => {
        const candidate = view.record;
        const idPrefix = prefix(candidate.id);
        const secret = detectSecrets(candidate.content);
        return {
          index: 0,
          type: "skill",
          id: candidate.id,
          idPrefix,
          status: candidate.status,
          risk: secret.matched ? "high" : candidate.riskLevel,
          summary: secret.matched ? secret.redactedPreview : preview(`${candidate.skillId}: ${candidate.reason}`),
          conflictCount: 0,
          recommendedAction: `/review promote ${idPrefix}`,
          createdAt: candidate.createdAt,
          skill: { candidate }
        };
      });

    const allItems = [...memoryItems, ...skillItems]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.type.localeCompare(right.type) || left.id.localeCompare(right.id))
      .map((item, index) => ({ ...item, index: index + 1 }));
    return {
      items: filter === "all" ? allItems : allItems.filter((item) => item.type === filter),
      totalPending: allItems.length,
      memoryPending: allItems.filter((item) => item.type === "memory").length,
      skillPending: allItems.filter((item) => item.type === "skill").length
    };
  }

  async resolve(ref: string): Promise<ReviewInboxItem> {
    const inbox = await this.list("all");
    const normalized = ref.trim();
    if (!normalized) {
      throw new Error("Review item id or index is required.");
    }
    const idMatches = inbox.items.filter((item) => item.id === normalized || item.id.startsWith(normalized));
    if (idMatches.length && (!/^\d+$/.test(normalized) || normalized.length >= idPrefixLength)) {
      if (idMatches.length > 1) {
        throw new Error(`Review item prefix is ambiguous: ${normalized}`);
      }
      return idMatches[0];
    }
    if (/^\d+$/.test(normalized)) {
      const index = Number.parseInt(normalized, 10);
      const item = inbox.items.find((candidate) => candidate.index === index);
      if (!item) {
        throw new Error(`Review item index not found: ${normalized}`);
      }
      return item;
    }
    if (!idMatches.length) {
      throw new Error(`Review item not found: ${normalized}`);
    }
    if (idMatches.length > 1) {
      throw new Error(`Review item prefix is ambiguous: ${normalized}`);
    }
    return idMatches[0];
  }

  async formatItemDetail(ref: string): Promise<string> {
    const item = await this.resolve(ref);
    if (item.type === "memory" && item.memory) {
      return [
        `Review item ${item.index}: memory ${item.idPrefix}`,
        `Risk: ${item.risk}`,
        `Conflicts: ${item.conflictCount}`,
        "",
        JSON.stringify(item.memory.candidate, null, 2)
      ].join("\n");
    }
    if (item.type === "skill" && item.skill) {
      return [
        `Review item ${item.index}: skill ${item.idPrefix}`,
        "",
        formatSkillCandidate(item.skill.candidate)
      ].join("\n");
    }
    throw new Error(`Review item is invalid: ${ref}`);
  }

  async formatConflicts(ref: string): Promise<string> {
    const item = await this.resolve(ref);
    if (item.type !== "memory" || !item.memory) {
      return "Skill candidates do not have memory conflicts.";
    }
    const base = formatMemoryConflicts(item.memory.candidate, item.memory.conflicts);
    if (!item.memory.conflicts.length) {
      return base;
    }
    return [
      base,
      "",
      "Review shortcut:",
      `- replace target 1: /review promote ${item.idPrefix} --replace 1`,
      `- merge target 1: /review promote ${item.idPrefix} --merge 1 --content "<merged content>"`,
      "Conflict numbers are temporary. Use full memory ids for exact CLI commands."
    ].join("\n");
  }

  async promote(ref: string, options: ReviewPromoteOptions): Promise<{ output: string; inbox: ReviewInbox }> {
    const item = await this.resolve(ref);
    let output: string;
    if (item.type === "memory") {
      const replaceMemoryId = resolveConflictTarget(item, options.replaceMemoryId);
      const mergeMemoryId = resolveConflictTarget(item, options.mergeMemoryId);
      const memory = await this.memory.promoteCandidate(item.id, {
        force: options.force,
        replaceMemoryId,
        mergeMemoryId,
        mergeContent: options.mergeContent
      });
      output = `Promoted memory candidate ${item.idPrefix} -> ${memory.id}`;
    } else {
      const result: PromoteSkillResult = this.skills.promoteCandidate(item.id, {
        yes: options.yes,
        preferFor: options.preferFor,
        confirmHighRisk: options.confirmHighRisk
      });
      output = formatSkillPromotionPreview(result);
    }
    return { output, inbox: await this.list("all") };
  }

  async discard(ref: string, reason: string): Promise<{ output: string; inbox: ReviewInbox }> {
    const item = await this.resolve(ref);
    if (!reason.trim()) {
      throw new Error("Usage: /review discard <index|id> --reason \"<reason>\"");
    }
    if (item.type === "memory") {
      const record = await this.memory.discardCandidate(item.id, reason);
      return { output: `Discarded memory candidate ${prefix(record.id)}.`, inbox: await this.list("all") };
    }
    const record = this.skills.discardCandidate(item.id, reason);
    return { output: `Discarded skill candidate ${prefix(record.id)}.`, inbox: await this.list("all") };
  }

  async discardConflictingMemoryCandidates(reason: string, options: { yes?: boolean } = {}): Promise<ReviewBatchDiscardResult> {
    if (!reason.trim()) {
      throw new Error("Usage: /review discard-conflicts --reason \"<reason>\" [--yes]");
    }
    const before = await this.list("all");
    const targets = before.items.filter((item) => item.type === "memory" && item.conflictCount > 0);
    let discarded = 0;
    if (options.yes) {
      for (const item of targets) {
        await this.memory.discardCandidate(item.id, reason);
        discarded += 1;
      }
    }
    return {
      applied: options.yes === true,
      reason,
      matched: targets.length,
      discarded,
      items: targets,
      inbox: await this.list("all")
    };
  }
}

export function formatReviewInbox(inbox: ReviewInbox, title = "Review Inbox"): string {
  const lines = [
    title,
    `Pending: ${inbox.totalPending} (${inbox.memoryPending} memory, ${inbox.skillPending} skill)`
  ];
  if (inbox.items.length !== inbox.totalPending) {
    lines.push(`Showing: ${inbox.items.length}`);
  }
  if (!inbox.items.length) {
    lines.push("No pending review items.");
    return lines.join("\n");
  }
  lines.push("");
  lines.push(`${pad("#", 4)} ${pad("Type", 6)} ${pad("ID", 10)} ${pad("Risk", 6)} ${pad("Conf", 5)} Summary`);
  for (const item of inbox.items) {
    lines.push(`${pad(String(item.index), 4)} ${pad(item.type, 6)} ${pad(item.idPrefix, 10)} ${pad(item.risk, 6)} ${pad(String(item.conflictCount), 5)} ${item.summary}`);
  }
  lines.push("");
  lines.push("Tip: indexes are temporary. Prefer id prefixes, e.g. `/review show abc12345`.");
  return lines.join("\n");
}

export function formatReviewNext(item: ReviewInboxItem | undefined): string {
  if (!item) {
    return "No pending review items.";
  }
  return [
    `Next review item: ${item.index} ${item.type} ${item.idPrefix}`,
    `Risk: ${item.risk}`,
    `Conflicts: ${item.conflictCount}`,
    `Summary: ${item.summary}`,
    "",
    `Show: /review show ${item.idPrefix}`,
    item.type === "memory" && item.conflictCount ? `Conflicts: /review conflicts ${item.idPrefix}` : undefined,
    `Promote: /review promote ${item.idPrefix}${item.type === "skill" ? " --yes" : ""}`,
    `Discard: /review discard ${item.idPrefix} --reason "<reason>"`,
    "Tip: indexes are temporary. Prefer id prefixes."
  ].filter(Boolean).join("\n");
}

export function formatReviewUpdate(inbox: ReviewInbox): string {
  const lines = [
    `Review updated. Remaining pending: ${inbox.totalPending} (${inbox.memoryPending} memory, ${inbox.skillPending} skill)`
  ];
  if (inbox.items.length) {
    lines.push("Next items:");
    for (const item of inbox.items.slice(0, 3)) {
      lines.push(`- ${item.idPrefix} ${item.type} ${item.risk} conflicts:${item.conflictCount} ${item.summary}`);
    }
  }
  lines.push("Tip: indexes are temporary. Prefer id prefixes.");
  return lines.join("\n");
}

export function formatReviewBatchDiscard(result: ReviewBatchDiscardResult): string {
  const lines = [
    result.applied ? "Discarded conflicting memory candidates." : "Conflict discard preview. Re-run with --yes to apply.",
    `Applied: ${result.applied}`,
    `Matched: ${result.matched}`,
    `Discarded: ${result.discarded}`,
    `Reason: ${result.reason}`
  ];
  if (result.items.length) {
    lines.push("Targets:");
    for (const item of result.items.slice(0, 10)) {
      lines.push(`- ${item.idPrefix} ${item.risk} conflicts:${item.conflictCount} ${item.summary}`);
    }
    if (result.items.length > 10) {
      lines.push(`- ... ${result.items.length - 10} more`);
    }
  }
  return lines.join("\n");
}

function prefix(id: string): string {
  return id.slice(0, idPrefixLength);
}

function resolveConflictTarget(item: ReviewInboxItem, value: string | undefined): string | undefined {
  if (!value || item.type !== "memory" || !item.memory) {
    return value;
  }
  if (!/^\d+$/.test(value)) {
    return value;
  }
  const conflictIndex = Number.parseInt(value, 10) - 1;
  const conflict = item.memory.conflicts[conflictIndex];
  if (!conflict) {
    throw new Error(`Conflict target index not found: ${value}`);
  }
  return conflict.memory.id;
}

function preview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

function pad(value: string, length: number): string {
  return value.length >= length ? value : `${value}${" ".repeat(length - value.length)}`;
}
