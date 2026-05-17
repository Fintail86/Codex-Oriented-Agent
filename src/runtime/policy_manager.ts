import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ensureDir, readText, writeText } from "./fs_utils.js";
import { memoryScopeSchema, toolNameSchema, toolPermissionSchema } from "./types.js";

const policyToolSchema = z.object({
  permission: toolPermissionSchema,
  workspace: z.literal("inside_only"),
  enabled: z.boolean()
});

export const policyConfigSchema = z.object({
  version: z.string().min(1),
  tools: z.record(toolNameSchema, policyToolSchema),
  disabledPermissions: z.array(toolPermissionSchema),
  overwrite: z.object({
    existingFileRequiresApproval: z.boolean()
  }),
  requireTools: z.object({
    observationTools: z.array(toolNameSchema),
    writeFileSatisfies: z.boolean()
  }),
  fileInspection: z.object({
    requiresReadFile: z.boolean(),
    triggerPhrases: z.array(z.string().min(1))
  }),
  memory: z.object({
    longTermWrite: z.literal("candidate_promote_only"),
    candidateScopes: z.array(memoryScopeSchema),
    promotionConflictPolicy: z.literal("block_until_resolved").default("block_until_resolved"),
    archivePolicy: z.literal("explicit_cli_only").default("explicit_cli_only")
  })
});

export type PolicyConfig = z.infer<typeof policyConfigSchema>;

export type PolicyCheckResult = {
  ok: boolean;
  jsonExists: boolean;
  markdownExists: boolean;
  jsonValid: boolean;
  markdownMatches: boolean;
  created: string[];
  errors: string[];
};

export const defaultPolicy: PolicyConfig = {
  version: "0.4.0",
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
    }
  },
  disabledPermissions: ["destructive", "network", "external_send", "shell"],
  overwrite: {
    existingFileRequiresApproval: true
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
  memory: {
    longTermWrite: "candidate_promote_only",
    candidateScopes: ["global", "user", "codex", "agent", "project", "session", "task", "tool"],
    promotionConflictPolicy: "block_until_resolved",
    archivePolicy: "explicit_cli_only"
  }
};

export class PolicyManager {
  constructor(private readonly workspaceRoot: string) {}

  async ensurePolicyFiles(): Promise<string[]> {
    await ensureDir(this.codexDir());
    const created: string[] = [];
    if (!existsSync(this.policyJsonPath())) {
      await writeText(this.policyJsonPath(), `${JSON.stringify(defaultPolicy, null, 2)}\n`);
      created.push("codex/POLICY.json");
    }
    if (!existsSync(this.policyMarkdownPath())) {
      const policy = await this.loadPolicy();
      await writeText(this.policyMarkdownPath(), renderPolicyMarkdown(policy));
      created.push("codex/POLICY.md");
    }
    return created;
  }

  async loadPolicy(): Promise<PolicyConfig> {
    const raw = JSON.parse(await readText(this.policyJsonPath())) as unknown;
    return policyConfigSchema.parse(raw);
  }

  async syncMarkdown(): Promise<string> {
    if (!existsSync(this.policyJsonPath())) {
      await this.ensurePolicyFiles();
    }
    const policy = await this.loadPolicy();
    await writeText(this.policyMarkdownPath(), renderPolicyMarkdown(policy));
    return this.policyMarkdownPath();
  }

  async checkPolicy(repairMissing = false): Promise<PolicyCheckResult> {
    const created = repairMissing ? await this.ensurePolicyFiles() : [];
    const jsonExists = existsSync(this.policyJsonPath());
    const markdownExists = existsSync(this.policyMarkdownPath());
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
      errors.push("Missing codex/POLICY.md");
    } else if (policy) {
      const actual = normalizeNewlines(await readText(this.policyMarkdownPath()));
      const expected = normalizeNewlines(renderPolicyMarkdown(policy));
      markdownMatches = actual === expected;
      if (!markdownMatches) {
        errors.push("codex/POLICY.md is out of sync with codex/POLICY.json");
      }
    }

    return {
      ok: jsonExists && markdownExists && jsonValid && markdownMatches && errors.length === 0,
      jsonExists,
      markdownExists,
      jsonValid,
      markdownMatches,
      created,
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
}

export function renderPolicyMarkdown(policy: PolicyConfig): string {
  const enabledTools = Object.entries(policy.tools)
    .map(([name, config]) => `- \`${name}\`: ${config.enabled ? "enabled" : "disabled"}, permission \`${config.permission}\`, workspace \`${config.workspace}\``)
    .join("\n");

  return `# POLICY

This file mirrors \`codex/POLICY.json\`. The JSON file is the runtime source of truth.

## Version

- Policy version: \`${policy.version}\`

## Tools

${enabledTools}

## Disabled Permissions

${policy.disabledPermissions.map((permission) => `- \`${permission}\``).join("\n")}

## Writes

- Existing file overwrite requires approval: \`${policy.overwrite.existingFileRequiresApproval}\`

## Require Tools

- Observation tools: ${policy.requireTools.observationTools.map((tool) => `\`${tool}\``).join(", ")}
- \`write_file\` satisfies observation: \`${policy.requireTools.writeFileSatisfies}\`

## File Inspection

- Requires \`read_file\` for explicit file-inspection requests: \`${policy.fileInspection.requiresReadFile}\`

## Memory

- Long-term memory write policy: \`${policy.memory.longTermWrite}\`
- Candidate scopes: ${policy.memory.candidateScopes.map((scope) => `\`${scope}\``).join(", ")}
- Promotion conflict policy: \`${policy.memory.promotionConflictPolicy}\`
- Archive policy: \`${policy.memory.archivePolicy}\`
`;
}

export function formatPolicySummary(policy: PolicyConfig): string {
  const toolSummary = Object.entries(policy.tools)
    .map(([name, config]) => `${name}:${config.enabled ? "on" : "off"}/${config.permission}`)
    .join(", ");
  return [
    `Policy ${policy.version}`,
    `Tools: ${toolSummary}`,
    `Disabled permissions: ${policy.disabledPermissions.join(", ")}`,
    `Overwrite approval: ${policy.overwrite.existingFileRequiresApproval ? "required" : "not required"}`,
    `Long-term memory: ${policy.memory.longTermWrite}`,
    `Memory conflict policy: ${policy.memory.promotionConflictPolicy}`
  ].join("\n");
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}
