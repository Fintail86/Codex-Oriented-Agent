import { stat } from "node:fs/promises";
import { relative } from "node:path";
import { resolveInside } from "./fs_utils.js";
import { defaultPolicy, type PolicyConfig } from "./policy_manager.js";
import { defaultRuntimeConfig, type RuntimeConfig } from "./runtime_config.js";
import { isBundledToolId } from "./tool_catalog.js";
import type { ToolDefinition, ToolName } from "./types.js";

export type PolicyDecision = {
  allowed: boolean;
  ruleId: string;
  reason: string;
  requiresApproval?: "overwrite";
};

export type RuntimePolicyState = {
  requireTools?: boolean;
  userPrompt: string;
  executedTools: ToolName[];
};

export class PolicyEngine {
  constructor(
    private readonly policy: PolicyConfig = defaultPolicy,
    private readonly runtimeConfig: RuntimeConfig = defaultRuntimeConfig
  ) {}

  evaluate(tool: ToolDefinition, args: unknown, workspaceRoot: string): PolicyDecision {
    const toolPolicy = this.policy.tools[tool.name];
    const bundledToolConfig = isBundledToolId(tool.name) ? this.runtimeConfig.tools.bundled[tool.name] : undefined;
    if (isBundledToolId(tool.name)) {
      if (!bundledToolConfig?.enabled) {
        return { allowed: false, ruleId: "tool.config_disabled", reason: `Bundled tool is disabled by runtime config: ${tool.name}` };
      }
    } else if (!toolPolicy) {
      return { allowed: false, ruleId: "tool.unconfigured", reason: `Tool is not configured by policy: ${tool.name}` };
    } else if (!toolPolicy.enabled) {
      return { allowed: false, ruleId: "tool.disabled", reason: `Tool is disabled by policy: ${tool.name}` };
    } else if (toolPolicy.permission !== tool.permission) {
      return {
        allowed: false,
        ruleId: "tool.permission_mismatch",
        reason: `Tool permission does not match policy: ${tool.name}`
      };
    }
    if (this.policy.disabledPermissions.includes(tool.permission)) {
      return { allowed: false, ruleId: "permission.disabled", reason: `Permission is disabled by policy: ${tool.permission}` };
    }
    if (tool.permission === "read_only") {
      return this.evaluateReadOnly(tool.name, args, workspaceRoot);
    }
    if (tool.permission === "write_local") {
      return this.evaluateWriteLocal(args, workspaceRoot);
    }
    if (tool.permission === "project_check") {
      return { allowed: true, ruleId: "tool.project_check.fixed_script", reason: "Allowed fixed project check script." };
    }
    if (tool.permission === "shell_request") {
      return { allowed: true, ruleId: "tool.shell_request.preview_only", reason: "Allowed shell approval preview creation. This does not execute a command." };
    }
    return { allowed: false, ruleId: "permission.unsupported", reason: `Unsupported permission: ${tool.permission}` };
  }

  private evaluateReadOnly(toolName: string, args: unknown, workspaceRoot: string): PolicyDecision {
    const path = this.extractPath(args, toolName === "search_files" ? "directory" : "path");
    if (path) {
      const boundary = this.evaluateInsideWorkspace(workspaceRoot, path);
      if (!boundary.allowed) {
        return boundary;
      }
    }
    return { allowed: true, ruleId: "tool.read_only.workspace", reason: "Allowed read-only workspace operation." };
  }

  private evaluateWriteLocal(args: unknown, workspaceRoot: string): PolicyDecision {
    const path = this.extractPath(args, "path");
    if (!path) {
      return { allowed: false, ruleId: "tool.write_file.path_required", reason: "write_file requires a path argument." };
    }
    const boundary = this.evaluateInsideWorkspace(workspaceRoot, path);
    if (!boundary.allowed) {
      return boundary;
    }
    const resolved = resolveInside(workspaceRoot, path);
    const protectedDecision = this.evaluateProtectedCodexPath(workspaceRoot, resolved);
    if (!protectedDecision.allowed) {
      return protectedDecision;
    }
    return {
      allowed: true,
      ruleId: "tool.write_local.workspace",
      reason: `Allowed workspace write operation: ${resolved}`
    };
  }

  async requiresOverwriteApproval(args: unknown, workspaceRoot: string): Promise<boolean> {
    if (!this.policy.overwrite.existingFileRequiresApproval) {
      return false;
    }
    const path = this.extractPath(args, "path");
    if (!path) {
      return false;
    }
    const resolved = resolveInside(workspaceRoot, path);
    try {
      const info = await stat(resolved);
      return info.isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  evaluateFinalAnswer(state: RuntimePolicyState): PolicyDecision {
    if (state.requireTools) {
      const hasObservationTool = state.executedTools.some((tool) => this.policy.requireTools.observationTools.includes(tool));
      if (!hasObservationTool) {
        return {
          allowed: false,
          ruleId: "runtime.require_tools.observation",
          reason: `Final answer rejected because no observation tool has run. Required tools: ${this.policy.requireTools.observationTools.join(", ")}.`
        };
      }
    }

    if (
      state.requireTools &&
      this.policy.fileInspection.requiresReadFile &&
      this.asksForActualFiles(state.userPrompt) &&
      !state.executedTools.includes("read_file")
    ) {
      return {
        allowed: false,
        ruleId: "runtime.file_inspection.read_file_required",
        reason: "Final answer rejected because explicit file inspection requires read_file."
      };
    }

    return {
      allowed: true,
      ruleId: "runtime.final.allowed",
      reason: "Final answer allowed by runtime policy."
    };
  }

  private evaluateInsideWorkspace(workspaceRoot: string, path: string): PolicyDecision {
    try {
      const resolved = resolveInside(workspaceRoot, path);
      return {
        allowed: true,
        ruleId: "workspace.inside_only",
        reason: `Allowed workspace path: ${resolved}`
      };
    } catch (error) {
      return {
        allowed: false,
        ruleId: "workspace.inside_only",
        reason: (error as Error).message
      };
    }
  }

  private extractPath(args: unknown, key: "path" | "directory"): string | undefined {
    if (!args || typeof args !== "object") {
      return undefined;
    }
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
    return undefined;
  }

  private evaluateProtectedCodexPath(workspaceRoot: string, resolvedPath: string): PolicyDecision {
    const normalized = normalizeRelativePath(relative(workspaceRoot, resolvedPath));
    const protectedPaths = [
      ...(this.policy.codex?.protectedSourcePaths ?? []),
      ...(this.policy.codex?.protectedMirrorPaths ?? [])
    ].map(normalizeRelativePath);
    if (protectedPaths.includes(normalized)) {
      return {
        allowed: false,
        ruleId: "codex.protected_path",
        reason: `Generic write_file cannot modify protected Codex path: ${normalized}. Use an approved Codex amendment apply flow.`
      };
    }
    return {
      allowed: true,
      ruleId: "codex.protected_path.allowed",
      reason: "Path is not a protected Codex path."
    };
  }

  private asksForActualFiles(prompt: string): boolean {
    const normalized = prompt.toLowerCase();
    return this.policy.fileInspection.triggerPhrases.some((needle) => normalized.includes(needle.toLowerCase()));
  }
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}
