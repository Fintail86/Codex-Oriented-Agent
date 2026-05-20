import type { MemoryCandidateRecord, RiskLevel } from "./types.js";

export type SecretDetection = {
  matched: boolean;
  reasons: string[];
  redactedPreview: string;
};

export type RiskClassification = {
  riskLevel: RiskLevel;
  reasons: string[];
  autoPromotable: boolean;
  secretDetection?: SecretDetection;
};

const highRiskKinds = new Set(["security", "policy", "credential", "secret"]);
const mediumRiskKinds = new Set(["decision", "preference", "architecture"]);
const lowRiskKinds = new Set(["note", "observation", "command"]);
const highRiskCoreKinds = new Set(["policy", "security", "credential", "secret"]);

const secretPatterns: Array<{ reason: string; pattern: RegExp }> = [
  { reason: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { reason: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { reason: "jwt-token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { reason: "assignment:password", pattern: /\bpassword\s*[:=]\s*["']?[^"'\s]{4,}/gi },
  { reason: "assignment:token", pattern: /\btoken\s*[:=]\s*["']?[^"'\s]{4,}/gi },
  { reason: "assignment:api-key", pattern: /\bapi[_ -]?key\s*[:=]\s*["']?[^"'\s]{4,}/gi },
  { reason: "assignment:secret", pattern: /\bsecret\s*[:=]\s*["']?[^"'\s]{4,}/gi },
  { reason: "assignment:private-key", pattern: /\bprivate[_ -]?key\s*[:=]\s*["']?[^"'\s]{4,}/gi },
  { reason: "bearer-token", pattern: /\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+/-]+=*/gi },
  { reason: "pem-private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g },
  { reason: "keyword:token", pattern: /\btoken\b/gi },
  { reason: "keyword:credential", pattern: /\bcredential(?:s)?\b/gi },
  { reason: "keyword:password", pattern: /\bpassword\b/gi },
  { reason: "keyword:secret", pattern: /\bsecret\b/gi },
  { reason: "keyword:api-key", pattern: /\bapi\s*key\b/gi }
];

export function classifyMemoryCandidate(candidate: MemoryCandidateRecord, hasConflicts: boolean): RiskClassification {
  const reasons: string[] = [];
  const secretDetection = detectSecrets(candidate.content);

  if (candidate.tier === "core" && highRiskCoreKinds.has(candidate.kind.toLowerCase())) {
    reasons.push(`tier:core:${candidate.kind}`);
  }
  if (highRiskKinds.has(candidate.kind.toLowerCase())) {
    reasons.push(`kind:${candidate.kind}`);
  }
  if (secretDetection.matched) {
    reasons.push(...secretDetection.reasons.map((reason) => `secret:${reason}`));
  }
  if (mentionsConstitutionalLayer(candidate.content)) {
    reasons.push("content:codex-policy-security");
  }

  if (reasons.length) {
    return {
      riskLevel: "high",
      reasons,
      autoPromotable: false,
      secretDetection
    };
  }

  if (candidate.tier === "core" || candidate.tier === "agent" || mediumRiskKinds.has(candidate.kind.toLowerCase()) || mentionsArchitecture(candidate.content)) {
    return {
      riskLevel: "medium",
      reasons: [`tier:${candidate.tier}`, `kind:${candidate.kind}`],
      autoPromotable: !hasConflicts,
      secretDetection
    };
  }

  const lowRisk = candidate.tier === "session" && lowRiskKinds.has(candidate.kind.toLowerCase());
  return {
    riskLevel: lowRisk ? "low" : "medium",
    reasons: [`tier:${candidate.tier}`, `kind:${candidate.kind}`],
    autoPromotable: lowRisk && !hasConflicts,
    secretDetection
  };
}

export function detectSecrets(content: string): SecretDetection {
  const reasons: string[] = [];
  let redacted = content;
  for (const { reason, pattern } of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) {
      reasons.push(reason);
      pattern.lastIndex = 0;
      redacted = redacted.replace(pattern, "[REDACTED]");
    }
  }
  return {
    matched: reasons.length > 0,
    reasons: [...new Set(reasons)],
    redactedPreview: preview(redacted)
  };
}

export function redactedCandidatePreview(candidate: MemoryCandidateRecord, classification: RiskClassification): string {
  return classification.secretDetection?.matched
    ? classification.secretDetection.redactedPreview
    : preview(candidate.content);
}

function mentionsConstitutionalLayer(content: string): boolean {
  return /\b(codex|policy|security|permission|credential|token|secret)\b/i.test(content);
}

function mentionsArchitecture(content: string): boolean {
  return /\b(architecture|design|decision|runtime|policy|structure|workflow)\b/i.test(content);
}

function preview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}
