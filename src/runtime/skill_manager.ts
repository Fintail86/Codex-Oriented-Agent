import type { AgentManifest, SessionMetadata, SkillCandidate, SkillCandidateRecord } from "./types.js";
import {
  highRiskConfirmPhrase,
  SkillCandidateStore,
  type CreateSkillCandidateInput,
  type PromoteSkillOptions,
  type PromoteSkillResult,
  type SkillCandidateCleanupResult,
  type SkillCandidateView
} from "./skills/skill_candidates.js";
import {
  formatSkillCandidate,
  formatSkillCheckResult,
  formatSkillPromotionPreview,
  formatSkillSelectionExplanation
} from "./skills/skill_formatters.js";
import { SkillMirror, type SkillCheckResult } from "./skills/skill_mirror.js";
import {
  calculateSkillTriggerMatch,
  SkillSelector,
  type SkillBudget,
  type SkillPromptBlock,
  type SkillSelectionExplainRow,
  type SkillSelectionManifest,
  type SkillSelectionStatus,
  type SkillTriggerMatch
} from "./skills/skill_selector.js";
import { SkillStore, type SkillRecord } from "./skills/skill_store.js";

export {
  calculateSkillTriggerMatch,
  formatSkillCandidate,
  formatSkillCheckResult,
  formatSkillPromotionPreview,
  formatSkillSelectionExplanation,
  highRiskConfirmPhrase
};

export type {
  PromoteSkillOptions,
  PromoteSkillResult,
  SkillBudget,
  SkillCandidateView,
  CreateSkillCandidateInput,
  SkillCandidateCleanupResult,
  SkillCheckResult,
  SkillPromptBlock,
  SkillRecord,
  SkillSelectionExplainRow,
  SkillSelectionManifest,
  SkillSelectionStatus,
  SkillTriggerMatch
};

export class SkillManager {
  private readonly store: SkillStore;
  private readonly candidates: SkillCandidateStore;
  private readonly selector: SkillSelector;
  private readonly mirror: SkillMirror;

  constructor(private readonly workspaceRoot: string) {
    this.store = new SkillStore(workspaceRoot);
    this.mirror = new SkillMirror(this.store);
    this.candidates = new SkillCandidateStore(workspaceRoot, this.store, this.mirror);
    this.selector = new SkillSelector(this.store);
  }

  ensureSchema(): void {
    this.candidates.ensureSchema();
    this.mirror.ensureGlobalMirror();
  }

  ensureSkillFiles(): void {
    this.store.ensureSkillsDir();
    this.mirror.ensureGlobalMirror();
  }

  appendCandidates(candidates: SkillCandidate[] | undefined, session: SessionMetadata, runId?: string, sourceAgentId?: string): SkillCandidateRecord[] {
    return this.candidates.appendCandidates(candidates, session, runId, sourceAgentId);
  }

  appendManualCandidate(input: CreateSkillCandidateInput): SkillCandidateRecord {
    return this.candidates.appendManualCandidate(input);
  }

  listCandidates(includeAll = false): SkillCandidateView[] {
    return this.candidates.listCandidates(includeAll);
  }

  getCandidate(candidateId: string): SkillCandidateView {
    return this.candidates.getCandidate(candidateId);
  }

  exportCandidatesJsonl(): string {
    return this.candidates.exportCandidatesJsonl();
  }

  discardCandidate(candidateId: string, reason: string): SkillCandidateRecord {
    return this.candidates.discardCandidate(candidateId, reason);
  }

  cleanupDiscardedCandidates(options: { olderThanDays?: number; apply?: boolean } = {}): SkillCandidateCleanupResult {
    return this.candidates.cleanupDiscardedCandidates(options);
  }

  promoteCandidate(candidateId: string, options: PromoteSkillOptions = {}): PromoteSkillResult {
    return this.candidates.promoteCandidate(candidateId, options);
  }

  revertPromotedCandidate(candidateId: string, reason: string): SkillCandidateRecord {
    return this.candidates.revertPromotedCandidate(candidateId, reason);
  }

  listSkills(): SkillRecord[] {
    this.ensureSkillFiles();
    return this.store.listSkills();
  }

  getSkill(skillId: string): SkillRecord {
    return this.store.getSkill(skillId);
  }

  resolveSkillId(skillId: string): string {
    return this.store.resolveSkillId(skillId);
  }

  syncSkillsIndex(agentId?: string): string {
    return this.mirror.syncSkillsIndex(agentId);
  }

  checkSkills(agentId?: string, repair = false): SkillCheckResult {
    return this.mirror.checkSkills(agentId, repair);
  }

  preferSkill(skillId: string, agentId: string, weight?: number): AgentManifest {
    const manifest = this.store.preferSkill(skillId, agentId, weight);
    this.mirror.syncSkillsIndex(agentId);
    return manifest;
  }

  unpreferSkill(skillId: string, agentId: string): AgentManifest {
    const manifest = this.store.unpreferSkill(skillId, agentId);
    this.mirror.syncSkillsIndex(agentId);
    return manifest;
  }

  blockSkill(skillId: string, agentId: string): AgentManifest {
    const manifest = this.store.blockSkill(skillId, agentId);
    this.mirror.syncSkillsIndex(agentId);
    return manifest;
  }

  unblockSkill(skillId: string, agentId: string): AgentManifest {
    const manifest = this.store.unblockSkill(skillId, agentId);
    this.mirror.syncSkillsIndex(agentId);
    return manifest;
  }

  selectSkillPromptBlock(input: {
    agent: AgentManifest;
    sessionGoal: string;
    currentRequest: string;
    manualSkillIds?: string[];
    budget: SkillBudget;
  }): SkillPromptBlock | undefined {
    return this.selector.selectSkillPromptBlock(input);
  }

  explainSkillSelection(input: {
    agent: AgentManifest;
    sessionGoal: string;
    currentRequest: string;
    manualSkillIds?: string[];
    budget: SkillBudget;
  }): SkillSelectionExplainRow[] {
    return this.selector.explainSkillSelection(input);
  }
}
