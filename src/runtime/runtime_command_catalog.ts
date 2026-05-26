import { isToolId } from "./tool_catalog.js";

export type RuntimeCommandSafety =
  | "read_only"
  | "preview_mutation"
  | "mutation"
  | "system_boundary"
  | "dangerous";

export type RuntimeCommandSurface =
  | "cli"
  | "repl"
  | "telegram"
  | "gateway";

export type RuntimeCommandExecutionMode =
  | "execute_read_only"
  | "preview_only"
  | "blocked";

export type CliArgvToken =
  | { kind: "literal"; value: string }
  | { kind: "positional"; name: string; required: boolean }
  | { kind: "option"; flag: string; name: string; required: boolean }
  | { kind: "booleanFlag"; flag: string; name: string };

export type RuntimeCommandResult =
  | { type: "matched"; commandId: string; confidence: "high" | "medium"; args: Record<string, unknown> }
  | { type: "needs_input"; commandId: string; missing: string[]; hint: string }
  | { type: "ambiguous"; candidates: string[]; hint: string }
  | { type: "no_match" };

export type RuntimeCommandDefinition = {
  commandId: string;
  commandPath: string[];
  cliDisplay: string;
  argvPlan: CliArgvToken[];
  safety: RuntimeCommandSafety;
  description: string;
  argsSchema: {
    required?: string[];
    optional?: string[];
  };
  argEnums?: Record<string, string[]>;
  examples: string[];
  triggers: {
    ko: string[];
    en: string[];
  };
  surfaces?: RuntimeCommandSurface[];
  tags?: string[];
  modelHint?: string;
  modelToolHint?: {
    toolId: string;
    args?: Record<string, unknown>;
    when?: string;
  };
  requiresUserCommand?: boolean;
  requiresApproval?: boolean;
  modelCallable?: boolean;
  modelExecutionMode?: RuntimeCommandExecutionMode;
};

export type CliCommandDefinition = RuntimeCommandDefinition;

export type RuntimeCommandCandidateMatch = {
  definition: RuntimeCommandDefinition;
  score: number;
  confidence: "high" | "medium" | "low";
  matchReason: string;
};

const readOnlyModelSurface = {
  surfaces: ["cli", "repl", "telegram", "gateway"] as RuntimeCommandSurface[],
  modelCallable: true,
  modelExecutionMode: "execute_read_only" as const
};

const userCommandOnly = {
  surfaces: ["cli", "repl", "telegram", "gateway"] as RuntimeCommandSurface[],
  requiresUserCommand: true,
  modelCallable: false,
  modelExecutionMode: "blocked" as const
};

type CommandInput = Omit<RuntimeCommandDefinition, "commandPath" | "argsSchema" | "examples" | "triggers" | "surfaces" | "modelCallable" | "modelExecutionMode"> & {
  commandPath?: string[];
  argsSchema?: RuntimeCommandDefinition["argsSchema"];
  argEnums?: RuntimeCommandDefinition["argEnums"];
  examples?: string[];
  triggers?: RuntimeCommandDefinition["triggers"];
  surfaces?: RuntimeCommandSurface[];
  modelCallable?: boolean;
  modelExecutionMode?: RuntimeCommandExecutionMode;
};

function command(input: CommandInput): RuntimeCommandDefinition {
  const plan = normalizeArgvPlan(input.argvPlan);
  return {
    argsSchema: {},
    examples: [input.cliDisplay],
    triggers: { ko: [], en: [] },
    surfaces: ["cli"],
    modelCallable: false,
    modelExecutionMode: "blocked",
    ...input,
    commandPath: input.commandPath ?? deriveCommandPath(plan),
    argvPlan: plan
  };
}

type CliArgvTokenDraft = string | CliArgvToken;

function argvPlan(tokens: readonly CliArgvTokenDraft[]): CliArgvToken[] {
  const plan: CliArgvToken[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (typeof token !== "string") {
      plan.push(token);
      continue;
    }
    const next = tokens[index + 1];
    const slot = parseSlotToken(token);
    if (slot) {
      plan.push({ kind: "positional", name: slot.name, required: !slot.optional });
      continue;
    }
    if (token.startsWith("--") && typeof next === "string") {
      const optionSlot = parseSlotToken(next);
      if (optionSlot) {
        if (optionSlot.optional && booleanOptionArgNames.has(optionSlot.name)) {
          plan.push({ kind: "booleanFlag", flag: token, name: optionSlot.name });
        } else {
          plan.push({ kind: "option", flag: token, name: optionSlot.name, required: !optionSlot.optional });
        }
        index += 1;
        continue;
      }
    }
    plan.push({ kind: "literal", value: token });
  }
  return plan;
}

function normalizeArgvPlan(plan: readonly CliArgvTokenDraft[]): CliArgvToken[] {
  if (plan.every((token) => typeof token !== "string")) {
    return [...plan] as CliArgvToken[];
  }
  return argvPlan(plan);
}

function parseSlotToken(token: string): { name: string; optional: boolean } | undefined {
  const match = token.match(/^\$([A-Za-z0-9_]+)(\?)?$/);
  if (!match) {
    return undefined;
  }
  return { name: match[1], optional: Boolean(match[2]) };
}

function deriveCommandPath(plan: readonly CliArgvToken[]): string[] {
  const path: string[] = [];
  for (const token of plan) {
    if (token.kind !== "literal" || token.value.startsWith("-")) {
      break;
    }
    path.push(token.value);
  }
  return path;
}

const booleanOptionArgNames = new Set(["showScore"]);

function coverageCommand(
  commandId: string,
  commandPath: string[],
  safety: RuntimeCommandSafety,
  description: string,
  tags: string[],
  argvTokens: readonly CliArgvTokenDraft[] = commandPath,
  argsSchema: RuntimeCommandDefinition["argsSchema"] = {}
): CommandInput {
  return {
    commandId,
    commandPath,
    cliDisplay: `cosia ${commandPath.join(" ")}`,
    argvPlan: argvPlan(argvTokens),
    safety,
    description,
    tags,
    argsSchema,
    requiresApproval: safety !== "read_only" ? true : undefined
  };
}

const runtimeCommandInputs: CommandInput[] = [
  {
    commandId: "gateway.status",
    cliDisplay: "cosia gateway status",
    argvPlan: argvPlan(["gateway", "status"]),
    safety: "read_only",
    description: "Show COSIA gateway process and connector status.",
    ...readOnlyModelSurface,
    tags: ["gateway", "게이트웨이", "status", "상태", "health"],
    modelHint: "Use when the user asks whether COSIA Gateway is running or wants connector/process status.",
    argsSchema: {},
    examples: ["/status", "cosia gateway status"],
    triggers: {
      ko: ["게이트웨이 상태", "게이트웨이 살아", "게이트웨이 켜져", "게이트웨이 실행 중", "게이트웨이 동작 중"],
      en: ["gateway status", "show gateway status", "check gateway status", "gateway running", "gateway alive"]
    }
  },
  {
    commandId: "status.show",
    cliDisplay: "cosia status",
    argvPlan: argvPlan(["status"]),
    safety: "read_only",
    description: "Show COSIA workspace status and recommended next actions.",
    ...readOnlyModelSurface,
    tags: ["workspace", "status", "상태", "health", "진단"],
    modelHint: "Use for general COSIA workspace health/status questions.",
    argsSchema: {},
    examples: ["/status", "cosia status"],
    triggers: {
      ko: ["상태", "현황", "진단", "상태 보여줘", "상태 확인"],
      en: ["status", "show status", "check status", "workspace status", "health", "diagnose"]
    }
  },
  {
    commandId: "review.list",
    cliDisplay: "cosia review [--memory|--skill]",
    argvPlan: argvPlan(["review"]),
    safety: "read_only",
    description: "Show pending memory and skill review items.",
    ...readOnlyModelSurface,
    tags: ["review", "리뷰", "memory", "메모리", "skill", "스킬", "pending", "승격", "후보"],
    modelHint: "Use when the user asks about memory promotion/review candidates or pending review items.",
    modelToolHint: {
      toolId: "review_inbox_read",
      args: { filter: "all" },
      when: "If review_inbox_read is active, call it before explaining that review state is unavailable."
    },
    argsSchema: {},
    examples: ["/review", "cosia review"],
    triggers: {
      ko: ["리뷰", "후보", "리뷰 보여줘", "리뷰 목록", "검토"],
      en: ["review", "show review", "review inbox", "pending review", "review list"]
    }
  },
  command({
    commandId: "review.memory",
    cliDisplay: "cosia review --memory",
    argvPlan: argvPlan(["review", "--memory"]),
    safety: "read_only",
    description: "Show pending memory review items.",
    ...readOnlyModelSurface,
    tags: ["review", "리뷰", "memory", "메모리", "pending", "승격", "후보"],
    modelHint: "Use for memory-specific review or promotion-candidate questions.",
    modelToolHint: {
      toolId: "review_inbox_read",
      args: { filter: "memory" },
      when: "If review_inbox_read is active, call it before falling back to CLI command execution."
    }
  }),
  command({
    commandId: "review.skill",
    cliDisplay: "cosia review --skill",
    argvPlan: argvPlan(["review", "--skill"]),
    safety: "read_only",
    description: "Show pending skill review items.",
    ...readOnlyModelSurface,
    tags: ["review", "리뷰", "skill", "스킬", "pending", "후보"],
    modelToolHint: {
      toolId: "review_inbox_read",
      args: { filter: "skill" },
      when: "If review_inbox_read is active, call it before falling back to CLI command execution."
    }
  }),
  {
    commandId: "review.next",
    cliDisplay: "cosia review",
    argvPlan: argvPlan(["review"]),
    safety: "read_only",
    description: "Show the next pending review item.",
    ...userCommandOnly,
    tags: ["review", "pending", "next"],
    modelHint: "Use when the user asks for the next review item.",
    argsSchema: {},
    examples: ["/review next", "cosia review next"],
    triggers: {
      ko: ["다음 리뷰", "다음 후보"],
      en: ["next review", "show next review", "next pending review"]
    }
  },
  {
    commandId: "review.conflicted_memory",
    cliDisplay: "cosia memory candidate conflicts <candidate-id>",
    argvPlan: argvPlan(["memory", "candidate", "conflicts", "$candidateId"]),
    safety: "read_only",
    description: "Show memory conflicts for one pending candidate.",
    ...readOnlyModelSurface,
    tags: ["review", "memory", "conflict"],
    modelHint: "Use when the user asks about conflicting memory candidates.",
    argsSchema: { required: ["candidateId"] },
    examples: ["cosia memory candidate conflicts <candidate-id>"],
    triggers: {
      ko: ["컨플릭트 메모리", "충돌 메모리", "충돌 후보"],
      en: ["conflicting memories", "conflict memory", "memory conflicts", "show conflicts"]
    }
  },
  {
    commandId: "review.stats",
    cliDisplay: "cosia review stats",
    argvPlan: argvPlan(["review", "stats"]),
    safety: "read_only",
    description: "Show review queue statistics and cleanup recommendations.",
    ...readOnlyModelSurface,
    tags: ["review", "stats", "cleanup"],
    modelHint: "Use when the user asks for review queue statistics.",
    argsSchema: {},
    examples: ["/review stats", "cosia review stats"],
    triggers: {
      ko: ["리뷰 통계", "후보 통계", "리뷰 상태"],
      en: ["review stats", "review statistics", "review queue stats"]
    }
  },
  {
    commandId: "memory.candidate.promote",
    cliDisplay: "cosia memory candidate promote <candidate-id>",
    argvPlan: argvPlan(["memory", "candidate", "promote", "$candidateId"]),
    safety: "mutation",
    description: "Promote one pending memory candidate into long-term memory.",
    ...userCommandOnly,
    requiresApproval: true,
    tags: ["review", "memory", "메모리", "candidate", "후보", "promote", "승격", "승인", "approve", "mutation"],
    argsSchema: { required: ["candidateId"] },
    examples: ["cosia memory candidate promote <candidate-id>"],
    triggers: {
      ko: ["메모리 후보 승격", "메모리 승격", "메모리 승인", "후보 승인"],
      en: ["promote memory candidate", "approve memory candidate"]
    }
  },
  {
    commandId: "review.discard",
    cliDisplay: "cosia memory candidate discard <candidate-id> --reason <reason>",
    argvPlan: argvPlan(["memory", "candidate", "discard", "$target", "--reason", "$reason"]),
    safety: "mutation",
    description: "Preview discarding one review item by index or id prefix.",
    ...userCommandOnly,
    requiresApproval: true,
    tags: ["review", "discard", "mutation"],
    argsSchema: { required: ["target", "reason"] },
    examples: ["/review discard <id-prefix> --reason \"duplicate\""],
    triggers: {
      ko: ["리뷰 디스카드", "후보 디스카드", "디스카드"],
      en: ["discard review", "discard candidate", "discard item", "discard"]
    }
  },
  {
    commandId: "review.discard_conflicts",
    cliDisplay: "cosia review cleanup [--yes]",
    argvPlan: argvPlan(["review", "cleanup"]),
    safety: "mutation",
    description: "Preview discarding all pending memory candidates with conflicts.",
    ...userCommandOnly,
    requiresApproval: true,
    tags: ["review", "memory", "discard", "conflict", "mutation"],
    argsSchema: { required: ["reason"] },
    examples: ["/review discard-conflicts --reason \"duplicate\""],
    triggers: {
      ko: ["컨플릭트 메모리 디스카드", "충돌 메모리 디스카드", "중복 메모리 정리"],
      en: ["discard conflicting memories", "discard all conflicting memories", "discard duplicate memories", "duplicate conflicting memories", "cleanup conflicting memories"]
    }
  },
  {
    commandId: "review.promote_skill",
    cliDisplay: "cosia skill candidate promote <candidate-id>",
    argvPlan: argvPlan(["skill", "candidate", "promote", "$target"]),
    safety: "mutation",
    description: "Preview promoting a skill candidate by index or id prefix.",
    ...userCommandOnly,
    requiresApproval: true,
    tags: ["review", "skill", "promote", "mutation"],
    argsSchema: { required: ["target"] },
    examples: ["/review promote <id-prefix>"],
    triggers: {
      ko: ["스킬 후보 승격", "스킬 승격"],
      en: ["promote skill candidate", "promote skill"]
    }
  },
  {
    commandId: "review.cleanup",
    cliDisplay: "cosia review cleanup",
    argvPlan: argvPlan(["review", "cleanup"]),
    safety: "mutation",
    description: "Preview cleanup of discarded review candidates after retention.",
    ...userCommandOnly,
    requiresApproval: true,
    tags: ["review", "cleanup", "mutation"],
    argsSchema: {},
    examples: ["/review cleanup"],
    triggers: {
      ko: ["리뷰 정리", "후보 정리", "디스카드 정리"],
      en: ["cleanup review", "review cleanup", "cleanup review queue"]
    }
  },
  {
    commandId: "memory.search",
    cliDisplay: "cosia memory search --query <query>",
    argvPlan: argvPlan(["memory", "search", "--query", "$query", "--tier", "$tier?", "--owner-id", "$ownerId?", "--limit", "$limit?", "--show-score", "$showScore?"]),
    safety: "read_only",
    description: "Search active long-term memories.",
    ...readOnlyModelSurface,
    tags: ["memory", "메모리", "기억", "search", "검색"],
    modelHint: "Use when the user asks to search durable long-term memory.",
    argsSchema: { required: ["query"], optional: ["tier", "ownerId", "limit", "showScore"] },
    argEnums: { tier: ["core", "agent", "session"] },
    examples: ["cosia memory search --query \"required provider\""],
    triggers: {
      ko: ["메모리 검색", "기억 검색", "메모리 찾아줘"],
      en: ["memory search", "search memory", "search memories", "find memory"]
    }
  },
  {
    commandId: "session.list",
    cliDisplay: "cosia session list",
    argvPlan: argvPlan(["session", "list"]),
    safety: "read_only",
    description: "List sessions.",
    ...readOnlyModelSurface,
    tags: ["session", "세션", "list", "목록"],
    modelHint: "Use when the user asks for available sessions.",
    argsSchema: {},
    examples: ["/sessions", "cosia session list"],
    triggers: {
      ko: ["세션 목록", "세션 보여줘"],
      en: ["sessions", "show sessions", "session list", "list sessions"]
    }
  },
  {
    commandId: "session.summary",
    cliDisplay: "cosia session show <session-id>",
    argvPlan: argvPlan(["session", "show", "$sessionId"]),
    safety: "read_only",
    description: "Show the current session summary.",
    ...readOnlyModelSurface,
    tags: ["session", "summary"],
    modelHint: "Use when the user asks for the current session summary.",
    argsSchema: { required: ["sessionId"] },
    examples: ["cosia session show <session-id>"],
    triggers: {
      ko: ["세션 요약", "요약 보여줘"],
      en: ["session summary", "show summary", "show session summary"]
    }
  },
  {
    commandId: "context.status",
    cliDisplay: "cosia session context status <session-id>",
    argvPlan: argvPlan(["session", "context", "status", "$sessionId"]),
    safety: "read_only",
    description: "Show context health for the current session.",
    ...readOnlyModelSurface,
    tags: ["session", "context", "status"],
    modelHint: "Use when the user asks about context memory size or health.",
    argsSchema: { required: ["sessionId"] },
    examples: ["cosia session context status <session-id>"],
    triggers: {
      ko: ["컨텍스트 상태", "문맥 상태"],
      en: ["context status", "context health", "show context"]
    }
  },
  {
    commandId: "provider.check",
    cliDisplay: "cosia provider profile check [profile-name]",
    argvPlan: argvPlan(["provider", "profile", "check", "$profileName?"]),
    safety: "read_only",
    description: "Check the active provider and list configured providers.",
    ...readOnlyModelSurface,
    tags: ["provider", "프로바이더", "model", "모델", "auth", "인증", "상태"],
    modelHint: "Use when the user asks which provider is configured or whether provider auth is healthy.",
    argsSchema: { optional: ["profileName"] },
    examples: ["cosia provider profile check"],
    triggers: {
      ko: ["프로바이더", "provider 확인", "모델 확인"],
      en: ["provider", "check provider", "provider status", "model provider"]
    }
  },
  {
    commandId: "tool.run",
    cliDisplay: "cosia tool <tool-id> --args <json>",
    argvPlan: argvPlan(["tool", "$toolId", "--args", "$toolArgs?"]),
    safety: "read_only",
    description: "Run a policy-gated catalog tool.",
    ...userCommandOnly,
    tags: ["tool", "advanced"],
    argsSchema: { required: ["toolId"], optional: ["toolArgs"] },
    examples: ["cosia tool active show <tool-id>"],
    triggers: {
      ko: ["도구 실행"],
      en: ["tool run"]
    }
  },
  {
    commandId: "shell.preview",
    cliDisplay: "cosia shell preview --command <command> --reason <reason>",
    argvPlan: argvPlan(["shell", "preview", "--command", "$command", "--reason", "$reason"]),
    safety: "preview_mutation",
    description: "Create a user-reviewable one-shot shell approval preview.",
    ...userCommandOnly,
    requiresApproval: true,
    tags: ["shell", "approval", "dangerous"],
    argsSchema: { required: ["command"], optional: ["reason"] },
    examples: ["/shell echo ready", "cosia shell preview --command \"echo ready\""],
    triggers: {
      ko: ["쉘 실행 제안", "쉘로 실행", "터미널 실행 제안"],
      en: ["shell preview", "suggest shell", "propose shell"]
    }
  },
  {
    commandId: "policy.check",
    cliDisplay: "cosia policy check",
    argvPlan: argvPlan(["policy", "check"]),
    safety: "read_only",
    description: "Check policy JSON and Markdown mirror health.",
    ...readOnlyModelSurface,
    tags: ["policy", "codex", "check"],
    modelHint: "Use when the user asks whether policy files and mirrors are healthy.",
    argsSchema: {},
    examples: ["cosia policy check"],
    triggers: {
      ko: ["정책 검사", "policy 검사", "정책 확인"],
      en: ["policy", "check policy", "policy check"]
    }
  },
  {
    commandId: "skill.list",
    cliDisplay: "cosia skill list",
    argvPlan: argvPlan(["skill", "list"]),
    safety: "read_only",
    description: "List global skills and current agent skill selection state.",
    ...readOnlyModelSurface,
    tags: ["skill", "스킬", "list", "목록"],
    modelHint: "Use when the user asks which skills are available.",
    argsSchema: {},
    examples: ["/skills list", "cosia skill list"],
    triggers: {
      ko: ["스킬 목록", "스킬 보여줘"],
      en: ["skills", "show skills", "skill list", "list skills"]
    }
  },
  {
    commandId: "run_jobs.list",
    cliDisplay: "/jobs",
    argvPlan: argvPlan([]),
    safety: "read_only",
    description: "Show current Gateway run jobs.",
    ...userCommandOnly,
    tags: ["gateway", "jobs", "status", "async"],
    modelHint: "If no model-callable job command is available, tell the user to use /jobs or /job <job-id>.",
    argsSchema: {},
    examples: ["/jobs"],
    triggers: {
      ko: ["진행중인 작업", "작업 목록", "잡 목록", "현재 작업"],
      en: ["jobs", "running jobs", "current jobs", "job list"]
    }
  },
  {
    commandId: "run_jobs.show",
    cliDisplay: "/job <job-id>",
    argvPlan: argvPlan([]),
    safety: "read_only",
    description: "Show one Gateway run job by id.",
    ...userCommandOnly,
    tags: ["gateway", "jobs", "status", "async"],
    modelHint: "If no model-callable job command is available, ask for or use the jobId and tell the user to run /job <job-id>.",
    argsSchema: { required: ["jobId"] },
    examples: ["/job <job-id>"],
    triggers: {
      ko: ["작업 상세", "잡 상세", "작업 상태"],
      en: ["job detail", "show job", "job status"]
    }
  },
  {
    commandId: "pending.show",
    cliDisplay: "cosia pending",
    argvPlan: argvPlan(["pending"]),
    safety: "read_only",
    description: "Show the current pending approval preview.",
    ...userCommandOnly,
    tags: ["pending", "approval"],
    modelHint: "If no model-callable pending command is available, tell the user to use /pending.",
    argsSchema: {},
    examples: ["/pending"],
    triggers: {
      ko: ["대기중인 승인", "대기 작업", "pending", "승인 대기"],
      en: ["pending", "pending approval", "pending action"]
    }
  },
  {
    commandId: "tool_growth.review",
    cliDisplay: "cosia tool grow review",
    argvPlan: argvPlan(["tool", "grow", "review"]),
    safety: "read_only",
    description: "Review tool growth routines.",
    ...userCommandOnly,
    tags: ["tool-growth", "tool", "routine", "candidate"],
    modelHint: "If no model-callable tool-growth status command is available, tell the user to use /tool grow show or cosia tool grow review.",
    argsSchema: {},
    examples: ["/tool grow show", "cosia tool grow review"],
    triggers: {
      ko: ["도구 생성 상태", "도구 성장 상태", "도구 후보", "도구 생성 완료"],
      en: ["tool growth status", "tool routine", "tool candidate status"]
    }
  },
  {
    commandId: "tool_growth.show",
    cliDisplay: "cosia tool grow show <routine-id>",
    argvPlan: argvPlan(["tool", "grow", "show", "$routineId"]),
    safety: "read_only",
    description: "Show a specific tool growth routine.",
    ...userCommandOnly,
    tags: ["tool-growth", "tool", "routine", "candidate"],
    modelHint: "If no model-callable tool-growth status command is available, ask for or use the routineId and tell the user to run /tool grow show <routine-id>.",
    argsSchema: { required: ["routineId"] },
    examples: ["/tool grow show <routine-id>", "cosia tool grow show <routine-id>"],
    triggers: {
      ko: ["도구 루틴 상세", "도구 생성 상세", "도구 성장 상세"],
      en: ["tool growth detail", "show tool growth routine"]
    }
  },
  command({ commandId: "init", cliDisplay: "cosia init", argvPlan: argvPlan(["init"]), safety: "system_boundary", description: "Initialize COSIA runtime files in the workspace.", tags: ["init", "초기화", "workspace", "setup"], requiresApproval: true }),
  command({ commandId: "start", cliDisplay: "cosia start", argvPlan: argvPlan(["start"]), safety: "dangerous", description: "Start the normal interactive COSIA entrypoint.", tags: ["start", "시작", "chat", "run"] }),
  command({ commandId: "run", cliDisplay: "cosia run <prompt>", argvPlan: argvPlan(["run", "$prompt"]), safety: "dangerous", description: "Run a prompt through COSIA from the CLI.", tags: ["run", "실행", "prompt"], argsSchema: { required: ["prompt"] } }),
  command({ commandId: "chat", cliDisplay: "cosia chat", argvPlan: argvPlan(["chat"]), safety: "dangerous", description: "Start local interactive chat.", tags: ["chat", "대화", "interactive"] }),
  command({ commandId: "doctor.show", cliDisplay: "cosia doctor", argvPlan: argvPlan(["doctor"]), safety: "read_only", description: "Show workspace doctor diagnostics.", ...readOnlyModelSurface, tags: ["doctor", "진단", "health", "repair"] }),
  command({ commandId: "doctor.repair", cliDisplay: "cosia doctor repair", argvPlan: argvPlan(["doctor", "repair"]), safety: "mutation", description: "Run deterministic workspace repairs.", tags: ["doctor", "repair", "복구"], requiresApproval: true }),
  command({ commandId: "doctor.reset", cliDisplay: "cosia doctor reset [--state|--factory] --yes", argvPlan: argvPlan(["doctor", "reset"]), safety: "system_boundary", description: "Preview or apply COSIA reset.", tags: ["doctor", "reset", "초기화"], requiresApproval: true }),
  command({ commandId: "pending.apply", cliDisplay: "cosia apply <id> --yes", argvPlan: argvPlan(["apply", "$id"]), safety: "mutation", description: "Apply a durable pending approval by id.", tags: ["pending", "approval", "apply", "적용"], argsSchema: { required: ["id"] }, requiresApproval: true }),
  command({ commandId: "pending.cancel", cliDisplay: "cosia cancel <id> --reason <reason>", argvPlan: argvPlan(["cancel", "$id", "--reason", "$reason"]), safety: "mutation", description: "Cancel a durable pending approval by id.", tags: ["pending", "approval", "cancel", "취소"], argsSchema: { required: ["id", "reason"] }, requiresApproval: true }),
  command({ commandId: "config.show", cliDisplay: "cosia config show", argvPlan: argvPlan(["config", "show"]), safety: "read_only", description: "Show runtime configuration.", ...readOnlyModelSurface, tags: ["config", "설정", "runtime"] }),
  command({ commandId: "config.check", cliDisplay: "cosia config check", argvPlan: argvPlan(["config", "check"]), safety: "read_only", description: "Check runtime configuration schema and repair hints.", ...readOnlyModelSurface, tags: ["config", "설정", "check", "검사"] }),
  command({ commandId: "config.migrate", cliDisplay: "cosia config migrate", argvPlan: argvPlan(["config", "migrate"]), safety: "system_boundary", description: "Migrate runtime configuration.", tags: ["config", "migrate", "migration"], requiresApproval: true }),
  command({ commandId: "policy.show", cliDisplay: "cosia policy show", argvPlan: argvPlan(["policy", "show"]), safety: "read_only", description: "Show policy configuration.", ...readOnlyModelSurface, tags: ["policy", "정책", "codex"] }),
  command({ commandId: "policy.sync", cliDisplay: "cosia policy sync", argvPlan: argvPlan(["policy", "sync"]), safety: "system_boundary", description: "Sync generated policy Markdown mirror.", tags: ["policy", "sync", "mirror"], requiresApproval: true }),
  command({ commandId: "policy.audit", cliDisplay: "cosia policy audit", argvPlan: argvPlan(["policy", "audit"]), safety: "read_only", description: "Show policy audit information.", ...readOnlyModelSurface, tags: ["policy", "audit", "감사"] }),
  command({ commandId: "codex.show", cliDisplay: "cosia codex show [--path <path>]", argvPlan: argvPlan(["codex", "show", "--path", "$path?"]), safety: "read_only", description: "Show protected Codex law content.", ...readOnlyModelSurface, tags: ["codex", "법전", "law"], argsSchema: { optional: ["path"] } }),
  command({ commandId: "codex.check", cliDisplay: "cosia codex check", argvPlan: argvPlan(["codex", "check"]), safety: "read_only", description: "Check protected Codex law files and pending amendments.", ...readOnlyModelSurface, tags: ["codex", "법전", "check", "검사"] }),
  command({ commandId: "codex.amendment.list", cliDisplay: "cosia codex amendment list", argvPlan: argvPlan(["codex", "amendment", "list"]), safety: "read_only", description: "List Codex law amendments.", ...readOnlyModelSurface, tags: ["codex", "amendment", "개정", "pending"] }),
  command({ commandId: "codex.amendment.show", cliDisplay: "cosia codex amendment show <id>", argvPlan: argvPlan(["codex", "amendment", "show", "$id"]), safety: "read_only", description: "Show one Codex law amendment.", ...readOnlyModelSurface, tags: ["codex", "amendment", "개정"], argsSchema: { required: ["id"] } }),
  command({ commandId: "codex.amendment.propose", cliDisplay: "cosia codex amendment propose --path <path> --content <text> --reason <reason>", argvPlan: argvPlan(["codex", "amendment", "propose", "--path", "$path", "--content", "$content", "--reason", "$reason"]), safety: "system_boundary", description: "Propose a protected Codex law amendment.", tags: ["codex", "amendment", "개정", "propose"], argsSchema: { required: ["path", "content", "reason"] }, requiresApproval: true }),
  command({ commandId: "codex.amendment.apply", cliDisplay: "cosia codex amendment apply <id> --yes", argvPlan: argvPlan(["codex", "amendment", "apply", "$id"]), safety: "system_boundary", description: "Apply a Codex law amendment.", tags: ["codex", "amendment", "apply", "적용"], argsSchema: { required: ["id"] }, requiresApproval: true }),
  command({ commandId: "codex.amendment.reject", cliDisplay: "cosia codex amendment reject <id> --reason <reason>", argvPlan: argvPlan(["codex", "amendment", "reject", "$id", "--reason", "$reason"]), safety: "system_boundary", description: "Reject a Codex law amendment.", tags: ["codex", "amendment", "reject"], argsSchema: { required: ["id", "reason"] }, requiresApproval: true }),
  command({ commandId: "codex.amendment.cancel", cliDisplay: "cosia codex amendment cancel <id> --reason <reason>", argvPlan: argvPlan(["codex", "amendment", "cancel", "$id", "--reason", "$reason"]), safety: "system_boundary", description: "Cancel a Codex law amendment.", tags: ["codex", "amendment", "cancel"], argsSchema: { required: ["id", "reason"] }, requiresApproval: true }),
  command({ commandId: "provider.list_supported", cliDisplay: "cosia provider list-supported", argvPlan: argvPlan(["provider", "list-supported"]), safety: "read_only", description: "List supported provider setup paths.", ...readOnlyModelSurface, tags: ["provider", "프로바이더", "지원", "setup"] }),
  command({ commandId: "provider.setup", cliDisplay: "cosia provider setup", argvPlan: argvPlan(["provider", "setup"]), safety: "system_boundary", description: "Guided provider profile setup.", tags: ["provider", "setup", "profile", "프로바이더"], requiresApproval: true }),
  command({ commandId: "provider.list", cliDisplay: "cosia provider list", argvPlan: argvPlan(["provider", "list"]), safety: "read_only", description: "List configured model provider records.", ...readOnlyModelSurface, tags: ["provider", "프로바이더", "list", "목록"] }),
  command({ commandId: "provider.profile.add", cliDisplay: "cosia provider profile add <name> --provider <provider>", argvPlan: argvPlan(["provider", "profile", "add", "$name", "--provider", "$provider"]), safety: "system_boundary", description: "Add a provider profile.", tags: ["provider", "profile", "add", "프로바이더"], argsSchema: { required: ["name", "provider"] }, requiresApproval: true }),
  command({ commandId: "provider.profile.use", cliDisplay: "cosia provider profile use <name>", argvPlan: argvPlan(["provider", "profile", "use", "$name"]), safety: "system_boundary", description: "Select the active provider profile.", tags: ["provider", "profile", "use", "active"], argsSchema: { required: ["name"] }, requiresApproval: true }),
  command({ commandId: "provider.profile.list", cliDisplay: "cosia provider profile list", argvPlan: argvPlan(["provider", "profile", "list"]), safety: "read_only", description: "List provider profiles.", ...readOnlyModelSurface, tags: ["provider", "profile", "list", "프로바이더"] }),
  command({ commandId: "provider.profile.show", cliDisplay: "cosia provider profile show <name>", argvPlan: argvPlan(["provider", "profile", "show", "$name"]), safety: "read_only", description: "Show a provider profile without secrets.", ...readOnlyModelSurface, tags: ["provider", "profile", "show"], argsSchema: { required: ["name"] } }),
  command({ commandId: "provider.profile.check", cliDisplay: "cosia provider profile check [name]", argvPlan: argvPlan(["provider", "profile", "check", "$name?"]), safety: "read_only", description: "Check active or named provider profile auth status.", ...readOnlyModelSurface, tags: ["provider", "프로바이더", "profile", "check", "상태", "auth"], argsSchema: { optional: ["name"] } }),
  command({ commandId: "provider.profile.remove", cliDisplay: "cosia provider profile remove <name>", argvPlan: argvPlan(["provider", "profile", "remove", "$name"]), safety: "system_boundary", description: "Remove a provider profile.", tags: ["provider", "profile", "remove"], argsSchema: { required: ["name"] }, requiresApproval: true }),
  command({ commandId: "provider.oauth.login", cliDisplay: "cosia provider oauth login <profile-name>", argvPlan: argvPlan(["provider", "oauth", "login", "$profileName"]), safety: "system_boundary", description: "Run provider OAuth login flow.", tags: ["provider", "oauth", "login"], argsSchema: { required: ["profileName"] }, requiresApproval: true }),
  command({ commandId: "gateway.start", cliDisplay: "cosia gateway start", argvPlan: argvPlan(["gateway", "start"]), safety: "dangerous", description: "Start gateway process.", tags: ["gateway", "start"] }),
  command({ commandId: "gateway.stop", cliDisplay: "cosia gateway stop", argvPlan: argvPlan(["gateway", "stop"]), safety: "mutation", description: "Stop gateway process.", tags: ["gateway", "stop"], requiresApproval: true }),
  command({ commandId: "gateway.restart", cliDisplay: "cosia gateway restart", argvPlan: argvPlan(["gateway", "restart"]), safety: "mutation", description: "Restart gateway process.", tags: ["gateway", "restart"], requiresApproval: true }),
  command({ commandId: "gateway.unlock", cliDisplay: "cosia gateway unlock --stale-only", argvPlan: argvPlan(["gateway", "unlock"]), safety: "mutation", description: "Remove stale gateway process lock.", tags: ["gateway", "unlock", "stale"], requiresApproval: true }),
  command({ commandId: "gateway.auth.allow_chat", cliDisplay: "cosia gateway auth allow-chat <connector> <chat-id>", argvPlan: argvPlan(["gateway", "auth", "allow-chat", "$connector", "$chatId"]), safety: "system_boundary", description: "Allow an external connector chat.", tags: ["gateway", "auth", "권한", "chat", "채팅"], argsSchema: { required: ["connector", "chatId"] }, requiresApproval: true }),
  command({ commandId: "gateway.auth.remove_chat", cliDisplay: "cosia gateway auth remove-chat <connector> <chat-id>", argvPlan: argvPlan(["gateway", "auth", "remove-chat", "$connector", "$chatId"]), safety: "system_boundary", description: "Remove an allowed external connector chat.", tags: ["gateway", "auth", "remove", "chat"], argsSchema: { required: ["connector", "chatId"] }, requiresApproval: true }),
  command({ commandId: "gateway.auth.set_master", cliDisplay: "cosia gateway auth set-master <connector> <user-id>", argvPlan: argvPlan(["gateway", "auth", "set-master", "$connector", "$userId"]), safety: "system_boundary", description: "Set the single global Gateway master user.", tags: ["gateway", "auth", "master", "마스터", "권한"], argsSchema: { required: ["connector", "userId"] }, requiresApproval: true }),
  command({ commandId: "gateway.auth.clear_master", cliDisplay: "cosia gateway auth clear-master", argvPlan: argvPlan(["gateway", "auth", "clear-master"]), safety: "system_boundary", description: "Clear the Gateway master user.", tags: ["gateway", "auth", "master"], requiresApproval: true }),
  command({ commandId: "gateway.auth.set_role", cliDisplay: "cosia gateway auth set-role <connector> <user-id> <guest|admin> --chat-id <chat-id>", argvPlan: argvPlan(["gateway", "auth", "set-role", "$connector", "$userId", "$role", "--chat-id", "$chatId"]), safety: "system_boundary", description: "Set a chat-scoped Gateway guest/admin role.", tags: ["gateway", "auth", "role", "권한"], argsSchema: { required: ["connector", "userId", "role", "chatId"] }, argEnums: { role: ["guest", "admin"] }, requiresApproval: true }),
  command({ commandId: "gateway.auth.unset_role", cliDisplay: "cosia gateway auth unset-role <connector> <user-id> --chat-id <chat-id>", argvPlan: argvPlan(["gateway", "auth", "unset-role", "$connector", "$userId", "--chat-id", "$chatId"]), safety: "system_boundary", description: "Unset a chat-scoped Gateway role.", tags: ["gateway", "auth", "role"], argsSchema: { required: ["connector", "userId", "chatId"] }, requiresApproval: true }),
  command({ commandId: "gateway.auth.list", cliDisplay: "cosia gateway auth list", argvPlan: argvPlan(["gateway", "auth", "list"]), safety: "read_only", description: "List Gateway authorization summary.", ...readOnlyModelSurface, tags: ["gateway", "auth", "권한", "list", "목록"] }),
  command({ commandId: "gateway.auth.check", cliDisplay: "cosia gateway auth check <connector> --chat-id <id> --user-id <id>", argvPlan: argvPlan(["gateway", "auth", "check", "$connector", "--chat-id", "$chatId", "--user-id", "$userId"]), safety: "read_only", description: "Check Gateway authorization for one actor.", ...readOnlyModelSurface, tags: ["gateway", "auth", "권한", "check"], argsSchema: { required: ["connector", "chatId", "userId"] } }),
  command({ commandId: "gateway.telegram.enable", cliDisplay: "cosia gateway telegram enable", argvPlan: argvPlan(["gateway", "telegram", "enable"]), safety: "system_boundary", description: "Enable Telegram connector.", tags: ["gateway", "telegram", "텔레그램", "enable"], requiresApproval: true }),
  command({ commandId: "gateway.telegram.disable", cliDisplay: "cosia gateway telegram disable", argvPlan: argvPlan(["gateway", "telegram", "disable"]), safety: "system_boundary", description: "Disable Telegram connector.", tags: ["gateway", "telegram", "텔레그램", "disable"], requiresApproval: true }),
  command({ commandId: "gateway.telegram.set", cliDisplay: "cosia gateway telegram set <field> <value>", argvPlan: argvPlan(["gateway", "telegram", "set", "$field", "$value?"]), safety: "system_boundary", description: "Set Telegram connector field.", tags: ["gateway", "telegram", "텔레그램", "set"], argsSchema: { required: ["field"], optional: ["value"] }, requiresApproval: true }),
  command({ commandId: "gateway.telegram.unset", cliDisplay: "cosia gateway telegram unset <field> <value>", argvPlan: argvPlan(["gateway", "telegram", "unset", "$field", "$value?"]), safety: "system_boundary", description: "Unset Telegram connector field.", tags: ["gateway", "telegram", "텔레그램", "unset"], argsSchema: { required: ["field"], optional: ["value"] }, requiresApproval: true }),
  command({ commandId: "gateway.telegram.list", cliDisplay: "cosia gateway telegram list", argvPlan: argvPlan(["gateway", "telegram", "list"]), safety: "read_only", description: "List Telegram connector settings without secrets.", ...readOnlyModelSurface, tags: ["gateway", "telegram", "텔레그램", "list"] }),
  command({ commandId: "gateway.telegram.check", cliDisplay: "cosia gateway telegram check", argvPlan: argvPlan(["gateway", "telegram", "check"]), safety: "read_only", description: "Check Telegram connector configuration.", ...readOnlyModelSurface, tags: ["gateway", "telegram", "텔레그램", "check"] }),
  command({ commandId: "gateway.telegram.webhook.status", cliDisplay: "cosia gateway telegram webhook status", argvPlan: argvPlan(["gateway", "telegram", "webhook", "status"]), safety: "read_only", description: "Show Telegram Bot API webhook status for the connector.", ...readOnlyModelSurface, tags: ["gateway", "telegram", "텔레그램", "webhook", "웹훅", "status"] }),
  command({ commandId: "gateway.telegram.webhook.clear", cliDisplay: "cosia gateway telegram webhook clear --yes", argvPlan: argvPlan(["gateway", "telegram", "webhook", "clear"]), safety: "system_boundary", description: "Disable the Telegram Bot API webhook so COSIA long polling can run.", tags: ["gateway", "telegram", "텔레그램", "webhook", "웹훅", "clear"], requiresApproval: true }),
  command({ commandId: "gateway.telegram.state", cliDisplay: "cosia gateway telegram state", argvPlan: argvPlan(["gateway", "telegram", "state"]), safety: "read_only", description: "Show Telegram connector state.", ...readOnlyModelSurface, tags: ["gateway", "telegram", "state"] }),
  command({ commandId: "gateway.telegram.repair", cliDisplay: "cosia gateway telegram repair --stale-sessions", argvPlan: argvPlan(["gateway", "telegram", "repair"]), safety: "mutation", description: "Repair Telegram connector state.", tags: ["gateway", "telegram", "repair"], requiresApproval: true }),
  command({ commandId: "gateway.telegram.reset_state", cliDisplay: "cosia gateway telegram reset-state --yes", argvPlan: argvPlan(["gateway", "telegram", "reset-state"]), safety: "mutation", description: "Reset Telegram connector state.", tags: ["gateway", "telegram", "reset"], requiresApproval: true }),
  command({ commandId: "capability.review", cliDisplay: "cosia capability review", argvPlan: argvPlan(["capability", "review"]), safety: "read_only", description: "Review capability proposals.", ...readOnlyModelSurface, tags: ["capability", "능력", "proposal", "review"] }),
  command({ commandId: "capability.scan", cliDisplay: "cosia capability scan --request <text>", argvPlan: argvPlan(["capability", "scan", "--request", "$request?"]), safety: "read_only", description: "Scan workspace capability facts.", ...readOnlyModelSurface, tags: ["capability", "scan", "능력"], argsSchema: { optional: ["request"] } }),
  command({ commandId: "capability.facts", cliDisplay: "cosia capability facts", argvPlan: argvPlan(["capability", "facts"]), safety: "read_only", description: "Show capability facts.", ...readOnlyModelSurface, tags: ["capability", "facts", "능력"] }),
  command({ commandId: "capability.plan", cliDisplay: "cosia capability plan --request <text>", argvPlan: argvPlan(["capability", "plan", "--request", "$request"]), safety: "preview_mutation", description: "Create a capability proposal from a request.", tags: ["capability", "plan", "proposal"], argsSchema: { required: ["request"] }, requiresApproval: true }),
  command({ commandId: "capability.show", cliDisplay: "cosia capability show <id>", argvPlan: argvPlan(["capability", "show", "$id"]), safety: "read_only", description: "Show a capability proposal.", ...readOnlyModelSurface, tags: ["capability", "show"], argsSchema: { required: ["id"] } }),
  command({ commandId: "capability.discard", cliDisplay: "cosia capability discard <id> --reason <reason>", argvPlan: argvPlan(["capability", "discard", "$id", "--reason", "$reason"]), safety: "mutation", description: "Discard a capability proposal.", tags: ["capability", "discard"], argsSchema: { required: ["id", "reason"] }, requiresApproval: true }),
  command({ commandId: "shell.status", cliDisplay: "cosia shell status", argvPlan: argvPlan(["shell", "status"]), safety: "read_only", description: "List shell approvals.", ...readOnlyModelSurface, tags: ["shell", "approval", "status"] }),
  command({ commandId: "shell.apply", cliDisplay: "cosia shell apply <approval-id> --confirm <phrase>", argvPlan: argvPlan(["shell", "apply", "$approvalId"]), safety: "dangerous", description: "Apply a shell approval.", tags: ["shell", "apply"], argsSchema: { required: ["approvalId"] }, requiresApproval: true }),
  command({ commandId: "shell.run", cliDisplay: "cosia shell run --command <command> --yes", argvPlan: argvPlan(["shell", "run", "--command", "$command"]), safety: "dangerous", description: "Preview or run a shell command.", tags: ["shell", "run"], argsSchema: { required: ["command"] }, requiresApproval: true }),
  command({ commandId: "shell.cancel", cliDisplay: "cosia shell cancel <approval-id>", argvPlan: argvPlan(["shell", "cancel", "$approvalId"]), safety: "mutation", description: "Cancel shell approval.", tags: ["shell", "cancel"], argsSchema: { required: ["approvalId"] }, requiresApproval: true }),
  command({ commandId: "tool.list", cliDisplay: "cosia tool list", argvPlan: argvPlan(["tool", "list"]), safety: "read_only", description: "List tool catalog and active tools.", ...readOnlyModelSurface, tags: ["tool", "도구", "list"] }),
  command({ commandId: "tool.draft", cliDisplay: "cosia tool draft --from-capability <id>", argvPlan: argvPlan(["tool", "draft", "--from-capability", "$capabilityId"]), safety: "preview_mutation", description: "Create a tool draft from a capability proposal.", tags: ["tool", "draft", "도구"], argsSchema: { required: ["capabilityId"] }, requiresApproval: true }),
  command({ commandId: "tool.grow.start", cliDisplay: "cosia tool grow --request <text>", argvPlan: argvPlan(["tool", "grow", "--request", "$request"]), safety: "preview_mutation", description: "Start a guided tool growth routine.", tags: ["tool-growth", "tool", "도구", "grow"], argsSchema: { required: ["request"] }, requiresApproval: true }),
  command({ commandId: "tool.grow.review", cliDisplay: "cosia tool grow review", argvPlan: argvPlan(["tool", "grow", "review"]), safety: "read_only", description: "Review tool growth routines.", ...readOnlyModelSurface, tags: ["tool-growth", "tool", "도구", "review"] }),
  command({ commandId: "tool.grow.show", cliDisplay: "cosia tool grow show <routine-id>", argvPlan: argvPlan(["tool", "grow", "show", "$routineId"]), safety: "read_only", description: "Show one tool growth routine.", ...readOnlyModelSurface, tags: ["tool-growth", "tool", "도구", "show"], argsSchema: { required: ["routineId"] } }),
  command({ commandId: "tool.grow.test", cliDisplay: "cosia tool grow test <routine-id> --yes", argvPlan: argvPlan(["tool", "grow", "test", "$routineId"]), safety: "mutation", description: "Run a tool growth candidate test.", tags: ["tool-growth", "test", "도구"], argsSchema: { required: ["routineId"] }, requiresApproval: true }),
  command({ commandId: "tool.grow.activate", cliDisplay: "cosia tool grow activate <routine-id> --agent <agent-id> --yes", argvPlan: argvPlan(["tool", "grow", "activate", "$routineId", "--agent", "$agentId"]), safety: "mutation", description: "Activate a grown tool through existing activation gates.", tags: ["tool-growth", "activate", "도구"], argsSchema: { required: ["routineId", "agentId"] }, requiresApproval: true }),
  command({ commandId: "tool.candidate.review", cliDisplay: "cosia tool candidate review", argvPlan: argvPlan(["tool", "candidate", "review"]), safety: "read_only", description: "Review tool candidates.", ...readOnlyModelSurface, tags: ["tool", "candidate", "도구", "review"] }),
  command({ commandId: "tool.candidate.show", cliDisplay: "cosia tool candidate show <candidate-id>", argvPlan: argvPlan(["tool", "candidate", "show", "$candidateId"]), safety: "read_only", description: "Show a tool candidate.", ...readOnlyModelSurface, tags: ["tool", "candidate", "show"], argsSchema: { required: ["candidateId"] } }),
  command({ commandId: "tool.candidate.approve", cliDisplay: "cosia tool candidate approve <candidate-id>", argvPlan: argvPlan(["tool", "candidate", "approve", "$candidateId"]), safety: "mutation", description: "Approve a tool candidate design.", tags: ["tool", "candidate", "approve"], argsSchema: { required: ["candidateId"] }, requiresApproval: true }),
  command({ commandId: "tool.candidate.test", cliDisplay: "cosia tool candidate test <candidate-id>", argvPlan: argvPlan(["tool", "candidate", "test", "$candidateId"]), safety: "mutation", description: "Test a tool candidate.", tags: ["tool", "candidate", "test"], argsSchema: { required: ["candidateId"] }, requiresApproval: true }),
  command({ commandId: "tool.active.list", cliDisplay: "cosia tool active list", argvPlan: argvPlan(["tool", "active", "list"]), safety: "read_only", description: "List active tools.", ...readOnlyModelSurface, tags: ["tool", "active", "도구"] }),
  command({ commandId: "tool.active.show", cliDisplay: "cosia tool active show <tool-id>", argvPlan: argvPlan(["tool", "active", "show", "$toolId"]), safety: "read_only", description: "Show an active tool.", ...readOnlyModelSurface, tags: ["tool", "active", "show"], argsSchema: { required: ["toolId"] } }),
  command({ commandId: "tool.activate", cliDisplay: "cosia tool activate <candidate-id> --agent <agent-id> --yes", argvPlan: argvPlan(["tool", "activate", "$candidateId", "--agent", "$agentId"]), safety: "mutation", description: "Activate a tool candidate.", tags: ["tool", "activate"], argsSchema: { required: ["candidateId", "agentId"] }, requiresApproval: true }),
  command({ commandId: "tool.deactivate", cliDisplay: "cosia tool deactivate <tool-id> --reason <reason>", argvPlan: argvPlan(["tool", "deactivate", "$toolId", "--reason", "$reason"]), safety: "mutation", description: "Deactivate an active tool.", tags: ["tool", "deactivate"], argsSchema: { required: ["toolId", "reason"] }, requiresApproval: true }),
  command({ commandId: "tool.blueprint.list", cliDisplay: "cosia tool blueprint list", argvPlan: argvPlan(["tool", "blueprint", "list"]), safety: "read_only", description: "List learned local tool blueprints.", ...readOnlyModelSurface, tags: ["tool", "blueprint", "도구"] }),
  command({ commandId: "tool.blueprint.show", cliDisplay: "cosia tool blueprint show <blueprint-id>", argvPlan: argvPlan(["tool", "blueprint", "show", "$blueprintId"]), safety: "read_only", description: "Show a learned local blueprint.", ...readOnlyModelSurface, tags: ["tool", "blueprint"], argsSchema: { required: ["blueprintId"] } }),
  command({ commandId: "tool.blueprint.create_from_active", cliDisplay: "cosia tool blueprint create-from-active <tool-id> --yes", argvPlan: argvPlan(["tool", "blueprint", "create-from-active", "$toolId"]), safety: "mutation", description: "Create learned blueprint from active tool.", tags: ["tool", "blueprint", "create"], argsSchema: { required: ["toolId"] }, requiresApproval: true })
];

const cliCoverageInputs: CommandInput[] = [
  coverageCommand("provider.group", ["provider"], "read_only", "Show provider command help.", ["provider", "help"]),
  coverageCommand("provider.check_id", ["provider", "check"], "read_only", "Check one provider implementation id.", ["provider", "check"], ["provider", "check", "$providerId"], { required: ["providerId"] }),
  coverageCommand("provider.oauth.group", ["provider", "oauth"], "read_only", "Show provider OAuth command help.", ["provider", "oauth", "help"]),
  coverageCommand("provider.profile.group", ["provider", "profile"], "read_only", "Show provider profile command help.", ["provider", "profile", "help"]),
  coverageCommand("config.group", ["config"], "read_only", "Show config command help.", ["config", "help"]),
  coverageCommand("gateway.group", ["gateway"], "read_only", "Show gateway command help.", ["gateway", "help"]),
  coverageCommand("gateway.auth.group", ["gateway", "auth"], "read_only", "Show gateway auth command help.", ["gateway", "auth", "help"]),
  coverageCommand("gateway.telegram.group", ["gateway", "telegram"], "read_only", "Show Telegram connector command help.", ["gateway", "telegram", "help"]),
  coverageCommand("gateway.telegram.webhook.group", ["gateway", "telegram", "webhook"], "read_only", "Show Telegram webhook command help.", ["gateway", "telegram", "webhook", "help"]),
  coverageCommand("gateway.telegram.start_direct", ["gateway", "telegram", "start"], "dangerous", "Debug-start Telegram long polling directly.", ["gateway", "telegram", "start"]),
  coverageCommand("gateway.telegram.unlock_direct", ["gateway", "telegram", "unlock"], "mutation", "Remove a stale Telegram connector process lock.", ["gateway", "telegram", "unlock"], ["gateway", "telegram", "unlock"]),
  coverageCommand("mvp.group", ["mvp"], "read_only", "Show historical MVP helper command help.", ["mvp", "help"]),
  coverageCommand("mvp.checklist", ["mvp", "checklist"], "read_only", "Print the historical MVP acceptance checklist.", ["mvp", "checklist"]),
  coverageCommand("improve.group", ["improve"], "read_only", "Show self-improvement command help.", ["improve", "help"]),
  coverageCommand("improve.status", ["improve", "status"], "read_only", "Show self-improvement backlog and evidence status.", ["improve", "status"]),
  coverageCommand("improve.preview", ["improve", "preview"], "read_only", "Preview eligible self-improvement changes.", ["improve", "preview"]),
  coverageCommand("improve.apply", ["improve", "apply"], "mutation", "Apply eligible self-improvements.", ["improve", "apply"]),
  coverageCommand("improve.review", ["improve", "review"], "read_only", "List improvement evidence records.", ["improve", "review"]),
  coverageCommand("improve.show", ["improve", "show"], "read_only", "Show one improvement evidence record.", ["improve", "show"], ["improve", "show", "$id"], { required: ["id"] }),
  coverageCommand("improve.revert", ["improve", "revert"], "mutation", "Revert an applied automatic improvement.", ["improve", "revert"], ["improve", "revert", "$id"], { required: ["id"] }),
  coverageCommand("improve.discard", ["improve", "discard"], "mutation", "Discard an improvement recommendation.", ["improve", "discard"], ["improve", "discard", "$id"], { required: ["id"] }),
  coverageCommand("agent.group", ["agent"], "read_only", "Show agent command help.", ["agent", "help"]),
  coverageCommand("agent.create", ["agent", "create"], "system_boundary", "Create an agent from a template.", ["agent", "create"], ["agent", "create", "$agentId"], { required: ["agentId"] }),
  coverageCommand("agent.list", ["agent", "list"], "read_only", "List agents.", ["agent", "list"]),
  coverageCommand("agent.show", ["agent", "show"], "read_only", "Show one agent.", ["agent", "show"], ["agent", "show", "$agentId"], { required: ["agentId"] }),
  coverageCommand("agent.default.group", ["agent", "default"], "read_only", "Show default-agent command help.", ["agent", "default", "help"]),
  coverageCommand("agent.default.show", ["agent", "default", "show"], "read_only", "Show the default agent.", ["agent", "default", "show"]),
  coverageCommand("agent.default.set", ["agent", "default", "set"], "system_boundary", "Set the default agent.", ["agent", "default", "set"], ["agent", "default", "set", "$agentId"], { required: ["agentId"] }),
  coverageCommand("agent.bootstrap", ["agent", "bootstrap"], "system_boundary", "Create a guided agent and set it as default.", ["agent", "bootstrap"]),
  coverageCommand("agent.delete", ["agent", "delete"], "system_boundary", "Preview or delete an agent.", ["agent", "delete"], ["agent", "delete", "$agentId"], { required: ["agentId"] }),
  coverageCommand("agent.recommend", ["agent", "recommend"], "read_only", "Recommend an agent for a prompt.", ["agent", "recommend"]),
  coverageCommand("agent.sessions", ["agent", "sessions"], "read_only", "List sessions assigned to an agent.", ["agent", "sessions"], ["agent", "sessions", "$agentId"], { required: ["agentId"] }),
  coverageCommand("session.group", ["session"], "read_only", "Show session command help.", ["session", "help"]),
  coverageCommand("session.create", ["session", "create"], "mutation", "Create a session.", ["session", "create"]),
  coverageCommand("session.assign", ["session", "assign"], "mutation", "Assign a session to an agent.", ["session", "assign"], ["session", "assign", "$sessionId"], { required: ["sessionId"] }),
  coverageCommand("session.unassign", ["session", "unassign"], "mutation", "Remove a session assigned agent.", ["session", "unassign"], ["session", "unassign", "$sessionId"], { required: ["sessionId"] }),
  coverageCommand("session.archive", ["session", "archive"], "mutation", "Archive a session.", ["session", "archive"], ["session", "archive", "$sessionId"], { required: ["sessionId"] }),
  coverageCommand("session.summarize", ["session", "summarize"], "mutation", "Summarize a session.", ["session", "summarize"], ["session", "summarize", "$sessionId"], { required: ["sessionId"] }),
  coverageCommand("session.prompt", ["session", "prompt"], "read_only", "Inspect session prompt manifest.", ["session", "prompt"]),
  coverageCommand("session.debug", ["session", "debug"], "read_only", "Inspect session debug records.", ["session", "debug"], ["session", "debug", "$sessionId"], { required: ["sessionId"] }),
  coverageCommand("session.context.group", ["session", "context"], "read_only", "Show session context command help.", ["session", "context", "help"]),
  coverageCommand("session.context.undo_last", ["session", "context", "undo-last"], "mutation", "Undo the latest session context compaction.", ["session", "context", "undo"], ["session", "context", "undo-last", "$sessionId"], { required: ["sessionId"] }),
  coverageCommand("session.context.compact", ["session", "context", "compact"], "mutation", "Preview or apply session context compaction.", ["session", "context", "compact"], ["session", "context", "compact", "$sessionId"], { required: ["sessionId"] }),
  coverageCommand("memory.group", ["memory"], "read_only", "Show memory command help.", ["memory", "help"]),
  coverageCommand("memory.add", ["memory", "add"], "mutation", "Add a long-term memory record.", ["memory", "add"]),
  coverageCommand("memory.list", ["memory", "list"], "read_only", "List active long-term memories.", ["memory", "list"]),
  coverageCommand("memory.show", ["memory", "show"], "read_only", "Show one memory record.", ["memory", "show"], ["memory", "show", "$memoryId"], { required: ["memoryId"] }),
  coverageCommand("memory.update", ["memory", "update"], "mutation", "Update a memory record.", ["memory", "update"], ["memory", "update", "$memoryId"], { required: ["memoryId"] }),
  coverageCommand("memory.archive", ["memory", "archive"], "mutation", "Archive a memory record.", ["memory", "archive"], ["memory", "archive", "$memoryId"], { required: ["memoryId"] }),
  coverageCommand("memory.promote", ["memory", "promote"], "mutation", "Promote memory between tiers.", ["memory", "promote"], ["memory", "promote", "$memoryId"], { required: ["memoryId"] }),
  coverageCommand("memory.candidate.group", ["memory", "candidate"], "read_only", "Show memory candidate command help.", ["memory", "candidate", "help"]),
  coverageCommand("memory.candidate.export", ["memory", "candidate", "export"], "read_only", "Export memory candidates.", ["memory", "candidate", "export"]),
  coverageCommand("memory.candidate.list", ["memory", "candidate", "list"], "read_only", "List memory candidates.", ["memory", "candidate", "list"]),
  coverageCommand("memory.candidate.show", ["memory", "candidate", "show"], "read_only", "Show one memory candidate.", ["memory", "candidate", "show"], ["memory", "candidate", "show", "$candidateId"], { required: ["candidateId"] }),
  coverageCommand("memory.candidate.review", ["memory", "candidate", "review"], "read_only", "Show memory candidate review details.", ["memory", "candidate", "review"], ["memory", "candidate", "review", "$candidateId"], { required: ["candidateId"] }),
  coverageCommand("memory.promotion.group", ["memory", "promotion"], "read_only", "Show memory promotion command help.", ["memory", "promotion", "help"]),
  coverageCommand("memory.promotion.export", ["memory", "promotion", "export"], "read_only", "Export memory promotions.", ["memory", "promotion", "export"]),
  coverageCommand("memory.promotion.list", ["memory", "promotion", "list"], "read_only", "List memory promotions.", ["memory", "promotion", "list"]),
  coverageCommand("memory.promotion.show", ["memory", "promotion", "show"], "read_only", "Show one memory promotion.", ["memory", "promotion", "show"], ["memory", "promotion", "show", "$promotionId"], { required: ["promotionId"] }),
  coverageCommand("memory.promotion.revert", ["memory", "promotion", "revert"], "mutation", "Revert a memory promotion.", ["memory", "promotion", "revert"], ["memory", "promotion", "revert", "$promotionId"], { required: ["promotionId"] }),
  coverageCommand("skill.group", ["skill"], "read_only", "Show skill command help.", ["skill", "help"]),
  coverageCommand("skill.candidate.group", ["skill", "candidate"], "read_only", "Show skill candidate command help.", ["skill", "candidate", "help"]),
  coverageCommand("skill.candidate.list", ["skill", "candidate", "list"], "read_only", "List skill candidates.", ["skill", "candidate", "list"]),
  coverageCommand("skill.candidate.show", ["skill", "candidate", "show"], "read_only", "Show one skill candidate.", ["skill", "candidate", "show"], ["skill", "candidate", "show", "$candidateId"], { required: ["candidateId"] }),
  coverageCommand("skill.candidate.discard", ["skill", "candidate", "discard"], "mutation", "Discard a pending skill candidate.", ["skill", "candidate", "discard"], ["skill", "candidate", "discard", "$candidateId"], { required: ["candidateId"] }),
  coverageCommand("skill.candidate.export", ["skill", "candidate", "export"], "read_only", "Export skill candidates.", ["skill", "candidate", "export"]),
  coverageCommand("skill.show", ["skill", "show"], "read_only", "Show one global skill.", ["skill", "show"], ["skill", "show", "$skillId"], { required: ["skillId"] }),
  coverageCommand("skill.check", ["skill", "check"], "read_only", "Validate skill mirrors.", ["skill", "check"]),
  coverageCommand("skill.sync", ["skill", "sync"], "mutation", "Regenerate skill mirrors.", ["skill", "sync"]),
  coverageCommand("skill.prefer", ["skill", "prefer"], "mutation", "Mark a skill preferred for an agent.", ["skill", "prefer"], ["skill", "prefer", "$skillId"], { required: ["skillId"] }),
  coverageCommand("skill.unprefer", ["skill", "unprefer"], "mutation", "Remove a skill preference.", ["skill", "unprefer"], ["skill", "unprefer", "$skillId"], { required: ["skillId"] }),
  coverageCommand("skill.block", ["skill", "block"], "mutation", "Block a skill for an agent.", ["skill", "block"], ["skill", "block", "$skillId"], { required: ["skillId"] }),
  coverageCommand("skill.unblock", ["skill", "unblock"], "mutation", "Unblock a skill for an agent.", ["skill", "unblock"], ["skill", "unblock", "$skillId"], { required: ["skillId"] }),
  coverageCommand("skill.select", ["skill", "select"], "read_only", "Explain deterministic skill selection.", ["skill", "select"]),
  coverageCommand("policy.group", ["policy"], "read_only", "Show policy command help.", ["policy", "help"]),
  coverageCommand("codex.group", ["codex"], "read_only", "Show Codex law command help.", ["codex", "help"]),
  coverageCommand("codex.amendment.group", ["codex", "amendment"], "read_only", "Show Codex amendment command help.", ["codex", "amendment", "help"]),
  coverageCommand("capability.group", ["capability"], "read_only", "Show capability command help.", ["capability", "help"]),
  coverageCommand("shell.group", ["shell"], "read_only", "Show shell approval command help.", ["shell", "help"])
];

export const runtimeCommandDefinitions: RuntimeCommandDefinition[] = [...runtimeCommandInputs, ...cliCoverageInputs].map(command);

export function retrieveRuntimeCommandCandidates(input: string, limit = 8, workspaceRoot?: string): RuntimeCommandDefinition[] {
  return retrieveRuntimeCommandCandidateMatches(input, limit, workspaceRoot)
    .map((item) => item.definition);
}

export function detectRuntimeCommandTags(input: string): string[] {
  const normalized = normalizeCommandText(input);
  if (!normalized) {
    return [];
  }
  const detected = new Set<string>();
  for (const definition of runtimeCommandDefinitions) {
    for (const tag of definition.tags ?? []) {
      if (inputContainsTag(normalized, tag)) {
        detected.add(tag);
      }
    }
  }
  return [...detected].sort((a, b) => a.localeCompare(b));
}

export function retrieveRuntimeCommandTagMatches(input: string, limit = 8): RuntimeCommandCandidateMatch[] {
  const normalized = normalizeCommandText(input);
  if (!normalized) {
    return [];
  }
  const detectedTags = detectRuntimeCommandTags(input);
  if (!detectedTags.length) {
    return [];
  }
  const detected = new Set(detectedTags.map(normalizeCommandText));
  return runtimeCommandDefinitions
    .map((definition) => {
      const matchedTags = (definition.tags ?? [])
        .filter((tag) => detected.has(normalizeCommandText(tag)));
      return {
        definition,
        matchedTags,
        score: matchedTags.length
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || safetySort(a.definition.safety) - safetySort(b.definition.safety) || a.definition.commandId.localeCompare(b.definition.commandId))
    .slice(0, limit)
    .map((item) => ({
      definition: item.definition,
      score: item.score,
      confidence: item.score >= 2 ? "high" : "medium",
      matchReason: `tag match: ${item.matchedTags.join(", ")}`
    }));
}

export function retrieveRuntimeCommandCandidateMatches(input: string, limit = 8, workspaceRoot?: string): RuntimeCommandCandidateMatch[] {
  const body = input.trim().replace(/^#/, "").trim();
  const normalized = normalizeCommandText(body);
  if (!normalized) {
    return [];
  }
  void workspaceRoot;
  const scored = runtimeCommandDefinitions
    .map((definition) => ({
      definition,
      ...scoreDefinition(normalized, definition)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.definition.commandId.localeCompare(b.definition.commandId));
  return scored.slice(0, limit).map((item) => ({
    definition: item.definition,
    score: item.score,
    matchReason: item.matchReason,
    confidence: item.score >= 10 ? "high" : item.score >= 4 ? "medium" : "low"
  }));
}

function inputContainsTag(normalizedInput: string, tag: string): boolean {
  const normalizedTag = normalizeCommandText(tag);
  if (!normalizedTag) {
    return false;
  }
  if (isAsciiWord(normalizedTag)) {
    return new RegExp(`\\b${escapeRegExp(normalizedTag)}\\b`, "i").test(normalizedInput);
  }
  return normalizedInput.includes(normalizedTag);
}

function safetySort(safety: RuntimeCommandSafety): number {
  switch (safety) {
    case "read_only": return 0;
    case "preview_mutation": return 1;
    case "mutation": return 2;
    case "system_boundary": return 3;
    case "dangerous": return 4;
  }
}

export function runtimeCommandDefinitionById(commandId: string): RuntimeCommandDefinition | undefined {
  return runtimeCommandDefinitions.find((definition) => definition.commandId === commandId);
}

export function validateRuntimeCommandArgs(commandId: string, args: Record<string, unknown>): RuntimeCommandResult | undefined {
  const definition = runtimeCommandDefinitionById(commandId);
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
    return needsInput(commandId, missing, runtimeCommandUsageHint(definition));
  }
  const allowedArgs = new Set([...(definition.argsSchema.required ?? []), ...(definition.argsSchema.optional ?? [])]);
  for (const key of Object.keys(args)) {
    if (!allowedArgs.has(key)) {
      return needsInput(commandId, [key], `Unknown argument for ${commandId}: ${key}. ${runtimeCommandUsageHint(definition)}`);
    }
  }
  for (const [key, values] of Object.entries(definition.argEnums ?? {})) {
    if (args[key] !== undefined && !values.includes(String(args[key]))) {
      return needsInput(commandId, [key], `${key} must be one of: ${values.join(", ")}.`);
    }
  }
  if (commandId === "tool.run" && !isToolId(String(args.toolId ?? ""))) {
    return needsInput(commandId, ["toolId"], "Tool must be a registered ToolCatalog id.");
  }
  return undefined;
}

export function runtimeCommandUsageHint(definition: RuntimeCommandDefinition): string {
  return `Try: ${definition.examples[0]}`;
}

function needsInput(commandId: string, missing: string[], hint: string): RuntimeCommandResult {
  return { type: "needs_input", commandId, missing, hint };
}

function normalizeCommandText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function scoreDefinition(normalized: string, definition: RuntimeCommandDefinition): { score: number; matchReason: string } {
  let score = 0;
  const reasons: string[] = [];
  if (normalized === normalizeCommandText(definition.commandId)) {
    score += 12;
    reasons.push("commandId exact match");
  } else if (normalizeCommandText(definition.commandId).includes(normalized) || normalized.includes(normalizeCommandText(definition.commandId))) {
    score += 4;
    reasons.push("commandId partial match");
  }
  for (const tag of definition.tags ?? []) {
    const normalizedTag = normalizeCommandText(tag);
    if (normalized === normalizedTag) {
      score += 8;
      reasons.push(`tag exact match: ${tag}`);
    } else if (normalized.includes(normalizedTag) || normalizedTag.includes(normalized)) {
      score += 3;
      reasons.push(`tag partial match: ${tag}`);
    }
  }
  const description = normalizeCommandText(definition.description);
  for (const token of normalized.split(/\s+/).filter((item) => item.length >= 2)) {
    if (description.includes(token)) {
      score += 1;
      reasons.push("description token match");
    }
  }
  return { score, matchReason: reasons[0] ?? "token match" };
}

function isAsciiWord(value: string): boolean {
  return /^[a-z0-9_-]+$/i.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
