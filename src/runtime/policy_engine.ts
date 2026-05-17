import { stat } from "node:fs/promises";
import { resolveInside } from "./fs_utils.js";
import type { ToolDefinition } from "./types.js";

export type PolicyDecision = {
  allowed: boolean;
  reason: string;
  requiresApproval?: "overwrite";
};

export class PolicyEngine {
  evaluate(tool: ToolDefinition, args: unknown, workspaceRoot: string): PolicyDecision {
    if (["destructive", "network", "external_send", "shell"].includes(tool.permission)) {
      return { allowed: false, reason: `Permission is disabled in v0.2: ${tool.permission}` };
    }
    if (tool.permission === "read_only") {
      return this.evaluateReadOnly(tool.name, args, workspaceRoot);
    }
    if (tool.permission === "write_local") {
      return this.evaluateWriteLocal(args, workspaceRoot);
    }
    return { allowed: false, reason: `Unsupported permission: ${tool.permission}` };
  }

  private evaluateReadOnly(toolName: string, args: unknown, workspaceRoot: string): PolicyDecision {
    const path = this.extractPath(args, toolName === "search_files" ? "directory" : "path");
    if (path) {
      resolveInside(workspaceRoot, path);
    }
    return { allowed: true, reason: "Allowed read-only workspace operation." };
  }

  private evaluateWriteLocal(args: unknown, workspaceRoot: string): PolicyDecision {
    const path = this.extractPath(args, "path");
    if (!path) {
      return { allowed: false, reason: "write_file requires a path argument." };
    }
    const resolved = resolveInside(workspaceRoot, path);
    return {
      allowed: true,
      reason: `Allowed workspace write operation: ${resolved}`
    };
  }

  async requiresOverwriteApproval(args: unknown, workspaceRoot: string): Promise<boolean> {
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
