export type ToolCategory = "core" | "bundled";
export type ToolExposure = "model" | "cli_only" | "internal";
export type ToolWorkspaceBoundary = "inside_only";
export type ToolCatalogPermission =
  | "read_only"
  | "write_local"
  | "project_check"
  | "shell_request"
  | "destructive"
  | "network"
  | "external_send"
  | "shell";

export type ToolCatalogEntry = {
  id: string;
  category: ToolCategory;
  extensionId: "core" | "git" | "npm" | string;
  permission: ToolCatalogPermission;
  workspaceBoundary: ToolWorkspaceBoundary;
  defaultEnabled: boolean;
  defaultAgentAllow: boolean;
  exposure: ToolExposure;
  description: string;
};

export const toolCatalog = {
  read_file: {
    id: "read_file",
    category: "core",
    extensionId: "core",
    permission: "read_only",
    workspaceBoundary: "inside_only",
    defaultEnabled: true,
    defaultAgentAllow: true,
    exposure: "model",
    description: "Read a file inside the workspace."
  },
  write_file: {
    id: "write_file",
    category: "core",
    extensionId: "core",
    permission: "write_local",
    workspaceBoundary: "inside_only",
    defaultEnabled: true,
    defaultAgentAllow: true,
    exposure: "model",
    description: "Write a file inside the workspace through policy gates."
  },
  search_files: {
    id: "search_files",
    category: "core",
    extensionId: "core",
    permission: "read_only",
    workspaceBoundary: "inside_only",
    defaultEnabled: true,
    defaultAgentAllow: true,
    exposure: "model",
    description: "Search workspace files by path or content."
  },
  shell_request: {
    id: "shell_request",
    category: "core",
    extensionId: "core",
    permission: "shell_request",
    workspaceBoundary: "inside_only",
    defaultEnabled: true,
    defaultAgentAllow: true,
    exposure: "model",
    description: "Create a one-shot user-reviewable shell approval preview without executing it."
  }
} as const satisfies Record<string, ToolCatalogEntry>;

export type CatalogToolId = keyof typeof toolCatalog;
export type BundledToolId = {
  [K in CatalogToolId]: typeof toolCatalog[K]["category"] extends "bundled" ? K : never
}[CatalogToolId] | string;
export type CoreToolId = {
  [K in CatalogToolId]: typeof toolCatalog[K]["category"] extends "core" ? K : never
}[CatalogToolId];

export const toolNameValues = Object.keys(toolCatalog) as [CatalogToolId, ...CatalogToolId[]];
export const bundledToolIds = toolNameValues.filter(isBundledToolId) as string[];
export const coreToolIds = toolNameValues.filter(isCoreToolId) as CoreToolId[];
export const modelExposedToolIds = toolNameValues.filter((id) => toolCatalog[id].exposure === "model") as CatalogToolId[];
export const defaultAgentToolIds = toolNameValues.filter((id) => toolCatalog[id].defaultAgentAllow) as CatalogToolId[];

export type CatalogMetadataIssue = {
  id: string;
  message: string;
};

export function validateToolCatalogMetadata(): CatalogMetadataIssue[] {
  const issues: CatalogMetadataIssue[] = [];
  const seen = new Set<string>();
  for (const [key, entry] of Object.entries(toolCatalog)) {
    if (seen.has(entry.id)) {
      issues.push({ id: "tool_catalog.duplicate_id", message: `Duplicate tool id: ${entry.id}` });
    }
    seen.add(entry.id);
    if (key !== entry.id) {
      issues.push({ id: "tool_catalog.key_mismatch", message: `Tool catalog key ${key} does not match id ${entry.id}.` });
    }
    if (!entry.extensionId.trim()) {
      issues.push({ id: "tool_catalog.extension_missing", message: `Tool ${entry.id} is missing extensionId.` });
    }
    if (!["core", "bundled"].includes(entry.category)) {
      issues.push({ id: "tool_catalog.category_invalid", message: `Tool ${entry.id} has invalid category.` });
    }
    if (!["model", "cli_only", "internal"].includes(entry.exposure)) {
      issues.push({ id: "tool_catalog.exposure_invalid", message: `Tool ${entry.id} has invalid exposure.` });
    }
  }
  return issues;
}

export function getToolCatalogEntry(id: CatalogToolId): ToolCatalogEntry {
  return toolCatalog[id];
}

export function isToolId(value: string): value is CatalogToolId {
  return Object.prototype.hasOwnProperty.call(toolCatalog, value);
}

export function isBundledToolId(value: string): value is BundledToolId {
  const entry = (toolCatalog as Record<string, ToolCatalogEntry>)[value];
  return Boolean(entry) && entry.category === "bundled";
}

export function isCoreToolId(value: string): value is CoreToolId {
  return Object.prototype.hasOwnProperty.call(toolCatalog, value)
    && toolCatalog[value as CatalogToolId].category === "core";
}

export function bundledToolDefaults(): Record<BundledToolId, { enabled: boolean }> {
  return Object.fromEntries(
    bundledToolIds.map((id) => [id, { enabled: (toolCatalog as Record<string, ToolCatalogEntry>)[id].defaultEnabled }])
  ) as Record<BundledToolId, { enabled: boolean }>;
}
