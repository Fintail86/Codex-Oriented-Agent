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

export const toolPermissionSchema = z.enum([
  "read_only",
  "write_local",
  "destructive",
  "network",
  "external_send",
  "shell"
]);

export type ToolPermission = z.infer<typeof toolPermissionSchema>;

export const toolNameSchema = z.enum([
  "read_file",
  "write_file",
  "search_files",
  "git_status",
  "git_diff",
  "git_log",
  "npm_test",
  "npm_typecheck"
]);
export type ToolName = z.infer<typeof toolNameSchema>;

export const agentManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  allowedTools: z.array(toolNameSchema),
  skills: z.array(z.string()),
  memoryScopes: z.array(memoryScopeSchema)
});

export type AgentManifest = z.infer<typeof agentManifestSchema>;

export const sessionMetadataSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  status: z.enum(["active", "completed", "archived"]),
  goal: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

export type AuthStatus = {
  ok: boolean;
  message: string;
};

export type ModelInput = {
  prompt: string;
  sessionId: string;
  retryInstruction?: string;
};

export const memoryCandidateSchema = z.object({
  scope: memoryScopeSchema,
  ownerId: z.string().optional(),
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

export const finalAgentStepSchema = z.object({
  type: z.literal("final"),
  content: z.string(),
  memoryCandidates: z.array(memoryCandidateSchema).optional()
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
  approveOverwrite?: (filePath: string) => Promise<boolean>;
  policyAudit?: (event: PolicyAuditEventInput) => Promise<void>;
};

export type ToolResult = {
  ok: boolean;
  content: string;
};

export type ToolDefinition = {
  name: ToolName;
  permission: ToolPermission;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
};

export type MemoryRecord = {
  id: string;
  scope: MemoryScope;
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
