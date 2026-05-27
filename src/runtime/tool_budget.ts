import { runtimeCommandDefinitionById, type RuntimeCommandSafety } from "./runtime_command_catalog.js";
import { getActiveToolRecord } from "./tool_acquisition.js";
import { isToolId, toolCatalog, type ToolCatalogPermission } from "./tool_catalog.js";
import type { ToolName, ToolResult } from "./types.js";

export type ToolBudgetLane = "observation" | "action" | "gated";

export type ToolBudgetClassification = {
  lane: ToolBudgetLane;
  reason: string;
  toolName: ToolName;
  runtimeCommandId?: string;
  runtimeCommandSafety?: RuntimeCommandSafety;
};

export type ToolLoopBudgetState = {
  observationRemaining: number;
  actionRemaining: number;
  repairObservationRemaining: number;
  verificationRemaining: number;
  totalHardCapRemaining: number;
  repairObservationOpen: boolean;
  verificationOpen: boolean;
};

export type ToolLoopBudgetSnapshot = ToolLoopBudgetState & {
  observationExhausted: boolean;
  actionExhausted: boolean;
  totalHardCapExhausted: boolean;
};

export const defaultToolLoopBudget = {
  observationBase: 5,
  action: 2,
  repairObservation: 3,
  verification: 2,
  totalHardCap: 12
} as const;

export type ToolBudgetConsumeResult =
  | { allowed: true; consumedLane: "observation" | "action" | "repair_observation" | "verification" | "gated" }
  | { allowed: false; reason: string; message: string };

export function createToolLoopBudget(): ToolLoopBudgetState {
  return {
    observationRemaining: defaultToolLoopBudget.observationBase,
    actionRemaining: defaultToolLoopBudget.action,
    repairObservationRemaining: defaultToolLoopBudget.repairObservation,
    verificationRemaining: defaultToolLoopBudget.verification,
    totalHardCapRemaining: defaultToolLoopBudget.totalHardCap,
    repairObservationOpen: false,
    verificationOpen: false
  };
}

export function snapshotToolLoopBudget(state: ToolLoopBudgetState): ToolLoopBudgetSnapshot {
  return {
    ...state,
    observationExhausted: state.observationRemaining <= 0
      && (!state.repairObservationOpen || state.repairObservationRemaining <= 0)
      && (!state.verificationOpen || state.verificationRemaining <= 0),
    actionExhausted: state.actionRemaining <= 0,
    totalHardCapExhausted: state.totalHardCapRemaining <= 0
  };
}

export function classifyToolBudgetCall(
  workspaceRoot: string,
  toolName: ToolName,
  args: unknown
): ToolBudgetClassification {
  if (toolName === "cosia_runtime_command") {
    return classifyRuntimeCommandTool(toolName, args);
  }
  const permission = toolPermissionForBudget(workspaceRoot, toolName);
  return {
    lane: budgetLaneForPermission(permission),
    reason: `tool permission ${permission}`,
    toolName
  };
}

export function consumeToolBudget(
  state: ToolLoopBudgetState,
  classification: ToolBudgetClassification
): ToolBudgetConsumeResult {
  if (state.totalHardCapRemaining <= 0) {
    return {
      allowed: false,
      reason: "total_hard_cap_exhausted",
      message: "Runtime rejection: total tool hard cap is exhausted. Return a final answer now using the available tool results. Do not call another tool."
    };
  }

  if (classification.lane === "observation") {
    if (state.observationRemaining > 0) {
      state.observationRemaining -= 1;
      state.totalHardCapRemaining -= 1;
      return { allowed: true, consumedLane: "observation" };
    }
    if (state.repairObservationOpen && state.repairObservationRemaining > 0) {
      state.repairObservationRemaining -= 1;
      state.totalHardCapRemaining -= 1;
      return { allowed: true, consumedLane: "repair_observation" };
    }
    if (state.verificationOpen && state.verificationRemaining > 0) {
      state.verificationRemaining -= 1;
      state.totalHardCapRemaining -= 1;
      return { allowed: true, consumedLane: "verification" };
    }
    state.totalHardCapRemaining -= 1;
    return {
      allowed: false,
      reason: "observation_budget_exhausted",
      message: "Runtime rejection: observation budget is exhausted. Remaining valid choices are action or final answer unless repair/verification observation budget is open. Do not call another observation tool."
    };
  }

  if (classification.lane === "action") {
    if (state.actionRemaining > 0) {
      state.actionRemaining -= 1;
      state.totalHardCapRemaining -= 1;
      return { allowed: true, consumedLane: "action" };
    }
    state.totalHardCapRemaining -= 1;
    return {
      allowed: false,
      reason: "action_budget_exhausted",
      message: "Runtime rejection: action budget is exhausted. Return a final answer from the available results, or ask only for required missing input."
    };
  }

  state.totalHardCapRemaining -= 1;
  return { allowed: true, consumedLane: "gated" };
}

export function recordToolBudgetResult(
  state: ToolLoopBudgetState,
  classification: ToolBudgetClassification,
  result: ToolResult
): void {
  if (classification.lane !== "action") {
    return;
  }
  const actionState = classifyActionResult(result);
  if (actionState === "verification") {
    state.verificationOpen = true;
  } else if (actionState === "repair_observation") {
    state.repairObservationOpen = true;
  }
}

function classifyRuntimeCommandTool(toolName: ToolName, args: unknown): ToolBudgetClassification {
  const commandId = commandIdFromArgs(args);
  if (!commandId) {
    return {
      lane: "gated",
      reason: "cosia_runtime_command missing commandId",
      toolName
    };
  }
  const definition = runtimeCommandDefinitionById(commandId);
  if (!definition) {
    return {
      lane: "gated",
      reason: `unknown runtime command ${commandId}`,
      toolName,
      runtimeCommandId: commandId
    };
  }
  return {
    lane: budgetLaneForRuntimeCommandSafety(definition.safety),
    reason: `runtime command safety ${definition.safety}`,
    toolName,
    runtimeCommandId: definition.commandId,
    runtimeCommandSafety: definition.safety
  };
}

function commandIdFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const value = (args as Record<string, unknown>).commandId;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toolPermissionForBudget(workspaceRoot: string, toolName: ToolName): ToolCatalogPermission {
  if (isToolId(toolName)) {
    return toolCatalog[toolName].permission;
  }
  const active = getActiveToolRecord(workspaceRoot, toolName);
  return active?.permission ?? "read_only";
}

function budgetLaneForPermission(permission: ToolCatalogPermission): ToolBudgetLane {
  switch (permission) {
    case "read_only":
    case "project_check":
      return "observation";
    case "write_local":
    case "shell_request":
    case "destructive":
    case "network":
    case "external_send":
    case "shell":
      return "action";
  }
}

function budgetLaneForRuntimeCommandSafety(safety: RuntimeCommandSafety): ToolBudgetLane {
  switch (safety) {
    case "read_only":
      return "observation";
    case "preview_mutation":
    case "mutation":
    case "system_boundary":
    case "dangerous":
      return "action";
  }
}

function classifyActionResult(result: ToolResult): "none" | "repair_observation" | "verification" {
  const runtimeCommandStatus = parseRuntimeCommandStatus(result.content);
  if (runtimeCommandStatus === "ok") {
    return "verification";
  }
  if (runtimeCommandStatus === "blocked" || runtimeCommandStatus === "needs_input" || runtimeCommandStatus === "failed") {
    return "none";
  }
  if (result.ok) {
    return "verification";
  }
  const content = result.content.toLowerCase();
  if (isRejectedActionContent(content)) {
    return "none";
  }
  if (/(current[_ -]?content|required current content|conflict|stale|needs[_ -]?input)/i.test(result.content)) {
    return "repair_observation";
  }
  return "none";
}

function parseRuntimeCommandStatus(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { status?: unknown };
    return typeof parsed.status === "string" ? parsed.status : undefined;
  } catch {
    return undefined;
  }
}

function isRejectedActionContent(content: string): boolean {
  return content.includes("blocked")
    || content.includes("denied")
    || content.includes("not allowed")
    || content.includes("forbidden")
    || content.includes("invalid")
    || content.includes("outside workspace")
    || content.includes("protected codex")
    || content.includes("system-level boundary")
    || content.includes("final user approval")
    || content.includes("policy")
    || content.includes("approval is pending")
    || content.includes("overwrite denied");
}
