export type CommandSafety =
  | "read_only"
  | "preview_mutation"
  | "mutation"
  | "dangerous";

export type CommandIntentResult =
  | { type: "matched"; commandId: string; confidence: "high" | "medium"; args: Record<string, unknown> }
  | { type: "needs_input"; commandId: string; missing: string[]; hint: string }
  | { type: "ambiguous"; candidates: string[]; hint: string }
  | { type: "no_match" };

export type CommandDefinition = {
  commandId: string;
  safety: CommandSafety;
  description: string;
  argsSchema: {
    required?: string[];
    optional?: string[];
  };
  examples: string[];
  triggers: {
    ko: string[];
    en: string[];
  };
};

export const commandDefinitions: CommandDefinition[] = [
  {
    commandId: "status.show",
    safety: "read_only",
    description: "Show COSIA workspace status and recommended next actions.",
    argsSchema: {},
    examples: ["#상태 보여줘", "#show status"],
    triggers: {
      ko: ["상태", "현황", "진단", "상태 보여줘", "상태 확인"],
      en: ["status", "show status", "check status", "workspace status", "health", "diagnose"]
    }
  },
  {
    commandId: "review.list",
    safety: "read_only",
    description: "Show pending memory and skill review items.",
    argsSchema: { optional: ["filter"] },
    examples: ["#리뷰 보여줘", "#show review"],
    triggers: {
      ko: ["리뷰", "후보", "리뷰 보여줘", "리뷰 목록", "검토"],
      en: ["review", "show review", "review inbox", "pending review", "review list"]
    }
  },
  {
    commandId: "review.next",
    safety: "read_only",
    description: "Show the next pending review item.",
    argsSchema: {},
    examples: ["#다음 리뷰 보여줘", "#show next review"],
    triggers: {
      ko: ["다음 리뷰", "다음 후보"],
      en: ["next review", "show next review", "next pending review"]
    }
  },
  {
    commandId: "review.conflicted_memory",
    safety: "read_only",
    description: "Show pending memory candidates that currently have conflicts.",
    argsSchema: {},
    examples: ["#컨플릭트 메모리 보여줘", "#show conflicting memories"],
    triggers: {
      ko: ["컨플릭트 메모리", "충돌 메모리", "충돌 후보"],
      en: ["conflicting memories", "conflict memory", "memory conflicts", "show conflicts"]
    }
  },
  {
    commandId: "review.discard",
    safety: "mutation",
    description: "Preview discarding one review item by index or id prefix.",
    argsSchema: { required: ["target", "reason"] },
    examples: ["#리뷰 3번 디스카드해 이유는 중복", "#discard review 3 because duplicate"],
    triggers: {
      ko: ["리뷰 디스카드", "후보 디스카드", "디스카드"],
      en: ["discard review", "discard candidate", "discard item", "discard"]
    }
  },
  {
    commandId: "review.discard_conflicts",
    safety: "mutation",
    description: "Preview discarding all pending memory candidates with conflicts.",
    argsSchema: { required: ["reason"] },
    examples: ["#컨플릭트 메모리 전부 디스카드해 이유는 중복", "#discard all conflicting memories because duplicate"],
    triggers: {
      ko: ["컨플릭트 메모리 디스카드", "충돌 메모리 디스카드", "중복 메모리 정리"],
      en: ["discard conflicting memories", "discard all conflicting memories", "discard duplicate memories", "duplicate conflicting memories", "cleanup conflicting memories"]
    }
  },
  {
    commandId: "review.promote_skill",
    safety: "mutation",
    description: "Preview promoting a skill candidate by index or id prefix.",
    argsSchema: { required: ["target"] },
    examples: ["#스킬 후보 2번 승격해", "#promote skill candidate 2"],
    triggers: {
      ko: ["스킬 후보 승격", "스킬 승격"],
      en: ["promote skill candidate", "promote skill"]
    }
  },
  {
    commandId: "memory.search",
    safety: "read_only",
    description: "Search active long-term memories.",
    argsSchema: { required: ["query"] },
    examples: ["#메모리 검색 required provider", "#memory search required provider"],
    triggers: {
      ko: ["메모리 검색", "기억 검색", "메모리 찾아줘"],
      en: ["memory search", "search memory", "search memories", "find memory"]
    }
  },
  {
    commandId: "session.list",
    safety: "read_only",
    description: "List sessions.",
    argsSchema: {},
    examples: ["#세션 목록 보여줘", "#show sessions"],
    triggers: {
      ko: ["세션 목록", "세션 보여줘"],
      en: ["sessions", "show sessions", "session list", "list sessions"]
    }
  },
  {
    commandId: "session.summary",
    safety: "read_only",
    description: "Show the current session summary.",
    argsSchema: {},
    examples: ["#세션 요약 보여줘", "#show session summary"],
    triggers: {
      ko: ["세션 요약", "요약 보여줘"],
      en: ["session summary", "show summary", "show session summary"]
    }
  },
  {
    commandId: "context.status",
    safety: "read_only",
    description: "Show context health for the current session.",
    argsSchema: {},
    examples: ["#컨텍스트 상태 보여줘", "#show context status"],
    triggers: {
      ko: ["컨텍스트 상태", "문맥 상태"],
      en: ["context status", "context health", "show context"]
    }
  },
  {
    commandId: "provider.check",
    safety: "read_only",
    description: "Check the active provider and list configured providers.",
    argsSchema: {},
    examples: ["#provider 확인해", "#check provider"],
    triggers: {
      ko: ["프로바이더", "provider 확인", "모델 확인"],
      en: ["provider", "check provider", "provider status", "model provider"]
    }
  },
  {
    commandId: "tool.git_status",
    safety: "read_only",
    description: "Run the policy-gated git status tool.",
    argsSchema: {},
    examples: ["#git 상태 보여줘", "#git status"],
    triggers: {
      ko: ["git 상태", "깃 상태"],
      en: ["git status", "show git status"]
    }
  },
  {
    commandId: "policy.check",
    safety: "read_only",
    description: "Check policy JSON and Markdown mirror health.",
    argsSchema: {},
    examples: ["#policy 검사해", "#check policy"],
    triggers: {
      ko: ["정책 검사", "policy 검사", "정책 확인"],
      en: ["policy", "check policy", "policy check"]
    }
  },
  {
    commandId: "skill.list",
    safety: "read_only",
    description: "List global skills and current agent skill selection state.",
    argsSchema: {},
    examples: ["#스킬 목록 보여줘", "#show skills"],
    triggers: {
      ko: ["스킬 목록", "스킬 보여줘"],
      en: ["skills", "show skills", "skill list", "list skills"]
    }
  }
];

export function parseHashCommand(input: string): CommandIntentResult {
  const body = input.trim().replace(/^#/, "").trim();
  const normalized = normalizeCommandText(body);
  if (!normalized) {
    return { type: "no_match" };
  }

  if (/^(적용|진행|실행|yes|y|응|ㅇㅇ)$/.test(normalized)) {
    return matched("pending.apply");
  }
  if (/^(취소|cancel|그만)$/.test(normalized)) {
    return matched("pending.cancel");
  }
  if (/^(대기중인\s*작업\s*보여줘|대기\s*작업\s*보여줘|pending)$/.test(normalized)) {
    return matched("pending.show");
  }

  const reviewDiscard = body.match(/^리뷰\s+(.+?)\s*(?:번\s*)?디스카드(?:해|해줘)?(?:\s*(?:이유|사유|reason)는?\s+(.+))?$/i);
  if (reviewDiscard) {
    const target = reviewDiscard[1]?.trim();
    const reason = reviewDiscard[2]?.trim();
    if (!reason) {
      return needsInput("review.discard", ["reason"], "Try: #리뷰 3번 디스카드해 이유는 중복");
    }
    return matched("review.discard", { target, reason });
  }

  const discardConflicts = body.match(/^(?:컨플릭트|충돌)\s*메모리\s*(?:전부|모두|전체)?\s*디스카드(?:해|해줘|진행)?(?:\s*(?:이유|사유|reason)는?\s+(.+))?$/i);
  if (discardConflicts) {
    const reason = discardConflicts[1]?.trim();
    if (!reason) {
      return needsInput("review.discard_conflicts", ["reason"], "Try: #컨플릭트 메모리 전부 디스카드해 이유는 중복");
    }
    return matched("review.discard_conflicts", { reason });
  }

  const skillPromote = body.match(/^스킬\s*후보\s+(.+?)\s*(?:번\s*)?승격(?:해|해줘)?$/i);
  if (skillPromote) {
    return matched("review.promote_skill", { target: skillPromote[1].trim() });
  }

  const memorySearch = body.match(/^메모리\s*(?:검색|찾아줘|찾기)\s+(.+)$/i);
  if (memorySearch) {
    return matched("memory.search", { query: memorySearch[1].trim() });
  }
  const englishMemorySearch = body.match(/^memory\s+search\s+(.+)$/i);
  if (englishMemorySearch) {
    return matched("memory.search", { query: englishMemorySearch[1].trim() });
  }

  const englishDiscardConflicts = body.match(/^discard\s+(?:all\s+)?(?:conflicting|conflict|duplicate)\s+memor(?:y|ies)(?:\s+(?:because|reason(?:\s+is)?|for)\s+(.+))?$/i);
  if (englishDiscardConflicts) {
    const reason = englishDiscardConflicts[1]?.trim();
    if (!reason) {
      return needsInput("review.discard_conflicts", ["reason"], "Try: #discard all conflicting memories because duplicate");
    }
    return matched("review.discard_conflicts", { reason });
  }

  if (/^(리뷰|리뷰\s*(보여줘|목록|확인)|전체\s*리뷰\s*(보여줘|목록|확인))$/.test(normalized)) {
    return matched("review.list", { filter: "all" });
  }
  if (/^(review|show review|review inbox|show review inbox)$/.test(normalized)) {
    return matched("review.list", { filter: "all" });
  }
  if (/^메모리\s*리뷰\s*(보여줘|목록|확인)?$/.test(normalized)) {
    return matched("review.list", { filter: "memory" });
  }
  if (/^스킬\s*리뷰\s*(보여줘|목록|확인)?$/.test(normalized)) {
    return matched("review.list", { filter: "skill" });
  }
  if (/^다음\s*리뷰\s*(보여줘|확인)?$/.test(normalized)) {
    return matched("review.next");
  }
  if (/^(?:컨플릭트|충돌)\s*메모리\s*(보여줘|목록|확인)?$/.test(normalized)) {
    return matched("review.conflicted_memory");
  }

  if (/^(상태|상태\s*(보여줘|확인|조회)|현재\s*상태.*(분석|보여줘|확인)|진단|진단해줘)$/.test(normalized)) {
    return matched("status.show");
  }
  if (/^(status|show status|check status|workspace status)$/.test(normalized)) {
    return matched("status.show");
  }
  if (/^세션\s*목록\s*(보여줘|확인|조회)?$/.test(normalized)) {
    return matched("session.list");
  }
  if (/^세션\s*요약\s*(보여줘|확인|조회)?$/.test(normalized)) {
    return matched("session.summary");
  }
  if (/^컨텍스트\s*상태\s*(보여줘|확인|조회)?$/.test(normalized)) {
    return matched("context.status");
  }
  if (/^(provider|프로바이더)\s*(확인|목록|상태)?$/.test(normalized)) {
    return matched("provider.check");
  }
  if (/^check\s+provider$/.test(normalized)) {
    return matched("provider.check");
  }
  if (/^git\s*상태\s*(보여줘|확인|조회)?$/.test(normalized)) {
    return matched("tool.git_status");
  }
  if (/^git\s+status$/.test(normalized)) {
    return matched("tool.git_status");
  }
  if (/^policy\s*(검사|확인|체크)?$/.test(normalized) || /^정책\s*(검사|확인|체크)?$/.test(normalized)) {
    return matched("policy.check");
  }
  if (/^스킬\s*목록\s*(보여줘|확인|조회)?$/.test(normalized)) {
    return matched("skill.list");
  }

  if (/^메모리\s*정리/.test(normalized)) {
    return {
      type: "ambiguous",
      candidates: ["review.list", "review.discard_conflicts", "memory.search"],
      hint: "Try #리뷰 보여줘 or #컨플릭트 메모리 전부 디스카드해 이유는 <reason>."
    };
  }

  return { type: "no_match" };
}

export function retrieveCommandCandidates(input: string, limit = 8): CommandDefinition[] {
  const body = input.trim().replace(/^#/, "").trim();
  const normalized = normalizeCommandText(body);
  if (!normalized) {
    return [];
  }
  const scored = commandDefinitions
    .map((definition) => ({
      definition,
      score: scoreDefinition(normalized, definition)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.definition.commandId.localeCompare(b.definition.commandId));
  return scored.slice(0, limit).map((item) => item.definition);
}

export function commandDefinitionById(commandId: string): CommandDefinition | undefined {
  return commandDefinitions.find((definition) => definition.commandId === commandId);
}

export function validateCommandArgs(commandId: string, args: Record<string, unknown>): CommandIntentResult | undefined {
  const definition = commandDefinitionById(commandId);
  if (!definition) {
    return {
      type: "ambiguous",
      candidates: [],
      hint: `Unknown runtime command returned by interpreter: ${commandId}`
    };
  }
  const missing = (definition.argsSchema.required ?? [])
    .filter((key) => typeof args[key] !== "string" || !String(args[key]).trim());
  if (missing.length > 0) {
    return needsInput(commandId, missing, usageHint(definition));
  }
  if (commandId === "review.list" && args.filter !== undefined && !["all", "memory", "skill"].includes(String(args.filter))) {
    return needsInput(commandId, ["filter"], "Filter must be one of: all, memory, skill.");
  }
  return undefined;
}

export function usageHint(definition: CommandDefinition): string {
  return `Try: ${definition.examples[0]}`;
}

function matched(commandId: string, args: Record<string, unknown> = {}): CommandIntentResult {
  return { type: "matched", commandId, confidence: "high", args };
}

function needsInput(commandId: string, missing: string[], hint: string): CommandIntentResult {
  return { type: "needs_input", commandId, missing, hint };
}

function normalizeCommandText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function scoreDefinition(normalized: string, definition: CommandDefinition): number {
  let score = 0;
  for (const trigger of [...definition.triggers.ko, ...definition.triggers.en]) {
    const normalizedTrigger = normalizeCommandText(trigger);
    if (!normalizedTrigger) {
      continue;
    }
    if (normalized === normalizedTrigger) {
      score += 10;
      continue;
    }
    if (normalized.includes(normalizedTrigger)) {
      score += normalizedTrigger.includes(" ") ? 5 : 2;
      continue;
    }
    if (isAsciiWord(normalizedTrigger) && new RegExp(`\\b${escapeRegExp(normalizedTrigger)}\\b`, "i").test(normalized)) {
      score += 2;
    }
  }
  return score;
}

function isAsciiWord(value: string): boolean {
  return /^[a-z0-9_-]+$/i.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
