import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

export type RuntimeCommandResult =
  | { type: "matched"; commandId: string; confidence: "high" | "medium"; args: Record<string, unknown> }
  | { type: "needs_input"; commandId: string; missing: string[]; hint: string }
  | { type: "ambiguous"; candidates: string[]; hint: string }
  | { type: "no_match" };

export type RuntimeCommandDefinition = {
  commandId: string;
  cliDisplay: string;
  argvTemplate: string[];
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

type CommandInput = Omit<RuntimeCommandDefinition, "argsSchema" | "examples" | "triggers" | "surfaces" | "modelCallable" | "modelExecutionMode"> & {
  argsSchema?: RuntimeCommandDefinition["argsSchema"];
  argEnums?: RuntimeCommandDefinition["argEnums"];
  examples?: string[];
  triggers?: RuntimeCommandDefinition["triggers"];
  surfaces?: RuntimeCommandSurface[];
  modelCallable?: boolean;
  modelExecutionMode?: RuntimeCommandExecutionMode;
};

function command(input: CommandInput): RuntimeCommandDefinition {
  return {
    argsSchema: { optional: ["profileName"] },
    examples: [input.cliDisplay],
    triggers: { ko: [], en: [] },
    surfaces: ["cli"],
    modelCallable: false,
    modelExecutionMode: "blocked",
    ...input
  };
}

export const runtimeCommandDefinitions: RuntimeCommandDefinition[] = [
  {
    commandId: "gateway.status",
    cliDisplay: "cosia gateway status",
    argvTemplate: ["gateway", "status"],
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
    argvTemplate: ["status"],
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
    argvTemplate: ["review"],
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
    argvTemplate: ["review", "--memory"],
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
    argvTemplate: ["review", "--skill"],
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
    argvTemplate: ["review"],
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
    argvTemplate: ["memory", "candidate", "conflicts", "$candidateId"],
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
    argvTemplate: ["review", "stats"],
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
    argvTemplate: ["memory", "candidate", "promote", "$candidateId"],
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
    argvTemplate: ["memory", "candidate", "discard", "$target", "--reason", "$reason"],
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
    argvTemplate: ["review", "cleanup"],
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
    argvTemplate: ["skill", "candidate", "promote", "$target"],
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
    argvTemplate: ["review", "cleanup"],
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
    cliDisplay: "cosia memory search <query>",
    argvTemplate: ["memory", "search", "$query"],
    safety: "read_only",
    description: "Search active long-term memories.",
    ...readOnlyModelSurface,
    tags: ["memory", "메모리", "기억", "search", "검색"],
    modelHint: "Use when the user asks to search durable long-term memory.",
    argsSchema: { required: ["query"] },
    examples: ["cosia memory search \"required provider\""],
    triggers: {
      ko: ["메모리 검색", "기억 검색", "메모리 찾아줘"],
      en: ["memory search", "search memory", "search memories", "find memory"]
    }
  },
  {
    commandId: "session.list",
    cliDisplay: "cosia session list",
    argvTemplate: ["session", "list"],
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
    argvTemplate: ["session", "show", "$sessionId"],
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
    argvTemplate: ["session", "context", "status", "$sessionId"],
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
    argvTemplate: ["provider", "profile", "check", "$profileName?"],
    safety: "read_only",
    description: "Check the active provider and list configured providers.",
    ...readOnlyModelSurface,
    tags: ["provider", "프로바이더", "model", "모델", "auth", "인증", "상태"],
    modelHint: "Use when the user asks which provider is configured or whether provider auth is healthy.",
    argsSchema: {},
    examples: ["cosia provider profile check"],
    triggers: {
      ko: ["프로바이더", "provider 확인", "모델 확인"],
      en: ["provider", "check provider", "provider status", "model provider"]
    }
  },
  {
    commandId: "tool.run",
    cliDisplay: "cosia tool <tool-id> --args <json>",
    argvTemplate: ["tool", "$toolId", "--args", "$toolArgs?"],
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
    argvTemplate: ["shell", "preview", "--command", "$command", "--reason", "$reason"],
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
    argvTemplate: ["policy", "check"],
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
    argvTemplate: ["skill", "list"],
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
    argvTemplate: [],
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
    argvTemplate: [],
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
    argvTemplate: ["pending"],
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
    argvTemplate: ["tool", "grow", "review"],
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
    argvTemplate: ["tool", "grow", "show", "$routineId"],
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
  command({ commandId: "init", cliDisplay: "cosia init", argvTemplate: ["init"], safety: "system_boundary", description: "Initialize COSIA runtime files in the workspace.", tags: ["init", "초기화", "workspace", "setup"], requiresApproval: true }),
  command({ commandId: "start", cliDisplay: "cosia start", argvTemplate: ["start"], safety: "dangerous", description: "Start the normal interactive COSIA entrypoint.", tags: ["start", "시작", "chat", "run"] }),
  command({ commandId: "run", cliDisplay: "cosia run <prompt>", argvTemplate: ["run", "$prompt"], safety: "dangerous", description: "Run a prompt through COSIA from the CLI.", tags: ["run", "실행", "prompt"], argsSchema: { required: ["prompt"] } }),
  command({ commandId: "chat", cliDisplay: "cosia chat", argvTemplate: ["chat"], safety: "dangerous", description: "Start local interactive chat.", tags: ["chat", "대화", "interactive"] }),
  command({ commandId: "doctor.show", cliDisplay: "cosia doctor", argvTemplate: ["doctor"], safety: "read_only", description: "Show workspace doctor diagnostics.", ...readOnlyModelSurface, tags: ["doctor", "진단", "health", "repair"] }),
  command({ commandId: "doctor.repair", cliDisplay: "cosia doctor repair", argvTemplate: ["doctor", "repair"], safety: "mutation", description: "Run deterministic workspace repairs.", tags: ["doctor", "repair", "복구"], requiresApproval: true }),
  command({ commandId: "doctor.reset", cliDisplay: "cosia doctor reset [--state|--factory] --yes", argvTemplate: ["doctor", "reset"], safety: "system_boundary", description: "Preview or apply COSIA reset.", tags: ["doctor", "reset", "초기화"], requiresApproval: true }),
  command({ commandId: "pending.apply", cliDisplay: "cosia apply <id> --yes", argvTemplate: ["apply", "$id"], safety: "mutation", description: "Apply a durable pending approval by id.", tags: ["pending", "approval", "apply", "적용"], argsSchema: { required: ["id"] }, requiresApproval: true }),
  command({ commandId: "pending.cancel", cliDisplay: "cosia cancel <id> --reason <reason>", argvTemplate: ["cancel", "$id", "--reason", "$reason"], safety: "mutation", description: "Cancel a durable pending approval by id.", tags: ["pending", "approval", "cancel", "취소"], argsSchema: { required: ["id", "reason"] }, requiresApproval: true }),
  command({ commandId: "config.show", cliDisplay: "cosia config show", argvTemplate: ["config", "show"], safety: "read_only", description: "Show runtime configuration.", ...readOnlyModelSurface, tags: ["config", "설정", "runtime"] }),
  command({ commandId: "config.check", cliDisplay: "cosia config check", argvTemplate: ["config", "check"], safety: "read_only", description: "Check runtime configuration schema and repair hints.", ...readOnlyModelSurface, tags: ["config", "설정", "check", "검사"] }),
  command({ commandId: "config.migrate", cliDisplay: "cosia config migrate", argvTemplate: ["config", "migrate"], safety: "system_boundary", description: "Migrate runtime configuration.", tags: ["config", "migrate", "migration"], requiresApproval: true }),
  command({ commandId: "policy.show", cliDisplay: "cosia policy show", argvTemplate: ["policy", "show"], safety: "read_only", description: "Show policy configuration.", ...readOnlyModelSurface, tags: ["policy", "정책", "codex"] }),
  command({ commandId: "policy.sync", cliDisplay: "cosia policy sync", argvTemplate: ["policy", "sync"], safety: "system_boundary", description: "Sync generated policy Markdown mirror.", tags: ["policy", "sync", "mirror"], requiresApproval: true }),
  command({ commandId: "policy.audit", cliDisplay: "cosia policy audit", argvTemplate: ["policy", "audit"], safety: "read_only", description: "Show policy audit information.", ...readOnlyModelSurface, tags: ["policy", "audit", "감사"] }),
  command({ commandId: "codex.show", cliDisplay: "cosia codex show [--path <path>]", argvTemplate: ["codex", "show", "--path", "$path?"], safety: "read_only", description: "Show protected Codex law content.", ...readOnlyModelSurface, tags: ["codex", "법전", "law"], argsSchema: { optional: ["path"] } }),
  command({ commandId: "codex.check", cliDisplay: "cosia codex check", argvTemplate: ["codex", "check"], safety: "read_only", description: "Check protected Codex law files and pending amendments.", ...readOnlyModelSurface, tags: ["codex", "법전", "check", "검사"] }),
  command({ commandId: "codex.amendment.list", cliDisplay: "cosia codex amendment list", argvTemplate: ["codex", "amendment", "list"], safety: "read_only", description: "List Codex law amendments.", ...readOnlyModelSurface, tags: ["codex", "amendment", "개정", "pending"] }),
  command({ commandId: "codex.amendment.show", cliDisplay: "cosia codex amendment show <id>", argvTemplate: ["codex", "amendment", "show", "$id"], safety: "read_only", description: "Show one Codex law amendment.", ...readOnlyModelSurface, tags: ["codex", "amendment", "개정"], argsSchema: { required: ["id"] } }),
  command({ commandId: "codex.amendment.propose", cliDisplay: "cosia codex amendment propose --path <path> --content <text> --reason <reason>", argvTemplate: ["codex", "amendment", "propose", "--path", "$path", "--content", "$content", "--reason", "$reason"], safety: "system_boundary", description: "Propose a protected Codex law amendment.", tags: ["codex", "amendment", "개정", "propose"], argsSchema: { required: ["path", "content", "reason"] }, requiresApproval: true }),
  command({ commandId: "codex.amendment.apply", cliDisplay: "cosia codex amendment apply <id> --yes", argvTemplate: ["codex", "amendment", "apply", "$id"], safety: "system_boundary", description: "Apply a Codex law amendment.", tags: ["codex", "amendment", "apply", "적용"], argsSchema: { required: ["id"] }, requiresApproval: true }),
  command({ commandId: "codex.amendment.reject", cliDisplay: "cosia codex amendment reject <id> --reason <reason>", argvTemplate: ["codex", "amendment", "reject", "$id", "--reason", "$reason"], safety: "system_boundary", description: "Reject a Codex law amendment.", tags: ["codex", "amendment", "reject"], argsSchema: { required: ["id", "reason"] }, requiresApproval: true }),
  command({ commandId: "codex.amendment.cancel", cliDisplay: "cosia codex amendment cancel <id> --reason <reason>", argvTemplate: ["codex", "amendment", "cancel", "$id", "--reason", "$reason"], safety: "system_boundary", description: "Cancel a Codex law amendment.", tags: ["codex", "amendment", "cancel"], argsSchema: { required: ["id", "reason"] }, requiresApproval: true }),
  command({ commandId: "provider.list_supported", cliDisplay: "cosia provider list-supported", argvTemplate: ["provider", "list-supported"], safety: "read_only", description: "List supported provider setup paths.", ...readOnlyModelSurface, tags: ["provider", "프로바이더", "지원", "setup"] }),
  command({ commandId: "provider.setup", cliDisplay: "cosia provider setup", argvTemplate: ["provider", "setup"], safety: "system_boundary", description: "Guided provider profile setup.", tags: ["provider", "setup", "profile", "프로바이더"], requiresApproval: true }),
  command({ commandId: "provider.list", cliDisplay: "cosia provider list", argvTemplate: ["provider", "list"], safety: "read_only", description: "List configured model provider records.", ...readOnlyModelSurface, tags: ["provider", "프로바이더", "list", "목록"] }),
  command({ commandId: "provider.profile.add", cliDisplay: "cosia provider profile add <name> --provider <provider>", argvTemplate: ["provider", "profile", "add", "$name", "--provider", "$provider"], safety: "system_boundary", description: "Add a provider profile.", tags: ["provider", "profile", "add", "프로바이더"], argsSchema: { required: ["name", "provider"] }, requiresApproval: true }),
  command({ commandId: "provider.profile.use", cliDisplay: "cosia provider profile use <name>", argvTemplate: ["provider", "profile", "use", "$name"], safety: "system_boundary", description: "Select the active provider profile.", tags: ["provider", "profile", "use", "active"], argsSchema: { required: ["name"] }, requiresApproval: true }),
  command({ commandId: "provider.profile.list", cliDisplay: "cosia provider profile list", argvTemplate: ["provider", "profile", "list"], safety: "read_only", description: "List provider profiles.", ...readOnlyModelSurface, tags: ["provider", "profile", "list", "프로바이더"] }),
  command({ commandId: "provider.profile.show", cliDisplay: "cosia provider profile show <name>", argvTemplate: ["provider", "profile", "show", "$name"], safety: "read_only", description: "Show a provider profile without secrets.", ...readOnlyModelSurface, tags: ["provider", "profile", "show"], argsSchema: { required: ["name"] } }),
  command({ commandId: "provider.profile.check", cliDisplay: "cosia provider profile check [name]", argvTemplate: ["provider", "profile", "check", "$name?"], safety: "read_only", description: "Check active or named provider profile auth status.", ...readOnlyModelSurface, tags: ["provider", "프로바이더", "profile", "check", "상태", "auth"], argsSchema: { optional: ["name"] } }),
  command({ commandId: "provider.profile.remove", cliDisplay: "cosia provider profile remove <name>", argvTemplate: ["provider", "profile", "remove", "$name"], safety: "system_boundary", description: "Remove a provider profile.", tags: ["provider", "profile", "remove"], argsSchema: { required: ["name"] }, requiresApproval: true }),
  command({ commandId: "provider.oauth.login", cliDisplay: "cosia provider oauth login <profile-name>", argvTemplate: ["provider", "oauth", "login", "$profileName"], safety: "system_boundary", description: "Run provider OAuth login flow.", tags: ["provider", "oauth", "login"], argsSchema: { required: ["profileName"] }, requiresApproval: true }),
  command({ commandId: "gateway.start", cliDisplay: "cosia gateway start", argvTemplate: ["gateway", "start"], safety: "dangerous", description: "Start gateway process.", tags: ["gateway", "start"] }),
  command({ commandId: "gateway.stop", cliDisplay: "cosia gateway stop", argvTemplate: ["gateway", "stop"], safety: "mutation", description: "Stop gateway process.", tags: ["gateway", "stop"], requiresApproval: true }),
  command({ commandId: "gateway.restart", cliDisplay: "cosia gateway restart", argvTemplate: ["gateway", "restart"], safety: "mutation", description: "Restart gateway process.", tags: ["gateway", "restart"], requiresApproval: true }),
  command({ commandId: "gateway.unlock", cliDisplay: "cosia gateway unlock --stale-only", argvTemplate: ["gateway", "unlock"], safety: "mutation", description: "Remove stale gateway process lock.", tags: ["gateway", "unlock", "stale"], requiresApproval: true }),
  command({ commandId: "gateway.auth.allow_chat", cliDisplay: "cosia gateway auth allow-chat <connector> <chat-id>", argvTemplate: ["gateway", "auth", "allow-chat", "$connector", "$chatId"], safety: "system_boundary", description: "Allow an external connector chat.", tags: ["gateway", "auth", "권한", "chat", "채팅"], argsSchema: { required: ["connector", "chatId"] }, requiresApproval: true }),
  command({ commandId: "gateway.auth.remove_chat", cliDisplay: "cosia gateway auth remove-chat <connector> <chat-id>", argvTemplate: ["gateway", "auth", "remove-chat", "$connector", "$chatId"], safety: "system_boundary", description: "Remove an allowed external connector chat.", tags: ["gateway", "auth", "remove", "chat"], argsSchema: { required: ["connector", "chatId"] }, requiresApproval: true }),
  command({ commandId: "gateway.auth.set_master", cliDisplay: "cosia gateway auth set-master <connector> <user-id>", argvTemplate: ["gateway", "auth", "set-master", "$connector", "$userId"], safety: "system_boundary", description: "Set the single global Gateway master user.", tags: ["gateway", "auth", "master", "마스터", "권한"], argsSchema: { required: ["connector", "userId"] }, requiresApproval: true }),
  command({ commandId: "gateway.auth.clear_master", cliDisplay: "cosia gateway auth clear-master", argvTemplate: ["gateway", "auth", "clear-master"], safety: "system_boundary", description: "Clear the Gateway master user.", tags: ["gateway", "auth", "master"], requiresApproval: true }),
  command({ commandId: "gateway.auth.set_role", cliDisplay: "cosia gateway auth set-role <connector> <user-id> <guest|admin> --chat-id <chat-id>", argvTemplate: ["gateway", "auth", "set-role", "$connector", "$userId", "$role", "--chat-id", "$chatId"], safety: "system_boundary", description: "Set a chat-scoped Gateway guest/admin role.", tags: ["gateway", "auth", "role", "권한"], argsSchema: { required: ["connector", "userId", "role", "chatId"] }, argEnums: { role: ["guest", "admin"] }, requiresApproval: true }),
  command({ commandId: "gateway.auth.unset_role", cliDisplay: "cosia gateway auth unset-role <connector> <user-id> --chat-id <chat-id>", argvTemplate: ["gateway", "auth", "unset-role", "$connector", "$userId", "--chat-id", "$chatId"], safety: "system_boundary", description: "Unset a chat-scoped Gateway role.", tags: ["gateway", "auth", "role"], argsSchema: { required: ["connector", "userId", "chatId"] }, requiresApproval: true }),
  command({ commandId: "gateway.auth.list", cliDisplay: "cosia gateway auth list", argvTemplate: ["gateway", "auth", "list"], safety: "read_only", description: "List Gateway authorization summary.", ...readOnlyModelSurface, tags: ["gateway", "auth", "권한", "list", "목록"] }),
  command({ commandId: "gateway.auth.check", cliDisplay: "cosia gateway auth check <connector> --chat-id <id> --user-id <id>", argvTemplate: ["gateway", "auth", "check", "$connector", "--chat-id", "$chatId", "--user-id", "$userId"], safety: "read_only", description: "Check Gateway authorization for one actor.", ...readOnlyModelSurface, tags: ["gateway", "auth", "권한", "check"], argsSchema: { required: ["connector", "chatId", "userId"] } }),
  command({ commandId: "gateway.telegram.enable", cliDisplay: "cosia gateway telegram enable", argvTemplate: ["gateway", "telegram", "enable"], safety: "system_boundary", description: "Enable Telegram connector.", tags: ["gateway", "telegram", "텔레그램", "enable"], requiresApproval: true }),
  command({ commandId: "gateway.telegram.disable", cliDisplay: "cosia gateway telegram disable", argvTemplate: ["gateway", "telegram", "disable"], safety: "system_boundary", description: "Disable Telegram connector.", tags: ["gateway", "telegram", "텔레그램", "disable"], requiresApproval: true }),
  command({ commandId: "gateway.telegram.set", cliDisplay: "cosia gateway telegram set <field> <value>", argvTemplate: ["gateway", "telegram", "set", "$field", "$value?"], safety: "system_boundary", description: "Set Telegram connector field.", tags: ["gateway", "telegram", "텔레그램", "set"], argsSchema: { required: ["field"], optional: ["value"] }, requiresApproval: true }),
  command({ commandId: "gateway.telegram.unset", cliDisplay: "cosia gateway telegram unset <field> <value>", argvTemplate: ["gateway", "telegram", "unset", "$field", "$value?"], safety: "system_boundary", description: "Unset Telegram connector field.", tags: ["gateway", "telegram", "텔레그램", "unset"], argsSchema: { required: ["field"], optional: ["value"] }, requiresApproval: true }),
  command({ commandId: "gateway.telegram.list", cliDisplay: "cosia gateway telegram list", argvTemplate: ["gateway", "telegram", "list"], safety: "read_only", description: "List Telegram connector settings without secrets.", ...readOnlyModelSurface, tags: ["gateway", "telegram", "텔레그램", "list"] }),
  command({ commandId: "gateway.telegram.check", cliDisplay: "cosia gateway telegram check", argvTemplate: ["gateway", "telegram", "check"], safety: "read_only", description: "Check Telegram connector configuration.", ...readOnlyModelSurface, tags: ["gateway", "telegram", "텔레그램", "check"] }),
  command({ commandId: "gateway.telegram.state", cliDisplay: "cosia gateway telegram state", argvTemplate: ["gateway", "telegram", "state"], safety: "read_only", description: "Show Telegram connector state.", ...readOnlyModelSurface, tags: ["gateway", "telegram", "state"] }),
  command({ commandId: "gateway.telegram.repair", cliDisplay: "cosia gateway telegram repair --stale-sessions", argvTemplate: ["gateway", "telegram", "repair"], safety: "mutation", description: "Repair Telegram connector state.", tags: ["gateway", "telegram", "repair"], requiresApproval: true }),
  command({ commandId: "gateway.telegram.reset_state", cliDisplay: "cosia gateway telegram reset-state --yes", argvTemplate: ["gateway", "telegram", "reset-state"], safety: "mutation", description: "Reset Telegram connector state.", tags: ["gateway", "telegram", "reset"], requiresApproval: true }),
  command({ commandId: "capability.review", cliDisplay: "cosia capability review", argvTemplate: ["capability", "review"], safety: "read_only", description: "Review capability proposals.", ...readOnlyModelSurface, tags: ["capability", "능력", "proposal", "review"] }),
  command({ commandId: "capability.scan", cliDisplay: "cosia capability scan --request <text>", argvTemplate: ["capability", "scan", "--request", "$request?"], safety: "read_only", description: "Scan workspace capability facts.", ...readOnlyModelSurface, tags: ["capability", "scan", "능력"], argsSchema: { optional: ["request"] } }),
  command({ commandId: "capability.facts", cliDisplay: "cosia capability facts", argvTemplate: ["capability", "facts"], safety: "read_only", description: "Show capability facts.", ...readOnlyModelSurface, tags: ["capability", "facts", "능력"] }),
  command({ commandId: "capability.plan", cliDisplay: "cosia capability plan --request <text>", argvTemplate: ["capability", "plan", "--request", "$request"], safety: "preview_mutation", description: "Create a capability proposal from a request.", tags: ["capability", "plan", "proposal"], argsSchema: { required: ["request"] }, requiresApproval: true }),
  command({ commandId: "capability.show", cliDisplay: "cosia capability show <id>", argvTemplate: ["capability", "show", "$id"], safety: "read_only", description: "Show a capability proposal.", ...readOnlyModelSurface, tags: ["capability", "show"], argsSchema: { required: ["id"] } }),
  command({ commandId: "capability.discard", cliDisplay: "cosia capability discard <id> --reason <reason>", argvTemplate: ["capability", "discard", "$id", "--reason", "$reason"], safety: "mutation", description: "Discard a capability proposal.", tags: ["capability", "discard"], argsSchema: { required: ["id", "reason"] }, requiresApproval: true }),
  command({ commandId: "shell.status", cliDisplay: "cosia shell status", argvTemplate: ["shell", "status"], safety: "read_only", description: "List shell approvals.", ...readOnlyModelSurface, tags: ["shell", "approval", "status"] }),
  command({ commandId: "shell.apply", cliDisplay: "cosia shell apply <approval-id> --confirm <phrase>", argvTemplate: ["shell", "apply", "$approvalId"], safety: "dangerous", description: "Apply a shell approval.", tags: ["shell", "apply"], argsSchema: { required: ["approvalId"] }, requiresApproval: true }),
  command({ commandId: "shell.run", cliDisplay: "cosia shell run --command <command> --yes", argvTemplate: ["shell", "run", "--command", "$command"], safety: "dangerous", description: "Preview or run a shell command.", tags: ["shell", "run"], argsSchema: { required: ["command"] }, requiresApproval: true }),
  command({ commandId: "shell.cancel", cliDisplay: "cosia shell cancel <approval-id>", argvTemplate: ["shell", "cancel", "$approvalId"], safety: "mutation", description: "Cancel shell approval.", tags: ["shell", "cancel"], argsSchema: { required: ["approvalId"] }, requiresApproval: true }),
  command({ commandId: "tool.list", cliDisplay: "cosia tool list", argvTemplate: ["tool", "list"], safety: "read_only", description: "List tool catalog and active tools.", ...readOnlyModelSurface, tags: ["tool", "도구", "list"] }),
  command({ commandId: "tool.draft", cliDisplay: "cosia tool draft --from-capability <id>", argvTemplate: ["tool", "draft", "--from-capability", "$capabilityId"], safety: "preview_mutation", description: "Create a tool draft from a capability proposal.", tags: ["tool", "draft", "도구"], argsSchema: { required: ["capabilityId"] }, requiresApproval: true }),
  command({ commandId: "tool.grow.start", cliDisplay: "cosia tool grow --request <text>", argvTemplate: ["tool", "grow", "--request", "$request"], safety: "preview_mutation", description: "Start a guided tool growth routine.", tags: ["tool-growth", "tool", "도구", "grow"], argsSchema: { required: ["request"] }, requiresApproval: true }),
  command({ commandId: "tool.grow.review", cliDisplay: "cosia tool grow review", argvTemplate: ["tool", "grow", "review"], safety: "read_only", description: "Review tool growth routines.", ...readOnlyModelSurface, tags: ["tool-growth", "tool", "도구", "review"] }),
  command({ commandId: "tool.grow.show", cliDisplay: "cosia tool grow show <routine-id>", argvTemplate: ["tool", "grow", "show", "$routineId"], safety: "read_only", description: "Show one tool growth routine.", ...readOnlyModelSurface, tags: ["tool-growth", "tool", "도구", "show"], argsSchema: { required: ["routineId"] } }),
  command({ commandId: "tool.grow.test", cliDisplay: "cosia tool grow test <routine-id> --yes", argvTemplate: ["tool", "grow", "test", "$routineId"], safety: "mutation", description: "Run a tool growth candidate test.", tags: ["tool-growth", "test", "도구"], argsSchema: { required: ["routineId"] }, requiresApproval: true }),
  command({ commandId: "tool.grow.activate", cliDisplay: "cosia tool grow activate <routine-id> --agent <agent-id> --yes", argvTemplate: ["tool", "grow", "activate", "$routineId", "--agent", "$agentId"], safety: "mutation", description: "Activate a grown tool through existing activation gates.", tags: ["tool-growth", "activate", "도구"], argsSchema: { required: ["routineId", "agentId"] }, requiresApproval: true }),
  command({ commandId: "tool.candidate.review", cliDisplay: "cosia tool candidate review", argvTemplate: ["tool", "candidate", "review"], safety: "read_only", description: "Review tool candidates.", ...readOnlyModelSurface, tags: ["tool", "candidate", "도구", "review"] }),
  command({ commandId: "tool.candidate.show", cliDisplay: "cosia tool candidate show <candidate-id>", argvTemplate: ["tool", "candidate", "show", "$candidateId"], safety: "read_only", description: "Show a tool candidate.", ...readOnlyModelSurface, tags: ["tool", "candidate", "show"], argsSchema: { required: ["candidateId"] } }),
  command({ commandId: "tool.candidate.approve", cliDisplay: "cosia tool candidate approve <candidate-id>", argvTemplate: ["tool", "candidate", "approve", "$candidateId"], safety: "mutation", description: "Approve a tool candidate design.", tags: ["tool", "candidate", "approve"], argsSchema: { required: ["candidateId"] }, requiresApproval: true }),
  command({ commandId: "tool.candidate.test", cliDisplay: "cosia tool candidate test <candidate-id>", argvTemplate: ["tool", "candidate", "test", "$candidateId"], safety: "mutation", description: "Test a tool candidate.", tags: ["tool", "candidate", "test"], argsSchema: { required: ["candidateId"] }, requiresApproval: true }),
  command({ commandId: "tool.active.list", cliDisplay: "cosia tool active list", argvTemplate: ["tool", "active", "list"], safety: "read_only", description: "List active tools.", ...readOnlyModelSurface, tags: ["tool", "active", "도구"] }),
  command({ commandId: "tool.active.show", cliDisplay: "cosia tool active show <tool-id>", argvTemplate: ["tool", "active", "show", "$toolId"], safety: "read_only", description: "Show an active tool.", ...readOnlyModelSurface, tags: ["tool", "active", "show"], argsSchema: { required: ["toolId"] } }),
  command({ commandId: "tool.activate", cliDisplay: "cosia tool activate <candidate-id> --agent <agent-id> --yes", argvTemplate: ["tool", "activate", "$candidateId", "--agent", "$agentId"], safety: "mutation", description: "Activate a tool candidate.", tags: ["tool", "activate"], argsSchema: { required: ["candidateId", "agentId"] }, requiresApproval: true }),
  command({ commandId: "tool.deactivate", cliDisplay: "cosia tool deactivate <tool-id> --reason <reason>", argvTemplate: ["tool", "deactivate", "$toolId", "--reason", "$reason"], safety: "mutation", description: "Deactivate an active tool.", tags: ["tool", "deactivate"], argsSchema: { required: ["toolId", "reason"] }, requiresApproval: true }),
  command({ commandId: "tool.blueprint.list", cliDisplay: "cosia tool blueprint list", argvTemplate: ["tool", "blueprint", "list"], safety: "read_only", description: "List learned local tool blueprints.", ...readOnlyModelSurface, tags: ["tool", "blueprint", "도구"] }),
  command({ commandId: "tool.blueprint.show", cliDisplay: "cosia tool blueprint show <blueprint-id>", argvTemplate: ["tool", "blueprint", "show", "$blueprintId"], safety: "read_only", description: "Show a learned local blueprint.", ...readOnlyModelSurface, tags: ["tool", "blueprint"], argsSchema: { required: ["blueprintId"] } }),
  command({ commandId: "tool.blueprint.create_from_active", cliDisplay: "cosia tool blueprint create-from-active <tool-id> --yes", argvTemplate: ["tool", "blueprint", "create-from-active", "$toolId"], safety: "mutation", description: "Create learned blueprint from active tool.", tags: ["tool", "blueprint", "create"], argsSchema: { required: ["toolId"] }, requiresApproval: true })
];

export function parseRuntimeHashCommand(input: string): RuntimeCommandResult {
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
      return needsInput("review.discard", ["reason"], "Try: /review discard <id-prefix> --reason \"duplicate\"");
    }
    return matched("review.discard", { target, reason });
  }

  const discardConflicts = body.match(/^(?:컨플릭트|충돌)\s*메모리\s*(?:전부|모두|전체)?\s*디스카드(?:해|해줘|진행)?(?:\s*(?:이유|사유|reason)는?\s+(.+))?$/i);
  if (discardConflicts) {
    const reason = discardConflicts[1]?.trim();
    if (!reason) {
      return needsInput("review.discard_conflicts", ["reason"], "Try: /review discard-conflicts --reason \"duplicate\"");
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

  const shellPreviewKo = body.match(/^쉘로\s+(.+?)\s*(?:실행\s*)?(?:제안해|제안|프리뷰|preview)(?:\s*(?:이유|사유|reason)는?\s+(.+))?$/i);
  if (shellPreviewKo) {
    return matched("shell.preview", {
      command: shellPreviewKo[1].trim(),
      reason: shellPreviewKo[2]?.trim() ?? "User requested a shell execution preview."
    });
  }
  const shellPreviewEn = body.match(/^(?:suggest|propose)\s+shell\s+(.+?)(?:\s+(?:because|reason(?:\s+is)?|for)\s+(.+))?$/i);
  if (shellPreviewEn) {
    return matched("shell.preview", {
      command: shellPreviewEn[1].trim(),
      reason: shellPreviewEn[2]?.trim() ?? "User requested a shell execution preview."
    });
  }

  const englishDiscardConflicts = body.match(/^discard\s+(?:all\s+)?(?:conflicting|conflict|duplicate)\s+memor(?:y|ies)(?:\s+(?:because|reason(?:\s+is)?|for)\s+(.+))?$/i);
  if (englishDiscardConflicts) {
    const reason = englishDiscardConflicts[1]?.trim();
    if (!reason) {
      return needsInput("review.discard_conflicts", ["reason"], "Try: /review discard-conflicts --reason \"duplicate\"");
    }
    return matched("review.discard_conflicts", { reason });
  }

  if (/^(리뷰|리뷰\s*(보여줘|목록|확인)|전체\s*리뷰\s*(보여줘|목록|확인))$/.test(normalized)) {
    return matched("review.list", { filter: "all" });
  }
  if (/^리뷰\s*(통계|상태)\s*(보여줘|확인|조회)?$/.test(normalized)) {
    return matched("review.stats");
  }
  if (/^(review stats|show review stats|review statistics)$/.test(normalized)) {
    return matched("review.stats");
  }
  if (/^(리뷰|후보|디스카드)\s*정리(해|해줘|진행)?$/.test(normalized)) {
    return matched("review.cleanup");
  }
  if (/^(cleanup review|review cleanup|cleanup review queue)$/.test(normalized)) {
    return matched("review.cleanup");
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

  if (/^게이트웨이\s*(상태|살아\s*있|켜져|실행\s*중|동작\s*중).*$/.test(normalized) || /^(gateway status|show gateway status|check gateway status|gateway running|gateway alive)$/.test(normalized)) {
    return matched("gateway.status");
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
      hint: "Try /review or /review discard-conflicts --reason \"<reason>\"."
    };
  }

  return { type: "no_match" };
}

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
  const triggerOverrides = workspaceRoot ? readTriggerOverrides(workspaceRoot, "ko") : {};
  const scored = runtimeCommandDefinitions
    .map((definition) => ({
      definition,
      ...scoreDefinition(normalized, definition, triggerOverrides[definition.commandId])
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

function matched(commandId: string, args: Record<string, unknown> = {}): RuntimeCommandResult {
  return { type: "matched", commandId, confidence: "high", args };
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

function scoreDefinition(normalized: string, definition: RuntimeCommandDefinition, koOverride?: string[]): { score: number; matchReason: string } {
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
  const koTriggers = [...new Set([...(koOverride ?? []), ...definition.triggers.ko])];
  for (const trigger of [...koTriggers, ...definition.triggers.en]) {
    const normalizedTrigger = normalizeCommandText(trigger);
    if (!normalizedTrigger) {
      continue;
    }
    if (normalized === normalizedTrigger) {
      score += 10;
      reasons.push(`trigger exact match: ${trigger}`);
      continue;
    }
    if (normalized.includes(normalizedTrigger)) {
      score += normalizedTrigger.includes(" ") ? 5 : 2;
      reasons.push(`trigger contained match: ${trigger}`);
      continue;
    }
    if (isAsciiWord(normalizedTrigger) && new RegExp(`\\b${escapeRegExp(normalizedTrigger)}\\b`, "i").test(normalized)) {
      score += 2;
      reasons.push(`trigger word match: ${trigger}`);
    }
  }
  return { score, matchReason: reasons[0] ?? "token match" };
}

function readTriggerOverrides(workspaceRoot: string, locale: string): Record<string, string[]> {
  const path = join(workspaceRoot, "config", `command_triggers.${locale}.json`);
  if (!existsSync(path)) {
    return {};
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") {
      return {};
    }
    const pack: Record<string, string[]> = {};
    for (const [commandId, value] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        pack[commandId] = value.filter((item): item is string => typeof item === "string");
      }
    }
    return pack;
  } catch {
    return {};
  }
}

function isAsciiWord(value: string): boolean {
  return /^[a-z0-9_-]+$/i.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
