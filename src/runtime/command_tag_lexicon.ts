export type CommandTagLocale = "ko" | "en";
export type CommandTagWeightName = "strong" | "medium" | "weak";

export type CommandTagAlias = {
  locale: CommandTagLocale;
  tag: string;
  aliases: string[];
  weight?: CommandTagWeightName;
};

export const commandTagWeightValue: Record<CommandTagWeightName, number> = {
  strong: 1,
  medium: 0.75,
  weak: 0.35
};

export const commandTagAliases: CommandTagAlias[] = [
  { locale: "ko", tag: "memory", aliases: ["메모리", "기억", "장기 메모리", "장기메모리"] },
  { locale: "ko", tag: "review", aliases: ["리뷰", "검토", "검토 대상", "승격 대상", "승격 후보"] },
  { locale: "ko", tag: "candidate", aliases: ["후보", "대상", "승격"] },
  { locale: "ko", tag: "auth", aliases: ["권한", "인증", "허용"] },
  { locale: "ko", tag: "gateway", aliases: ["게이트웨이", "게이트 웨이"] },
  { locale: "ko", tag: "version", aliases: ["버전"] },
  { locale: "ko", tag: "runtime", aliases: ["런타임"] },
  { locale: "ko", tag: "status", aliases: ["상태", "현황"] },
  { locale: "ko", tag: "status", aliases: ["살아", "살아있어", "켜져"], weight: "weak" },
  { locale: "ko", tag: "session", aliases: ["세션"] },
  { locale: "ko", tag: "list", aliases: ["목록", "리스트"] },
  { locale: "ko", tag: "provider", aliases: ["프로바이더", "모델"] },
  { locale: "ko", tag: "telegram", aliases: ["텔레그램"] },
  { locale: "ko", tag: "tool", aliases: ["도구", "툴"] },
  { locale: "ko", tag: "codex", aliases: ["법전", "코덱스"] },
  { locale: "ko", tag: "policy", aliases: ["정책"] },
  { locale: "ko", tag: "check", aliases: ["확인", "검사", "체크"] },
  { locale: "ko", tag: "search", aliases: ["검색", "찾아", "찾기"] },
  { locale: "ko", tag: "skill", aliases: ["스킬"] },
  { locale: "ko", tag: "job", aliases: ["작업", "잡"] },
  { locale: "ko", tag: "pending", aliases: ["대기", "보류"] },
  { locale: "ko", tag: "apply", aliases: ["적용"] },
  { locale: "ko", tag: "approve", aliases: ["승인"] },
  { locale: "ko", tag: "discard", aliases: ["폐기", "디스카드"] },
  { locale: "ko", tag: "cancel", aliases: ["취소"] },
  { locale: "ko", tag: "config", aliases: ["설정"] },
  { locale: "ko", tag: "doctor", aliases: ["진단"] },
  { locale: "ko", tag: "repair", aliases: ["복구"] },
  { locale: "ko", tag: "reset", aliases: ["초기화"] },
  { locale: "ko", tag: "audit", aliases: ["감사"] },
  { locale: "ko", tag: "amendment", aliases: ["개정"] },
  { locale: "ko", tag: "webhook", aliases: ["웹훅"] },
  { locale: "ko", tag: "capability", aliases: ["능력"] },

  { locale: "en", tag: "memory", aliases: ["memory", "memories", "long term memory", "long-term memory"] },
  { locale: "en", tag: "review", aliases: ["review", "review inbox"] },
  { locale: "en", tag: "candidate", aliases: ["candidate", "candidates", "promotion target"] },
  { locale: "en", tag: "auth", aliases: ["auth", "authorization", "permission", "permissions"] },
  { locale: "en", tag: "gateway", aliases: ["gateway"] },
  { locale: "en", tag: "version", aliases: ["version", "runtime version"] },
  { locale: "en", tag: "runtime", aliases: ["runtime"] },
  { locale: "en", tag: "status", aliases: ["status", "health", "alive", "running"] },
  { locale: "en", tag: "session", aliases: ["session", "sessions"] },
  { locale: "en", tag: "list", aliases: ["list", "show"] },
  { locale: "en", tag: "provider", aliases: ["provider", "model provider"] },
  { locale: "en", tag: "telegram", aliases: ["telegram"] },
  { locale: "en", tag: "tool", aliases: ["tool", "tools"] },
  { locale: "en", tag: "codex", aliases: ["codex", "law"] },
  { locale: "en", tag: "policy", aliases: ["policy"] },
  { locale: "en", tag: "check", aliases: ["check", "inspect", "verify"] },
  { locale: "en", tag: "search", aliases: ["search", "find"] },
  { locale: "en", tag: "skill", aliases: ["skill", "skills"] },
  { locale: "en", tag: "job", aliases: ["job", "jobs"] },
  { locale: "en", tag: "pending", aliases: ["pending", "waiting"] },
  { locale: "en", tag: "apply", aliases: ["apply"] },
  { locale: "en", tag: "approve", aliases: ["approve", "approval"] },
  { locale: "en", tag: "discard", aliases: ["discard"] },
  { locale: "en", tag: "cancel", aliases: ["cancel"] },
  { locale: "en", tag: "config", aliases: ["config", "configuration"] },
  { locale: "en", tag: "doctor", aliases: ["doctor", "diagnose"] },
  { locale: "en", tag: "repair", aliases: ["repair"] },
  { locale: "en", tag: "reset", aliases: ["reset"] },
  { locale: "en", tag: "audit", aliases: ["audit"] },
  { locale: "en", tag: "amendment", aliases: ["amendment"] },
  { locale: "en", tag: "webhook", aliases: ["webhook"] },
  { locale: "en", tag: "capability", aliases: ["capability"] }
];
