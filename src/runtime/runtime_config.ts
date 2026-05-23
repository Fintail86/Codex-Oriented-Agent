import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ensureDir, readText, writeText } from "./fs_utils.js";
import {
  bundledToolDefaults,
  bundledToolIds,
  toolCatalog,
  validateToolCatalogMetadata,
  isBundledToolId,
  type BundledToolId
} from "./tool_catalog.js";

const promptOverflowPolicySchema = z.literal("truncate_low_priority");
const providerTypeSchema = z.enum(["codex-cli", "openai-compatible"]);
const providerResponseFormatSchema = z.enum(["json_object"]).nullable();

export const providerConfigSchema = z.object({
  type: providerTypeSchema.optional(),
  enabled: z.boolean(),
  sandbox: z.string().optional(),
  baseUrl: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  apiKeyEnv: z.string().min(1).default("OPENAI_API_KEY"),
  endpointPath: z.string().min(1).default("/chat/completions"),
  timeoutMs: z.number().int().positive().default(120000),
  structuredRetryCount: z.number().int().min(0).max(5).default(1),
  maxPromptChars: z.number().int().positive().default(60000),
  responseFormat: providerResponseFormatSchema.default(null),
  extraHeaders: z.record(z.string(), z.string()).default({})
});

export const promptBudgetSchema = z.object({
  maxPromptChars: z.number().int().positive(),
  refMemoryMaxItems: z.number().int().positive(),
  contextTailChars: z.number().int().positive(),
  contextWarningChars: z.number().int().positive().default(30000),
  contextCriticalChars: z.number().int().positive().default(60000),
  toolResultsMaxChars: z.number().int().positive(),
  skillMaxItems: z.number().int().positive().default(5),
  skillMaxChars: z.number().int().positive().default(8000),
  skillItemMaxChars: z.number().int().positive().default(2000),
  overflowPolicy: promptOverflowPolicySchema
});

export const modelConfigSchema = z.object({
  defaultProvider: z.string().min(1),
  providers: z.record(z.string(), providerConfigSchema)
});

export const telegramConnectorSchema = z.object({
  enabled: z.boolean().default(false),
  tokenEnv: z.string().min(1).default("TELEGRAM_BOT_TOKEN"),
  allowedChatIds: z.array(z.string()).default([]),
  defaultProvider: z.string().min(1).default("codex-cli"),
  allowMutations: z.boolean().default(true),
  blockDangerous: z.boolean().default(true),
  messageChunkChars: z.number().int().positive().default(3500),
  pollTimeoutMs: z.number().int().positive().default(30000),
  maxConsecutiveFailures: z.number().int().positive().default(10),
  backoffInitialMs: z.number().int().nonnegative().default(1000),
  backoffMaxMs: z.number().int().positive().default(30000)
});

export const connectorsConfigSchema = z.object({
  telegram: telegramConnectorSchema
});

export const reviewRetentionSchema = z.object({
  discardedRetentionDays: z.number().int().nonnegative().default(7),
  pendingWarningDays: z.number().int().nonnegative().default(14),
  autoCleanupOnRead: z.boolean().default(true)
});

export const bundledToolRuntimeConfigSchema = z.object({
  enabled: z.boolean()
}).strict();

export const runtimeToolsConfigSchema = z.object({
  bundled: z.record(z.string(), bundledToolRuntimeConfigSchema).default({})
}).strict();

export const runtimeConfigSchema = z.object({
  promptBudget: promptBudgetSchema,
  model: modelConfigSchema,
  connectors: connectorsConfigSchema,
  review: reviewRetentionSchema,
  tools: runtimeToolsConfigSchema
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export type RuntimeConfigIssue = {
  severity: "info" | "warning" | "high";
  id: string;
  path: string;
  message: string;
};

export type RuntimeConfigLoadResult = {
  config: RuntimeConfig;
  effectiveConfig: RuntimeConfig;
  sources: Record<string, string>;
  issues: RuntimeConfigIssue[];
};

export type RuntimeConfigMigration = {
  changed: boolean;
  policyPath: string;
  policyMarkdownPath: string;
  defaultsPath: string;
  localPath: string;
  lawPolicy: Record<string, unknown>;
  runtimeDefaults: RuntimeConfig;
  runtimeLocal: PartialRuntimeConfig;
  preview: string;
};

type JsonObject = Record<string, unknown>;
export type PartialRuntimeConfig = DeepPartial<RuntimeConfig>;

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? U[]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export const defaultRuntimeConfig: RuntimeConfig = {
  promptBudget: {
    maxPromptChars: 60000,
    refMemoryMaxItems: 8,
    contextTailChars: 6000,
    contextWarningChars: 30000,
    contextCriticalChars: 60000,
    toolResultsMaxChars: 12000,
    skillMaxItems: 5,
    skillMaxChars: 8000,
    skillItemMaxChars: 2000,
    overflowPolicy: "truncate_low_priority"
  },
  model: {
    defaultProvider: "codex-cli",
    providers: {
      "codex-cli": {
        type: "codex-cli",
        enabled: true,
        sandbox: "read-only",
        baseUrl: null,
        model: null,
        apiKeyEnv: "OPENAI_API_KEY",
        endpointPath: "/chat/completions",
        timeoutMs: 120000,
        structuredRetryCount: 1,
        maxPromptChars: 60000,
        responseFormat: null,
        extraHeaders: {}
      },
      "openai-compatible": {
        type: "openai-compatible",
        enabled: false,
        baseUrl: null,
        model: null,
        apiKeyEnv: "OPENAI_API_KEY",
        endpointPath: "/chat/completions",
        timeoutMs: 120000,
        structuredRetryCount: 1,
        maxPromptChars: 60000,
        responseFormat: null,
        extraHeaders: {}
      },
      openrouter: {
        type: "openai-compatible",
        enabled: false,
        baseUrl: "https://openrouter.ai/api/v1",
        model: null,
        apiKeyEnv: "OPENROUTER_API_KEY",
        endpointPath: "/chat/completions",
        timeoutMs: 120000,
        structuredRetryCount: 1,
        maxPromptChars: 60000,
        responseFormat: "json_object",
        extraHeaders: {
          "HTTP-Referer": "https://github.com/Fintail86/Codex-Oriented-Agent",
          "X-OpenRouter-Title": "COSIA"
        }
      }
    }
  },
  connectors: {
    telegram: {
      enabled: false,
      tokenEnv: "TELEGRAM_BOT_TOKEN",
      allowedChatIds: [],
      defaultProvider: "codex-cli",
      allowMutations: true,
      blockDangerous: true,
      messageChunkChars: 3500,
      pollTimeoutMs: 30000,
      maxConsecutiveFailures: 10,
      backoffInitialMs: 1000,
      backoffMaxMs: 30000
    }
  },
  review: {
    discardedRetentionDays: 7,
    pendingWarningDays: 14,
    autoCleanupOnRead: true
  },
  tools: {
    bundled: bundledToolDefaults()
  }
};

const RUNTIME_KEYS = ["promptBudget", "model", "connectors", "review"] as const;

export async function ensureRuntimeDefaults(workspaceRoot: string): Promise<string[]> {
  await ensureDir(configDir(workspaceRoot));
  if (existsSync(runtimeDefaultsPath(workspaceRoot))) {
    const raw = await readJsonIfExists(runtimeDefaultsPath(workspaceRoot));
    const repaired = repairRuntimeDefaults(raw);
    if (JSON.stringify(raw) !== JSON.stringify(repaired)) {
      await writeText(runtimeDefaultsPath(workspaceRoot), `${JSON.stringify(repaired, null, 2)}\n`);
      return ["config/runtime.defaults.json"];
    }
    return [];
  }
  await writeText(runtimeDefaultsPath(workspaceRoot), `${JSON.stringify(defaultRuntimeConfig, null, 2)}\n`);
  return ["config/runtime.defaults.json"];
}

export async function loadRuntimeConfig(workspaceRoot: string, legacyPolicyRaw?: unknown): Promise<RuntimeConfigLoadResult> {
  const sources: Record<string, string> = {};
  let merged = clone(defaultRuntimeConfig) as JsonObject;
  markSources(defaultRuntimeConfig, "built-in", sources);

  const defaultsRaw = await readJsonIfExists(runtimeDefaultsPath(workspaceRoot));
  if (defaultsRaw) {
    const parsedDefaults = isObject(defaultsRaw) ? defaultsRaw : {};
    merged = deepMerge(merged, parsedDefaults) as JsonObject;
    markSources(parsedDefaults, "runtime.defaults.json", sources);
  }

  const legacy = extractLegacyRuntimeConfig(legacyPolicyRaw);
  if (Object.keys(legacy).length) {
    merged = deepMerge(merged, legacy) as JsonObject;
    markSources(legacy, "legacy POLICY.json", sources);
  }

  const localRaw = await readJsonIfExists(runtimeLocalPath(workspaceRoot));
  if (localRaw) {
    const parsedLocal = isObject(localRaw) ? localRaw : {};
    merged = deepMerge(merged, parsedLocal) as JsonObject;
    markSources(parsedLocal, "runtime.local.json", sources);
  }

  const config = normalizeRuntimeConfig(runtimeConfigSchema.parse(merged));
  const issues = [
    ...collectSecretIssues(defaultsRaw, "config/runtime.defaults.json"),
    ...collectSecretIssues(localRaw, "config/runtime.local.json"),
    ...collectPersonalDefaultsIssues(defaultsRaw),
    ...collectBundledToolIssues(defaultsRaw, "config/runtime.defaults.json"),
    ...collectBundledToolIssues(localRaw, "config/runtime.local.json"),
    ...collectToolCatalogIssues()
  ];
  return {
    config,
    effectiveConfig: config,
    sources,
    issues
  };
}

export function normalizeRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  const providers = { ...config.model.providers };
  for (const [id, provider] of Object.entries(providers)) {
    providers[id] = {
      ...provider,
      type: provider.type ?? defaultProviderType(id),
      responseFormat: provider.responseFormat ?? null,
      extraHeaders: provider.extraHeaders ?? {}
    };
  }
  if (!providers.openrouter) {
    providers.openrouter = defaultRuntimeConfig.model.providers.openrouter;
  }
  return runtimeConfigSchema.parse({
    ...config,
    model: {
      ...config.model,
      providers
    },
    connectors: {
      telegram: {
        ...defaultRuntimeConfig.connectors.telegram,
        ...config.connectors.telegram
      }
    },
    review: {
      ...defaultRuntimeConfig.review,
      ...config.review
    },
    tools: {
      bundled: {
        ...defaultRuntimeConfig.tools.bundled,
        ...config.tools.bundled
      }
    }
  });
}

export function extractLegacyRuntimeConfig(raw: unknown): PartialRuntimeConfig {
  if (!isObject(raw)) {
    return {};
  }
  const result: JsonObject = {};
  for (const key of RUNTIME_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      result[key] = raw[key];
    }
  }
  return result as PartialRuntimeConfig;
}

export function stripRuntimeConfig(raw: unknown): Record<string, unknown> {
  if (!isObject(raw)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(RUNTIME_KEYS as readonly string[]).includes(key)) {
      result[key] = value;
    }
  }
  return result;
}

export function deepMerge(...values: unknown[]): unknown {
  let result: unknown = {};
  for (const value of values) {
    result = mergeValue(result, value);
  }
  return result;
}

export async function buildRuntimeConfigMigration(workspaceRoot: string): Promise<RuntimeConfigMigration> {
  const raw = JSON.parse(await readText(policyJsonPath(workspaceRoot))) as JsonObject;
  const legacy = extractLegacyRuntimeConfig(raw);
  const hasLegacyRuntime = Object.keys(legacy).length > 0;
  const legacyToolLocal = localConfigFromLegacyPolicyTools(raw);
  const lawPolicy = stripRuntimeConfig(raw);
  lawPolicy.version = "0.37.0";
  removeBundledPolicyTools(lawPolicy);
  const existingDefaults = await readJsonIfExists(runtimeDefaultsPath(workspaceRoot));
  const existingLocal = await readJsonIfExists(runtimeLocalPath(workspaceRoot));
  const runtimeDefaults = hasLegacyRuntime
    ? normalizeRuntimeConfig(runtimeConfigSchema.parse({
      ...defaultRuntimeConfig,
      promptBudget: isObject(legacy.promptBudget) ? legacy.promptBudget : defaultRuntimeConfig.promptBudget,
      review: isObject(legacy.review) ? legacy.review : defaultRuntimeConfig.review
    }))
    : normalizeRuntimeConfig(runtimeConfigSchema.parse(deepMerge(defaultRuntimeConfig, existingDefaults ?? {})));
  const runtimeLocal = hasLegacyRuntime
    ? localConfigFromLegacy(legacy)
    : (isObject(existingLocal) ? existingLocal as PartialRuntimeConfig : {});
  const mergedRuntimeLocal = deepMerge(runtimeLocal, legacyToolLocal) as PartialRuntimeConfig;
  const changed = JSON.stringify(raw) !== JSON.stringify(lawPolicy)
    || JSON.stringify(existingDefaults ?? null) !== JSON.stringify(runtimeDefaults)
    || JSON.stringify(existingLocal ?? {}) !== JSON.stringify(mergedRuntimeLocal);
  const migration = {
    changed,
    policyPath: policyJsonPath(workspaceRoot),
    policyMarkdownPath: join(workspaceRoot, "codex", "POLICY.md"),
    defaultsPath: runtimeDefaultsPath(workspaceRoot),
    localPath: runtimeLocalPath(workspaceRoot),
    lawPolicy,
    runtimeDefaults,
    runtimeLocal: mergedRuntimeLocal,
    preview: ""
  };
  return {
    ...migration,
    preview: formatConfigMigration(migration)
  };
}

export async function applyRuntimeConfigMigration(workspaceRoot: string): Promise<RuntimeConfigMigration> {
  const migration = await buildRuntimeConfigMigration(workspaceRoot);
  runtimeConfigSchema.parse(migration.runtimeDefaults);
  runtimeConfigSchema.parse(deepMerge(defaultRuntimeConfig, migration.runtimeLocal));
  await writeText(migration.policyPath, `${JSON.stringify(migration.lawPolicy, null, 2)}\n`);
  await writeText(migration.defaultsPath, `${JSON.stringify(migration.runtimeDefaults, null, 2)}\n`);
  if (Object.keys(migration.runtimeLocal).length) {
    await writeText(migration.localPath, `${JSON.stringify(migration.runtimeLocal, null, 2)}\n`);
  }
  return {
    ...migration,
    changed: true,
    preview: formatConfigMigration({ ...migration, changed: true })
  };
}

export async function formatConfigShow(workspaceRoot: string, legacyPolicyRaw?: unknown): Promise<string> {
  const result = await loadRuntimeConfig(workspaceRoot, legacyPolicyRaw);
  const rows = [
    ["promptBudget.maxPromptChars", String(result.config.promptBudget.maxPromptChars)],
    ["promptBudget.contextTailChars", String(result.config.promptBudget.contextTailChars)],
    ["model.defaultProvider", result.config.model.defaultProvider],
    ["model.providers.codex-cli.enabled", String(result.config.model.providers["codex-cli"]?.enabled ?? false)],
    ["model.providers.openrouter.enabled", String(result.config.model.providers.openrouter?.enabled ?? false)],
    ["model.providers.openrouter.model", result.config.model.providers.openrouter?.model ?? "null"],
    ["connectors.telegram.enabled", String(result.config.connectors.telegram.enabled)],
    ["connectors.telegram.allowedChatIds", String(result.config.connectors.telegram.allowedChatIds.length)],
    ["connectors.telegram.messageChunkChars", String(result.config.connectors.telegram.messageChunkChars)],
    ["review.discardedRetentionDays", String(result.config.review.discardedRetentionDays)],
    ["review.pendingWarningDays", String(result.config.review.pendingWarningDays)],
    ...Object.keys(result.config.tools.bundled)
      .sort((left, right) => {
        const leftExtension = toolCatalog[left as keyof typeof toolCatalog]?.extensionId ?? "";
        const rightExtension = toolCatalog[right as keyof typeof toolCatalog]?.extensionId ?? "";
        return leftExtension.localeCompare(rightExtension) || left.localeCompare(right);
      })
      .map((id) => [`tools.bundled.${id}.enabled`, String(result.config.tools.bundled[id]?.enabled ?? false)])
  ];
  return [
    "COSIA Runtime Config",
    "",
    "Merged values:",
    "Path                                      Value                 Source",
    ...rows.map(([path, value]) => `${path.padEnd(41)} ${value.padEnd(21)} ${result.sources[path] ?? "built-in"}`),
    "",
    "Effective config:",
    "Runtime config cannot relax Codex law. No policy-constrained overrides are active.",
    "",
    result.issues.length ? formatConfigIssues(result.issues) : "Issues: none"
  ].join("\n");
}

export async function formatConfigCheck(workspaceRoot: string, legacyPolicyRaw?: unknown): Promise<string> {
  let result: RuntimeConfigLoadResult;
  try {
    result = await loadRuntimeConfig(workspaceRoot, legacyPolicyRaw);
  } catch (error) {
    return [
      "Config: warning",
      `runtime.defaults.json: ${existsSync(runtimeDefaultsPath(workspaceRoot)) ? "present" : "missing; using built-in defaults"}`,
      `runtime.local.json: ${existsSync(runtimeLocalPath(workspaceRoot)) ? "present" : "missing"}`,
      "Schema: failed",
      "Issues:",
      `- [high] config.schema runtime config: ${(error as Error).message}`
    ].join("\n");
  }
  const high = result.issues.filter((issue) => issue.severity === "high");
  return [
    `Config: ${high.length ? "warning" : "ok"}`,
    `runtime.defaults.json: ${existsSync(runtimeDefaultsPath(workspaceRoot)) ? "present" : "missing; using built-in defaults"}`,
    `runtime.local.json: ${existsSync(runtimeLocalPath(workspaceRoot)) ? "present" : "missing"}`,
    "Schema: ok",
    result.issues.length ? formatConfigIssues(result.issues) : "Issues: none"
  ].join("\n");
}

export function formatConfigMigration(migration: RuntimeConfigMigration): string {
  const localKeys = summarizeKeys(migration.runtimeLocal);
  return [
    "Runtime config migration preview",
    `Changed: ${migration.changed}`,
    "",
    "Writes on --yes:",
    `- Law policy: ${migration.policyPath}`,
    `- Policy mirror: ${migration.policyMarkdownPath}`,
    `- Runtime defaults: ${migration.defaultsPath}`,
    Object.keys(migration.runtimeLocal).length ? `- Runtime local: ${migration.localPath}` : "- Runtime local: not needed",
    "",
    "Moved to runtime.defaults.json:",
    "- promptBudget",
    "- review retention",
    "- disabled provider/connector templates",
    "- bundled tool defaults",
    "",
    "Moved to runtime.local.json:",
    localKeys.length ? localKeys.map((key) => `- ${key}`).join("\n") : "- none",
    "",
    migration.changed ? "Re-run with --yes to apply." : "Already migrated."
  ].join("\n");
}

function localConfigFromLegacy(legacy: PartialRuntimeConfig): PartialRuntimeConfig {
  const local: PartialRuntimeConfig = {};
  if (legacy.model) {
    const modelLocal: PartialRuntimeConfig["model"] = {};
    if (legacy.model.defaultProvider && legacy.model.defaultProvider !== defaultRuntimeConfig.model.defaultProvider) {
      modelLocal.defaultProvider = legacy.model.defaultProvider;
    }
    const providerEntries = Object.entries(legacy.model.providers ?? {});
    const localProviders: RuntimeConfig["model"]["providers"] = {};
    for (const [id, provider] of providerEntries) {
      if (!provider) {
        continue;
      }
      const baseline = defaultRuntimeConfig.model.providers[id];
      if (provider.enabled || provider.model || provider.baseUrl !== baseline?.baseUrl || provider.timeoutMs !== baseline?.timeoutMs) {
        localProviders[id] = providerConfigSchema.parse(provider);
      }
    }
    if (Object.keys(localProviders).length) {
      modelLocal.providers = localProviders;
    }
    if (Object.keys(modelLocal).length) {
      local.model = modelLocal;
    }
  }
  if (legacy.connectors?.telegram) {
    const telegram = telegramConnectorSchema.parse(legacy.connectors.telegram);
    if (
      telegram.enabled
      || telegram.allowedChatIds.length
      || telegram.defaultProvider !== defaultRuntimeConfig.connectors.telegram.defaultProvider
      || telegram.tokenEnv !== defaultRuntimeConfig.connectors.telegram.tokenEnv
    ) {
      local.connectors = { telegram };
    }
  }
  return local;
}

function localConfigFromLegacyPolicyTools(raw: unknown): PartialRuntimeConfig {
  if (!isObject(raw) || !isObject(raw.tools)) {
    return {};
  }
  const bundled: Partial<Record<BundledToolId, { enabled: boolean }>> = {};
  for (const id of bundledToolIds) {
    const tool = raw.tools[id];
    if (isObject(tool) && typeof tool.enabled === "boolean" && tool.enabled !== defaultRuntimeConfig.tools.bundled[id].enabled) {
      bundled[id] = { enabled: tool.enabled };
    }
  }
  if (!Object.keys(bundled).length) {
    return {};
  }
  return {
    tools: {
      bundled
    }
  } as PartialRuntimeConfig;
}

function removeBundledPolicyTools(policy: Record<string, unknown>): void {
  if (!isObject(policy.tools)) {
    return;
  }
  for (const id of bundledToolIds) {
    delete policy.tools[id];
  }
  for (const id of ["git_status", "git_diff", "git_log", "npm_test", "npm_typecheck"]) {
    delete policy.tools[id];
  }
}

function mergeValue(base: unknown, override: unknown): unknown {
  if (override === undefined) {
    return clone(base);
  }
  if (override === null || typeof override !== "object") {
    return override;
  }
  if (Array.isArray(override)) {
    return clone(override);
  }
  if (!isObject(base)) {
    return clone(override);
  }
  const result: JsonObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = mergeValue(result[key], value);
  }
  return result;
}

function markSources(value: unknown, source: string, sources: Record<string, string>, prefix = ""): void {
  if (!isObject(value) || Array.isArray(value)) {
    if (prefix) {
      sources[prefix] = source;
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isObject(item) && !Array.isArray(item)) {
      markSources(item, source, sources, path);
    } else {
      sources[path] = source;
    }
  }
}

function collectSecretIssues(raw: unknown, label: string): RuntimeConfigIssue[] {
  const issues: RuntimeConfigIssue[] = [];
  visit(raw, (path, key, value) => {
    if (typeof value !== "string" || isEnvNameField(key)) {
      return;
    }
    if (isDefiniteSecret(value)) {
      issues.push({
        severity: "high",
        id: "config.secret_like_value",
        path: `${label}:${path}`,
        message: "Config contains a value that looks like a real secret. Use an environment variable instead."
      });
      return;
    }
    if (isWeakSecretKey(key) && value.trim() && !looksLikeEnvVarName(value)) {
      issues.push({
        severity: "warning",
        id: "config.secret_keyword",
        path: `${label}:${path}`,
        message: "Config key name is secret-like. Store only env var names, not secret values."
      });
    }
  });
  return issues;
}

function collectPersonalDefaultsIssues(raw: unknown): RuntimeConfigIssue[] {
  const parsed = runtimeConfigSchema.partial().safeParse(raw);
  if (!parsed.success) {
    return [];
  }
  const issues: RuntimeConfigIssue[] = [];
  const telegram = parsed.data.connectors?.telegram;
  if (telegram?.allowedChatIds?.length) {
    issues.push({
      severity: "warning",
      id: "config.personal_defaults",
      path: "config/runtime.defaults.json:connectors.telegram.allowedChatIds",
      message: "Telegram chat ids are personal values and should live in runtime.local.json."
    });
  }
  const openrouter = parsed.data.model?.providers?.openrouter;
  if (openrouter?.enabled || openrouter?.model) {
    issues.push({
      severity: "warning",
      id: "config.personal_defaults",
      path: "config/runtime.defaults.json:model.providers.openrouter",
      message: "Enabled external providers and model choices should usually live in runtime.local.json."
    });
  }
  return issues;
}

function collectBundledToolIssues(raw: unknown, label: string): RuntimeConfigIssue[] {
  if (!isObject(raw) || !isObject(raw.tools) || !isObject(raw.tools.bundled)) {
    return [];
  }
  const issues: RuntimeConfigIssue[] = [];
  for (const id of Object.keys(raw.tools.bundled)) {
    if (!isBundledToolId(id)) {
      issues.push({
        severity: "warning",
        id: "config.unknown_bundled_tool",
        path: `${label}:tools.bundled.${id}`,
        message: "Unknown bundled tool id. COSIA will ignore unknown bundled tool settings."
      });
    }
  }
  return issues;
}

function collectToolCatalogIssues(): RuntimeConfigIssue[] {
  return validateToolCatalogMetadata().map((issue) => ({
    severity: "high" as const,
    id: issue.id,
    path: "tool_catalog",
    message: issue.message
  }));
}

function repairRuntimeDefaults(raw: unknown): unknown {
  const repaired = isObject(raw) ? clone(raw) as JsonObject : {};
  if (!isObject(repaired.tools)) {
    repaired.tools = {};
  }
  const tools = repaired.tools as JsonObject;
  if (!isObject(tools.bundled)) {
    tools.bundled = {};
  }
  const bundled = tools.bundled as JsonObject;
  for (const [id, config] of Object.entries(defaultRuntimeConfig.tools.bundled)) {
    if (!Object.prototype.hasOwnProperty.call(bundled, id)) {
      bundled[id] = { enabled: config.enabled };
    }
  }
  return repaired;
}

function formatConfigIssues(issues: RuntimeConfigIssue[]): string {
  return [
    "Issues:",
    ...issues.map((issue) => `- [${issue.severity}] ${issue.id} ${issue.path}: ${issue.message}`)
  ].join("\n");
}

function summarizeKeys(value: unknown, prefix = ""): string[] {
  if (!isObject(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value).flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isObject(item) && !Array.isArray(item)) {
      return summarizeKeys(item, path);
    }
    return [path];
  });
}

function visit(value: unknown, callback: (path: string, key: string, value: unknown) => void, prefix = ""): void {
  if (!isObject(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    callback(path, key, item);
    if (isObject(item)) {
      visit(item, callback, path);
    }
  }
}

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(await readText(path)) as unknown;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultProviderType(id: string): "codex-cli" | "openai-compatible" {
  return id === "codex-cli" || id === "codex" ? "codex-cli" : "openai-compatible";
}

function isEnvNameField(key: string): boolean {
  return key === "apiKeyEnv" || key === "tokenEnv";
}

function looksLikeEnvVarName(value: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(value);
}

function isWeakSecretKey(key: string): boolean {
  return /token|secret|password|api.?key|private/i.test(key);
}

function isDefiniteSecret(value: string): boolean {
  return /sk-[A-Za-z0-9_-]{20,}/.test(value)
    || /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/.test(value)
    || /\bBearer\s+[A-Za-z0-9._-]{20,}/i.test(value)
    || /\bghp_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/.test(value)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value);
}

function configDir(workspaceRoot: string): string {
  return join(workspaceRoot, "config");
}

export function runtimeDefaultsPath(workspaceRoot: string): string {
  return join(configDir(workspaceRoot), "runtime.defaults.json");
}

export function runtimeLocalPath(workspaceRoot: string): string {
  return join(configDir(workspaceRoot), "runtime.local.json");
}

function policyJsonPath(workspaceRoot: string): string {
  return join(workspaceRoot, "codex", "POLICY.json");
}
