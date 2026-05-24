import { relative } from "node:path";
import { resolveInside } from "./fs_utils.js";
import type { PolicyConfig } from "./policy_manager.js";

export type DelegationBoundaryLevel =
  | "delegated"
  | "codex_amendment"
  | "final_user_approval"
  | "denied";

export type RuntimeBoundaryChangeKind =
  | "ordinary_workspace_file"
  | "agent_behavior_file"
  | "codex_law"
  | "provider_authority"
  | "connector_authority"
  | "policy_security_gate"
  | "permission_boundary"
  | "workspace_boundary"
  | "external_side_effect_authority";

export type DelegationBoundaryClassification = {
  level: DelegationBoundaryLevel;
  ruleId: string;
  reason: string;
  relativePath?: string;
  operation:
    | "workspace_local_file_write"
    | "agent_behavior_update"
    | "codex_self_amendment"
    | "system_level_boundary_change"
    | "outside_workspace";
};

export function classifyRuntimeBoundaryChange(kind: RuntimeBoundaryChangeKind): DelegationBoundaryClassification {
  if (kind === "ordinary_workspace_file") {
    return {
      level: "delegated",
      ruleId: "delegation.workspace_local_file_write",
      reason: "Routine workspace-local file changes are delegated under active Policy.",
      operation: "workspace_local_file_write"
    };
  }
  if (kind === "agent_behavior_file") {
    return {
      level: "delegated",
      ruleId: "delegation.agent_behavior_update",
      reason: "Agent behavior file changes are delegated under active Policy with evidence.",
      operation: "agent_behavior_update"
    };
  }
  if (kind === "codex_law") {
    return {
      level: "codex_amendment",
      ruleId: "codex.protected_path",
      reason: "Codex law changes require the Codex amendment preview/apply flow.",
      operation: "codex_self_amendment"
    };
  }
  return {
    level: "final_user_approval",
    ruleId: `system_boundary.${kind}`,
    reason: "System-level boundary changes require final user approval through a dedicated boundary change flow.",
    operation: "system_level_boundary_change"
  };
}

export function classifyWritePathBoundary(
  workspaceRoot: string,
  inputPath: string,
  policy: Pick<PolicyConfig, "codex">
): DelegationBoundaryClassification {
  let resolved: string;
  try {
    resolved = resolveInside(workspaceRoot, inputPath);
  } catch (error) {
    return {
      level: "denied",
      ruleId: "workspace.inside_only",
      reason: (error as Error).message,
      operation: "outside_workspace"
    };
  }

  const relativePath = normalizeRelativePath(relative(workspaceRoot, resolved));
  const policyCodexPaths = [
    ...(policy.codex?.protectedSourcePaths ?? []),
    ...(policy.codex?.protectedMirrorPaths ?? [])
  ].map(normalizeRelativePath);

  if (relativePath === "codex" || relativePath.startsWith("codex/") || policyCodexPaths.includes(relativePath)) {
    return {
      ...classifyRuntimeBoundaryChange("codex_law"),
      relativePath,
      reason: `Generic write_file cannot modify protected Codex path: ${relativePath}. Use an approved Codex amendment apply flow.`
    };
  }

  if (isAgentBehaviorPath(relativePath)) {
    return {
      ...classifyRuntimeBoundaryChange("agent_behavior_file"),
      relativePath
    };
  }

  if (isSystemBoundaryPath(relativePath)) {
    return {
      ...classifyRuntimeBoundaryChange(systemBoundaryKindForPath(relativePath)),
      relativePath,
      reason: `Generic write_file cannot modify system-level boundary path: ${relativePath}. Final user approval is required through a dedicated boundary change flow.`
    };
  }

  return {
    ...classifyRuntimeBoundaryChange("ordinary_workspace_file"),
    relativePath
  };
}

export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function isAgentBehaviorPath(path: string): boolean {
  return /^agents\/[^/]+\/(style|agent|local_rules)\.md$/.test(path);
}

function isSystemBoundaryPath(path: string): boolean {
  return path === "config" ||
    path.startsWith("config/") ||
    path === "memory" ||
    path.startsWith("memory/") ||
    path === ".cosia-gateway" ||
    path.startsWith(".cosia-gateway/") ||
    /^agents\/[^/]+\/manifest\.json$/.test(path);
}

function systemBoundaryKindForPath(path: string): RuntimeBoundaryChangeKind {
  if (path.startsWith("config/") || path === "config") {
    return "provider_authority";
  }
  if (path.startsWith(".cosia-gateway/") || path === ".cosia-gateway") {
    return "connector_authority";
  }
  if (/^agents\/[^/]+\/manifest\.json$/.test(path)) {
    return "permission_boundary";
  }
  return "policy_security_gate";
}
