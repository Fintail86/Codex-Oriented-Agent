import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ensureDir, readText, writeText } from "./fs_utils.js";
import {
  connectorsConfigSchema,
  defaultRuntimeConfig,
  ensureRuntimeDefaults,
  extractLegacyRuntimeConfig,
  gatewayConfigSchema,
  loadRuntimeConfig,
  modelConfigSchema,
  providerTypeForId,
  promptBudgetSchema,
  reviewRetentionSchema,
  stripRuntimeConfig
} from "./runtime_config.js";
import { isBundledToolId } from "./tool_catalog.js";
import { memoryScopeSchema, memoryTierSchema, riskLevelSchema, toolNameSchema, toolPermissionSchema } from "./types.js";

const policyToolSchema = z.object({
  permission: toolPermissionSchema,
  workspace: z.literal("inside_only"),
  enabled: z.boolean()
});

const autoPromotionModeSchema = z.enum(["manual", "conservative", "balanced", "strict"]);
const memoryPromotionPathPolicySchema = z.enum(["manual_or_low_risk", "manual_only", "deferred"]);
const finalUserApprovalRequirementSchema = z.enum([
  "codex_self_amendment",
  "system_level_boundary_change"
]);
const delegatedOperationSchema = z.enum([
  "workspace_local_file_write",
  "agent_behavior_update",
  "session_context_maintenance",
  "low_risk_memory_promotion",
  "tool_growth_candidate_work",
  "bounded_command_adapter_execution"
]);
const writePolicySchema = z.object({
  workspaceLocalDefault: z.literal("delegated_with_evidence"),
  agentBehavior: z.literal("delegated_with_evidence"),
  codexLaw: z.literal("codex_amendment_required"),
  systemBoundary: z.literal("final_user_approval_required"),
  outsideWorkspace: z.literal("denied")
}).default({
  workspaceLocalDefault: "delegated_with_evidence",
  agentBehavior: "delegated_with_evidence",
  codexLaw: "codex_amendment_required",
  systemBoundary: "final_user_approval_required",
  outsideWorkspace: "denied"
});
const approvalPolicySchema = z.object({
  finalUserApprovalRequiredFor: z.array(finalUserApprovalRequirementSchema),
  delegatedUnderPolicy: z.array(delegatedOperationSchema)
}).default({
  finalUserApprovalRequiredFor: [
    "codex_self_amendment",
    "system_level_boundary_change"
  ],
  delegatedUnderPolicy: [
    "workspace_local_file_write",
    "agent_behavior_update",
    "session_context_maintenance",
    "low_risk_memory_promotion",
    "tool_growth_candidate_work",
    "bounded_command_adapter_execution"
  ]
});
const selfImprovementSchema = z.object({
  skillAutoPromotion: z.object({
    enabled: z.boolean(),
    allowRiskLevels: z.array(riskLevelSchema),
    requireTriggers: z.boolean(),
    denySecretLike: z.boolean(),
    maxContentChars: z.number().int().positive(),
    preferForAgent: z.boolean()
  }).default({
    enabled: true,
    allowRiskLevels: ["low"],
    requireTriggers: true,
    denySecretLike: true,
    maxContentChars: 6000,
    preferForAgent: false
  })
}).default({
  skillAutoPromotion: {
    enabled: true,
    allowRiskLevels: ["low"],
    requireTriggers: true,
    denySecretLike: true,
    maxContentChars: 6000,
    preferForAgent: false
  }
});

export const policyConfigSchema = z.object({
  version: z.string().min(1),
  agents: z.object({
    defaultAgentId: z.string().min(1).nullable().default("cosia-agent")
  }).default({
    defaultAgentId: "cosia-agent"
  }),
  tools: z.record(z.string(), policyToolSchema),
  disabledPermissions: z.array(toolPermissionSchema),
  overwrite: z.object({
    existingFileRequiresApproval: z.boolean()
  }),
  writes: writePolicySchema,
  approval: approvalPolicySchema,
  requireTools: z.object({
    observationTools: z.array(toolNameSchema),
    writeFileSatisfies: z.boolean()
  }),
  fileInspection: z.object({
    requiresReadFile: z.boolean(),
    triggerPhrases: z.array(z.string().min(1))
  }),
  codex: z.object({
    protectedSourcePaths: z.array(z.string().min(1)).default([
      "codex/SECURITY.md",
      "codex/RULES.md",
      "codex/SOUL.md",
      "codex/USER.md",
      "codex/POLICY.json"
    ]),
    protectedMirrorPaths: z.array(z.string().min(1)).default([
      "codex/POLICY.md"
    ]),
    amendment: z.object({
      canPropose: z.boolean().default(true),
      requiresUserApproval: z.boolean().default(true),
      approvedApplyOnly: z.boolean().default(true)
    }).default({
      canPropose: true,
      requiresUserApproval: true,
      approvedApplyOnly: true
    })
  }).default({
    protectedSourcePaths: [
      "codex/SECURITY.md",
      "codex/RULES.md",
      "codex/SOUL.md",
      "codex/USER.md",
      "codex/POLICY.json"
    ],
    protectedMirrorPaths: [
      "codex/POLICY.md"
    ],
    amendment: {
      canPropose: true,
      requiresUserApproval: true,
      approvedApplyOnly: true
    }
  }),
  memory: z.object({
    longTermWrite: z.literal("candidate_promote_only"),
    candidateTiers: z.array(memoryTierSchema).default(["core", "agent", "session"]),
    candidateScopes: z.array(memoryScopeSchema),
    promotionConflictPolicy: z.literal("block_until_resolved").default("block_until_resolved"),
    archivePolicy: z.literal("explicit_cli_only").default("explicit_cli_only"),
    promotionPaths: z.object({
      sessionToAgent: memoryPromotionPathPolicySchema,
      sessionToCore: memoryPromotionPathPolicySchema,
      agentToCore: memoryPromotionPathPolicySchema,
      coreToSkillCandidate: memoryPromotionPathPolicySchema,
      coreToCodexAmendment: memoryPromotionPathPolicySchema
    }).default({
      sessionToAgent: "manual_or_low_risk",
      sessionToCore: "manual_or_low_risk",
      agentToCore: "manual_or_low_risk",
      coreToSkillCandidate: "manual_or_low_risk",
      coreToCodexAmendment: "deferred"
    }),
    autoPromotion: z.object({
      mode: autoPromotionModeSchema,
      allowRiskLevels: z.array(riskLevelSchema),
      requireNoConflict: z.boolean(),
      allowTiers: z.array(memoryTierSchema).default(["session", "agent"]),
      denyTiers: z.array(memoryTierSchema).default(["core"]),
      allowScopes: z.array(memoryScopeSchema),
      denyScopes: z.array(memoryScopeSchema),
      denyKinds: z.array(z.string().min(1))
    }).default({
      mode: "balanced",
      allowRiskLevels: ["low"],
      requireNoConflict: true,
      allowTiers: ["session", "agent"],
      denyTiers: ["core"],
      allowScopes: ["agent", "project", "session", "task", "tool"],
      denyScopes: ["codex", "user", "global"],
      denyKinds: ["security", "policy", "credential", "secret"]
    })
  }),
  selfImprovement: selfImprovementSchema,
  promptBudget: promptBudgetSchema.default(defaultRuntimeConfig.promptBudget),
  model: modelConfigSchema.default(defaultRuntimeConfig.model),
  gateway: gatewayConfigSchema.default(defaultRuntimeConfig.gateway),
  connectors: connectorsConfigSchema.default(defaultRuntimeConfig.connectors),
  review: reviewRetentionSchema.default(defaultRuntimeConfig.review)
});

export type PolicyConfig = z.infer<typeof policyConfigSchema>;

export type PolicyCheckResult = {
  ok: boolean;
  jsonExists: boolean;
  markdownExists: boolean;
  jsonValid: boolean;
  markdownMatches: boolean;
  created: string[];
  repaired: string[];
  errors: string[];
};

export const defaultPolicy: PolicyConfig = {
  version: "0.53.0",
  agents: {
    defaultAgentId: "cosia-agent"
  },
  tools: {
    read_file: {
      permission: "read_only",
      workspace: "inside_only",
      enabled: true
    },
    write_file: {
      permission: "write_local",
      workspace: "inside_only",
      enabled: true
    },
    search_files: {
      permission: "read_only",
      workspace: "inside_only",
      enabled: true
    },
    review_inbox_read: {
      permission: "read_only",
      workspace: "inside_only",
      enabled: true
    },
    shell_request: {
      permission: "shell_request",
      workspace: "inside_only",
      enabled: true
    }
  },
  disabledPermissions: ["destructive", "network", "external_send", "shell"],
  overwrite: {
    existingFileRequiresApproval: false
  },
  writes: {
    workspaceLocalDefault: "delegated_with_evidence",
    agentBehavior: "delegated_with_evidence",
    codexLaw: "codex_amendment_required",
    systemBoundary: "final_user_approval_required",
    outsideWorkspace: "denied"
  },
  approval: {
    finalUserApprovalRequiredFor: [
      "codex_self_amendment",
      "system_level_boundary_change"
    ],
    delegatedUnderPolicy: [
      "workspace_local_file_write",
      "agent_behavior_update",
      "session_context_maintenance",
      "low_risk_memory_promotion",
      "tool_growth_candidate_work",
      "bounded_command_adapter_execution"
    ]
  },
  requireTools: {
    observationTools: ["read_file", "search_files"],
    writeFileSatisfies: false
  },
  fileInspection: {
    requiresReadFile: true,
    triggerPhrases: [
      "파일을 보고",
      "실제 파일",
      "파일 기준",
      "파일 내용",
      "파일을 확인",
      "read_file",
      "actual file",
      "actual files",
      "inspect file",
      "inspect files",
      "read the file",
      "read files",
      "from the file",
      "from files"
    ]
  },
  codex: {
    protectedSourcePaths: [
      "codex/SECURITY.md",
      "codex/RULES.md",
      "codex/SOUL.md",
      "codex/USER.md",
      "codex/POLICY.json"
    ],
    protectedMirrorPaths: [
      "codex/POLICY.md"
    ],
    amendment: {
      canPropose: true,
      requiresUserApproval: true,
      approvedApplyOnly: true
    }
  },
  memory: {
    longTermWrite: "candidate_promote_only",
    candidateTiers: ["core", "agent", "session"],
    candidateScopes: ["global", "user", "codex", "agent", "project", "session", "task", "tool"],
    promotionConflictPolicy: "block_until_resolved",
    archivePolicy: "explicit_cli_only",
    promotionPaths: {
      sessionToAgent: "manual_or_low_risk",
      sessionToCore: "manual_or_low_risk",
      agentToCore: "manual_or_low_risk",
      coreToSkillCandidate: "manual_or_low_risk",
      coreToCodexAmendment: "deferred"
    },
    autoPromotion: {
      mode: "balanced",
      allowRiskLevels: ["low"],
      requireNoConflict: true,
      allowTiers: ["session", "agent"],
      denyTiers: ["core"],
      allowScopes: ["agent", "project", "session", "task", "tool"],
      denyScopes: ["codex", "user", "global"],
      denyKinds: ["security", "policy", "credential", "secret"]
    }
  },
  selfImprovement: {
    skillAutoPromotion: {
      enabled: true,
      allowRiskLevels: ["low"],
      requireTriggers: true,
      denySecretLike: true,
      maxContentChars: 6000,
      preferForAgent: false
    }
  },
  promptBudget: defaultRuntimeConfig.promptBudget,
  model: defaultRuntimeConfig.model,
  gateway: defaultRuntimeConfig.gateway,
  connectors: defaultRuntimeConfig.connectors,
  review: defaultRuntimeConfig.review
};

export class PolicyManager {
  constructor(private readonly workspaceRoot: string) {}

  async ensurePolicyFiles(): Promise<string[]> {
    await ensureDir(this.codexDir());
    const created: string[] = [];
    created.push(...await ensureRuntimeDefaults(this.workspaceRoot));
    if (!existsSync(this.policyJsonPath())) {
      await writeText(this.policyJsonPath(), `${JSON.stringify(policyLawJson(defaultPolicy), null, 2)}\n`);
      created.push("codex/POLICY.json");
    }
    if (!existsSync(this.policyMarkdownPath())) {
      const policy = await this.loadPolicy();
      await writeText(this.policyMarkdownPath(), renderPolicyMarkdown(policy));
      created.push("codex/POLICY.md");
    }
    await this.normalizePolicyJson();
    return created;
  }

  async loadPolicy(): Promise<PolicyConfig> {
    const raw = JSON.parse(await readText(this.policyJsonPath())) as unknown;
    const runtime = await loadRuntimeConfig(this.workspaceRoot, raw);
    return normalizePolicy(policyConfigSchema.parse({
      ...(raw as Record<string, unknown>),
      promptBudget: runtime.config.promptBudget,
      model: runtime.config.model,
      gateway: runtime.config.gateway,
      connectors: runtime.config.connectors,
      review: runtime.config.review
    }));
  }

  async savePolicy(policy: PolicyConfig): Promise<void> {
    await writeText(this.policyJsonPath(), `${JSON.stringify(policyLawJson(normalizePolicy(policyConfigSchema.parse(policy))), null, 2)}\n`);
  }

  async setDefaultAgent(agentId: string | null): Promise<PolicyConfig> {
    const policy = await this.loadPolicy();
    const next = policyConfigSchema.parse({
      ...policy,
      agents: {
        ...policy.agents,
        defaultAgentId: agentId
      }
    });
    await this.savePolicy(next);
    await writeText(this.policyMarkdownPath(), renderPolicyMarkdown(next));
    return next;
  }

  async syncMarkdown(): Promise<string> {
    if (!existsSync(this.policyJsonPath())) {
      await this.ensurePolicyFiles();
    }
    const policy = await this.loadPolicy();
    await writeText(this.policyMarkdownPath(), renderPolicyMarkdown(policy));
    return this.policyMarkdownPath();
  }

  async ensureMarkdownCurrent(): Promise<boolean> {
    if (!existsSync(this.policyJsonPath())) {
      await this.ensurePolicyFiles();
    }
    const policy = await this.loadPolicy();
    if (await this.isPolicyMirrorCurrent(policy)) {
      return false;
    }
    await writeText(this.policyMarkdownPath(), renderPolicyMarkdown(policy));
    return true;
  }

  async isPolicyMirrorCurrent(policy?: PolicyConfig): Promise<boolean> {
    if (!existsSync(this.policyMarkdownPath())) {
      return false;
    }
    const actual = normalizeNewlines(await readText(this.policyMarkdownPath()));
    const expected = normalizeNewlines(renderPolicyMarkdown(policy ?? await this.loadPolicy()));
    return actual === expected;
  }

  async checkPolicy(repairMissing = false, repairMirror = false): Promise<PolicyCheckResult> {
    const created = repairMissing ? await this.ensurePolicyFiles() : [];
    const repaired: string[] = [];
    const jsonExists = existsSync(this.policyJsonPath());
    let markdownExists = existsSync(this.policyMarkdownPath());
    const errors: string[] = [];
    let jsonValid = false;
    let markdownMatches = false;
    let policy: PolicyConfig | undefined;

    if (!jsonExists) {
      errors.push("Missing codex/POLICY.json");
    } else {
      try {
        policy = await this.loadPolicy();
        jsonValid = true;
      } catch (error) {
        errors.push(`Invalid codex/POLICY.json: ${(error as Error).message}`);
      }
    }

    if (!markdownExists) {
      if (policy && repairMirror) {
        await writeText(this.policyMarkdownPath(), renderPolicyMarkdown(policy));
        repaired.push("codex/POLICY.md");
        markdownExists = true;
        markdownMatches = true;
      } else {
        errors.push("Missing codex/POLICY.md");
      }
    } else if (policy) {
      markdownMatches = await this.isPolicyMirrorCurrent(policy);
      if (!markdownMatches) {
        if (repairMirror) {
          await writeText(this.policyMarkdownPath(), renderPolicyMarkdown(policy));
          repaired.push("codex/POLICY.md");
          markdownMatches = true;
        } else {
          errors.push("codex/POLICY.md is out of sync with codex/POLICY.json");
        }
      }
    }

    return {
      ok: jsonExists && markdownExists && jsonValid && markdownMatches && errors.length === 0,
      jsonExists,
      markdownExists,
      jsonValid,
      markdownMatches,
      created,
      repaired,
      errors
    };
  }

  private codexDir(): string {
    return join(this.workspaceRoot, "codex");
  }

  private policyJsonPath(): string {
    return join(this.codexDir(), "POLICY.json");
  }

  private policyMarkdownPath(): string {
    return join(this.codexDir(), "POLICY.md");
  }

  private async normalizePolicyJson(): Promise<void> {
    if (!existsSync(this.policyJsonPath())) {
      return;
    }
    const raw = JSON.parse(await readText(this.policyJsonPath())) as unknown;
    const legacy = extractLegacyRuntimeConfig(raw);
    if (Object.keys(legacy).length) {
      return;
    }
    const normalized = policyLawJson(normalizePolicy(policyConfigSchema.parse(raw)));
    if (JSON.stringify(raw) !== JSON.stringify(normalized)) {
      await writeText(this.policyJsonPath(), `${JSON.stringify(normalized, null, 2)}\n`);
    }
  }
}

export function normalizePolicy(policy: PolicyConfig): PolicyConfig {
  const providers = {
    ...policy.model.providers
  };
  for (const [id, config] of Object.entries(providers)) {
    providers[id] = {
      ...config,
      type: config.type ?? providerTypeForId(id),
      responseFormat: config.responseFormat ?? null,
      extraHeaders: config.extraHeaders ?? {}
    };
  }
  if (!providers.openrouter) {
    providers.openrouter = defaultPolicy.model.providers.openrouter;
  }
  if (!providers["codex-cli"]) {
    providers["codex-cli"] = defaultPolicy.model.providers["codex-cli"];
  }
  if (!providers["openai-codex"]) {
    providers["openai-codex"] = defaultPolicy.model.providers["openai-codex"];
  }
  if (!providers["openai-compatible"]) {
    providers["openai-compatible"] = defaultPolicy.model.providers["openai-compatible"];
  }
  const providerProfiles = Object.fromEntries(
    Object.entries(policy.model.providerProfiles ?? {}).map(([name, profile]) => [name, {
      ...profile,
      name
    }])
  );
  const tools = {
    ...defaultPolicy.tools,
    ...Object.fromEntries(
      Object.entries(policy.tools).filter(([name]) => toolNameSchema.safeParse(name).success && !isBundledToolId(name))
    )
  };
  return policyConfigSchema.parse({
    ...policy,
    tools,
    model: {
      ...policy.model,
      providerProfiles,
      providers
    },
    gateway: {
      authorization: {
        ...defaultPolicy.gateway.authorization,
        ...policy.gateway?.authorization,
        chats: policy.gateway?.authorization?.chats ?? defaultPolicy.gateway.authorization.chats,
        roleBindings: policy.gateway?.authorization?.roleBindings ?? defaultPolicy.gateway.authorization.roleBindings
      }
    },
    connectors: {
      telegram: {
        ...defaultPolicy.connectors.telegram,
        ...policy.connectors?.telegram
      }
    },
    review: {
      ...defaultPolicy.review,
      ...policy.review
    },
    selfImprovement: {
      skillAutoPromotion: {
        ...defaultPolicy.selfImprovement.skillAutoPromotion,
        ...policy.selfImprovement?.skillAutoPromotion
      }
    },
    writes: {
      ...defaultPolicy.writes,
      ...policy.writes
    },
    approval: {
      ...defaultPolicy.approval,
      ...policy.approval
    }
  });
}

export function policyLawJson(policy: PolicyConfig): Record<string, unknown> {
  return stripRuntimeConfig({
    version: policy.version,
    agents: policy.agents,
    tools: policy.tools,
    disabledPermissions: policy.disabledPermissions,
    overwrite: policy.overwrite,
    writes: policy.writes,
    approval: policy.approval,
    requireTools: policy.requireTools,
    fileInspection: policy.fileInspection,
    codex: policy.codex,
    memory: policy.memory,
    selfImprovement: policy.selfImprovement
  });
}

export function renderPolicyMarkdown(policy: PolicyConfig): string {
  const enabledTools = Object.entries(policy.tools)
    .map(([name, config]) => `- \`${name}\`: ${config.enabled ? "enabled" : "disabled"}, permission \`${config.permission}\`, workspace \`${config.workspace}\``)
    .join("\n");

  return `# POLICY

This file mirrors \`codex/POLICY.json\`. The JSON file is the Codex law source of truth. Runtime settings live in \`config/runtime.defaults.json\`, legacy \`config/runtime.local.json\`, and optional ignored \`config/runtime.private.json\`.

## Version

- Policy version: \`${policy.version}\`

## Agents

- Default agent: \`${policy.agents.defaultAgentId ?? "none"}\`

## Core Runtime Tools

${enabledTools}

## Disabled Permissions

${policy.disabledPermissions.map((permission) => `- \`${permission}\``).join("\n")}

## Writes

- Workspace-local writes: \`${policy.writes.workspaceLocalDefault}\`
- Agent behavior writes: \`${policy.writes.agentBehavior}\`
- Codex law writes: \`${policy.writes.codexLaw}\`
- System boundary writes: \`${policy.writes.systemBoundary}\`
- Outside-workspace writes: \`${policy.writes.outsideWorkspace}\`
- Legacy overwrite approval switch: \`${policy.overwrite.existingFileRequiresApproval}\`

## Approval Boundary

- Final user approval required for: ${policy.approval.finalUserApprovalRequiredFor.map((item) => `\`${item}\``).join(", ")}
- Delegated under active Policy: ${policy.approval.delegatedUnderPolicy.map((item) => `\`${item}\``).join(", ")}

## Require Tools

- Observation tools: ${policy.requireTools.observationTools.map((tool) => `\`${tool}\``).join(", ")}
- \`write_file\` satisfies observation: \`${policy.requireTools.writeFileSatisfies}\`

## File Inspection

- Requires \`read_file\` for explicit file-inspection requests: \`${policy.fileInspection.requiresReadFile}\`

## Codex Boundary

- Protected source paths: ${policy.codex.protectedSourcePaths.map((path) => `\`${path}\``).join(", ")}
- Protected generated mirrors: ${policy.codex.protectedMirrorPaths.map((path) => `\`${path}\``).join(", ")}
- COSIA may propose Codex amendments: \`${policy.codex.amendment.canPropose}\`
- User review and approval required: \`${policy.codex.amendment.requiresUserApproval}\`
- Only approved amendment apply flow may modify protected Codex paths: \`${policy.codex.amendment.approvedApplyOnly}\`

## Memory

- Long-term memory write policy: \`${policy.memory.longTermWrite}\`
- Candidate tiers: ${policy.memory.candidateTiers.map((tier) => `\`${tier}\``).join(", ")}
- Candidate scopes: ${policy.memory.candidateScopes.map((scope) => `\`${scope}\``).join(", ")}
- Promotion conflict policy: \`${policy.memory.promotionConflictPolicy}\`
- Archive policy: \`${policy.memory.archivePolicy}\`
- Promotion paths: session->agent \`${policy.memory.promotionPaths.sessionToAgent}\`, session->core \`${policy.memory.promotionPaths.sessionToCore}\`, agent->core \`${policy.memory.promotionPaths.agentToCore}\`, core->skill \`${policy.memory.promotionPaths.coreToSkillCandidate}\`, core->codex \`${policy.memory.promotionPaths.coreToCodexAmendment}\`
- Auto promotion mode: \`${policy.memory.autoPromotion.mode}\`
- Auto promotion risk levels: ${policy.memory.autoPromotion.allowRiskLevels.map((level) => `\`${level}\``).join(", ")}
- Auto promotion tiers: ${policy.memory.autoPromotion.allowTiers.map((tier) => `\`${tier}\``).join(", ")}
- Auto promotion requires no conflict: \`${policy.memory.autoPromotion.requireNoConflict}\`

## Self Improvement

- Skill auto promotion enabled: \`${policy.selfImprovement.skillAutoPromotion.enabled}\`
- Skill auto promotion risk levels: ${policy.selfImprovement.skillAutoPromotion.allowRiskLevels.map((level) => `\`${level}\``).join(", ")}
- Skill auto promotion requires triggers: \`${policy.selfImprovement.skillAutoPromotion.requireTriggers}\`
- Skill auto promotion denies secret-like content: \`${policy.selfImprovement.skillAutoPromotion.denySecretLike}\`
- Skill auto promotion max content chars: \`${policy.selfImprovement.skillAutoPromotion.maxContentChars}\`
- Skill auto promotion prefers for agent automatically: \`${policy.selfImprovement.skillAutoPromotion.preferForAgent}\`

## Runtime Config

- Operational settings are not Codex law.
- Provider profiles, gateway connector settings, prompt budgets, bundled tool enablement, and review retention live in runtime config. User-specific values should live in ignored private config and secret files.
- Runtime config cannot relax disabled permissions, dangerous command blocks, protected Codex path rules, or Codex amendment approval requirements.
`;
}

export function formatPolicySummary(policy: PolicyConfig): string {
  const toolSummary = Object.entries(policy.tools)
    .map(([name, config]) => `${name}:${config.enabled ? "on" : "off"}/${config.permission}`)
    .join(", ");
  return [
    `Policy ${policy.version}`,
    `Core tools: ${toolSummary}`,
    `Disabled permissions: ${policy.disabledPermissions.join(", ")}`,
    `Workspace writes: ${policy.writes.workspaceLocalDefault}`,
    `Final approval: ${policy.approval.finalUserApprovalRequiredFor.join(", ")}`,
    `Long-term memory: ${policy.memory.longTermWrite}`,
    `Memory conflict policy: ${policy.memory.promotionConflictPolicy}`,
    `Memory auto promotion: ${policy.memory.autoPromotion.mode}`,
    `Skill auto promotion: ${policy.selfImprovement.skillAutoPromotion.enabled ? "enabled" : "disabled"}`,
    `Prompt budget: ${policy.promptBudget.maxPromptChars} chars`,
    `Default agent: ${policy.agents.defaultAgentId ?? "none"}`,
    `Active provider profile: ${policy.model.activeProviderProfile ?? "none"}`,
    `Telegram connector: ${policy.connectors.telegram.enabled ? "enabled" : "disabled"}`
  ].join("\n");
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}
