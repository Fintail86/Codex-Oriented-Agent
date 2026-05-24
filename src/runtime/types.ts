import { z } from "zod";

export const memoryScopeSchema = z.enum([
  "global",
  "user",
  "codex",
  "agent",
  "project",
  "session",
  "task",
  "tool"
]);

export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const memoryTierSchema = z.enum([
  "core",
  "agent",
  "session"
]);

export type MemoryTier = z.infer<typeof memoryTierSchema>;

export const toolPermissionSchema = z.enum([
  "read_only",
  "write_local",
  "project_check",
  "shell_request",
  "destructive",
  "network",
  "external_send",
  "shell"
]);

export type ToolPermission = z.infer<typeof toolPermissionSchema>;

export const toolNameSchema = z.string().min(1);
export type ToolName = z.infer<typeof toolNameSchema>;

export const agentIdentitySchema = z.object({
  role: z.string().min(1).default("General COSIA agent"),
  voice: z.string().min(1).default("Direct, practical, and precise."),
  operatingStyle: z.array(z.string().min(1)).default([]),
  priorities: z.array(z.string().min(1)).default([]),
  boundaries: z.array(z.string().min(1)).default([])
});

export type AgentIdentity = z.infer<typeof agentIdentitySchema>;

export const agentManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  identity: agentIdentitySchema.default({
    role: "General COSIA agent",
    voice: "Direct, practical, and precise.",
    operatingStyle: [],
    priorities: [],
    boundaries: []
  }),
  selectionTriggers: z.array(z.string().min(1)).default([]),
  allowedTools: z.array(toolNameSchema),
  preferredSkills: z.array(z.string()).default([]),
  blockedSkills: z.array(z.string()).default([]),
  skillWeights: z.record(z.string(), z.number().min(0).max(5)).default({}),
  // Legacy v0.9 agent-local skill fields. They are still accepted so old
  // workspaces can be inspected and migrated into the global skill toolbox.
  skills: z.array(z.string()).default([]),
  skillTriggers: z.record(z.string(), z.array(z.string())).default({}),
  memoryScopes: z.array(memoryScopeSchema)
});

export type AgentManifest = z.infer<typeof agentManifestSchema>;

export const sessionMetadataSchema = z.object({
  id: z.string().min(1),
  assignedAgentId: z.string().min(1).nullable().optional(),
  agentId: z.string().min(1).optional(),
  status: z.enum(["active", "completed", "archived"]),
  goal: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
}).transform((session) => ({
  id: session.id,
  assignedAgentId: session.assignedAgentId ?? session.agentId ?? null,
  status: session.status,
  goal: session.goal,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt
}));

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

export type AuthStatus = {
  ok: boolean;
  message: string;
  reason?: ProviderFailureReason;
  hint?: string;
};

export type ProviderFailureReason =
  | "cli_missing"
  | "auth_failed"
  | "disabled"
  | "missing_config"
  | "missing_api_key"
  | "timeout"
  | "network_error"
  | "http_error"
  | "rate_limited"
  | "malformed_response"
  | "malformed_agent_step"
  | "unknown_provider";

export type ModelInput = {
  prompt: string;
  sessionId: string;
  retryInstruction?: string;
};

const nullableOptional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => value === null ? undefined : value, schema.optional());

export const memoryCandidateSchema = z.object({
  tier: nullableOptional(memoryTierSchema),
  scope: nullableOptional(memoryScopeSchema),
  legacyScope: nullableOptional(memoryScopeSchema),
  ownerId: nullableOptional(z.string()),
  kind: z.string().min(1),
  content: z.string().min(1),
  importance: z.number().int().min(1).max(5),
  confidence: z.number().min(0).max(1)
});

export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;

export const riskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

export const memoryCandidateStatusSchema = z.enum(["pending", "promoted", "discarded", "auto_promoted", "reverted"]);
export type MemoryCandidateStatus = z.infer<typeof memoryCandidateStatusSchema>;

export const memoryCandidateRecordSchema = memoryCandidateSchema.extend({
  id: z.string().min(1),
  status: memoryCandidateStatusSchema,
  tier: memoryTierSchema,
  scope: memoryScopeSchema,
  sourceSessionId: z.string().min(1),
  sourceAgentId: z.string().min(1),
  runId: z.string().optional(),
  createdAt: z.string().min(1),
  reviewedAt: z.string().optional(),
  promotedMemoryId: z.string().optional(),
  autoPromotionId: z.string().optional(),
  riskLevel: riskLevelSchema.optional(),
  riskReasons: z.array(z.string()).optional(),
  discardReason: z.string().optional()
});

export type MemoryCandidateRecord = z.infer<typeof memoryCandidateRecordSchema>;

export const skillCandidateStatusSchema = z.enum(["pending", "promoted", "discarded", "reverted"]);
export type SkillCandidateStatus = z.infer<typeof skillCandidateStatusSchema>;

export const skillCandidateSchema = z.object({
  agentId: z.string().min(1),
  skillName: z.string().min(1),
  reason: z.string().min(1),
  content: z.string().min(1),
  triggers: z.array(z.string()).optional(),
  riskLevel: riskLevelSchema.optional()
});

export type SkillCandidate = z.infer<typeof skillCandidateSchema>;

export const skillCandidateRecordSchema = skillCandidateSchema.extend({
  id: z.string().min(1),
  status: skillCandidateStatusSchema,
  skillId: z.string().min(1),
  triggers: z.array(z.string()),
  riskLevel: riskLevelSchema,
  suggestedByAgentId: z.string().optional(),
  sourceSessionId: z.string().optional(),
  sourceAgentId: z.string().optional(),
  runId: z.string().optional(),
  createdAt: z.string().min(1),
  reviewedAt: z.string().optional(),
  promotedSkillId: z.string().optional(),
  discardReason: z.string().optional()
});

export type SkillCandidateRecord = z.infer<typeof skillCandidateRecordSchema>;

export const skillMetadataSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  triggers: z.array(z.string()),
  riskLevel: riskLevelSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  sourceCandidateId: z.string().optional(),
  suggestedByAgentId: z.string().optional()
});

export type SkillMetadata = z.infer<typeof skillMetadataSchema>;

export const finalAgentStepSchema = z.object({
  type: z.literal("final"),
  content: z.string(),
  memoryCandidates: z.array(memoryCandidateSchema).optional(),
  skillCandidates: z.array(skillCandidateSchema).optional()
});

export const toolCallAgentStepSchema = z.object({
  type: z.literal("tool_call"),
  tool: toolNameSchema,
  args: z.record(z.string(), z.unknown())
});

export const agentStepSchema = z.discriminatedUnion("type", [
  finalAgentStepSchema,
  toolCallAgentStepSchema
]);

export type AgentStep = z.infer<typeof agentStepSchema>;

export type ModelOutput = {
  step: AgentStep;
  raw: string;
};

export type ModelProvider = {
  id: string;
  checkAuth(): Promise<AuthStatus>;
  complete(input: ModelInput): Promise<ModelOutput>;
};

export type ToolContext = {
  workspaceRoot: string;
  allowedTools: ToolName[];
  sessionId?: string;
  agentId?: string;
  runId?: string;
  sourceChannel?: "cli" | "repl" | "gateway";
  forceOverwriteApproval?: boolean;
  approveOverwrite?: (filePath: string, request?: OverwriteApprovalRequest) => Promise<boolean>;
  onOverwriteApprovalRequired?: (request: OverwriteApprovalRequest) => Promise<void> | void;
  onCodexAmendmentRequired?: (request: CodexAmendmentApprovalRequest) => Promise<string | void> | string | void;
  policyAudit?: (event: PolicyAuditEventInput) => Promise<void>;
};

export type OverwriteApprovalRequest = {
  path: string;
  resolvedPath: string;
  content: string;
};

export type CodexAmendmentApprovalRequest = {
  path: string;
  resolvedPath: string;
  content: string;
};

export type ToolResult = {
  ok: boolean;
  content: string;
};

export type ToolDefinition = {
  name: ToolName;
  permission: ToolPermission;
  source?: "catalog" | "active";
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
};

export type MemoryRecord = {
  id: string;
  tier: MemoryTier;
  scope: MemoryScope;
  legacyScope: MemoryScope | null;
  ownerType: string;
  ownerId: string | null;
  kind: string;
  content: string;
  sourceSessionId: string | null;
  sourceAgentId: string | null;
  confidence: number;
  importance: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  expiresAt: string | null;
  archivedAt: string | null;
  archiveReason: string | null;
  replacedByMemoryId: string | null;
};

export type PolicyAuditEventType = "tool_decision" | "final_rejection" | "approval_required";

export type PolicyAuditEvent = {
  id: string;
  runId?: string;
  timestamp: string;
  sessionId: string;
  agentId: string;
  eventType: PolicyAuditEventType;
  allowed: boolean;
  ruleId: string;
  reason: string;
  tool?: ToolName;
  permission?: ToolPermission;
  argsSummary?: Record<string, unknown>;
};

export type PolicyAuditEventInput = Omit<PolicyAuditEvent, "id" | "timestamp" | "sessionId" | "agentId">;
