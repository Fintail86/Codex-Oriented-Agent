import { stat } from "node:fs/promises";
import { resolveInside } from "./fs_utils.js";
import { defaultPolicy, type PolicyConfig } from "./policy_manager.js";
import type { ToolDefinition } from "./types.js";

export type PolicyDecision = {
  allowed: boolean;
  ruleId: string;
  reason: string;
  requiresApproval?: "overwrite";
};

export class PolicyEngine {
  constructor(private readonly policy: PolicyConfig = defaultPolicy) {}

  evaluate(tool: ToolDefinition, args: unknown, workspaceRoot: string): PolicyDecision {
    const toolPolicy = this.policy.tools[tool.name];
    if (!toolPolicy) {
      return { allowed: false, ruleId: "tool.unconfigured", reason: `Tool is not configured by policy: ${tool.name}` };
    }
    if (!toolPolicy.enabled) {
      return { allowed: false, ruleId: "tool.disabled", reason: `Tool is disabled by policy: ${tool.name}` };
    }
    if (toolPolicy.permission !== tool.permission) {
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
}
