import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { gatewayRoleAtLeast } from "./gateway_auth.js";
import { detectSecrets } from "./risk_classifier.js";
import {
  detectRuntimeCommandTags,
  retrieveRuntimeCommandTagMatches,
  runtimeCommandDefinitionById,
  runtimeCommandDefinitions,
  validateRuntimeCommandArgs,
  type RuntimeCommandDefinition,
  type RuntimeCommandExecutionMode,
  type RuntimeCommandSafety
} from "./runtime_command_catalog.js";
import type { ToolContext, ToolResult } from "./types.js";

const execFileAsync = promisify(execFile);

const commandSafetySchema = z.enum(["read_only", "preview_mutation", "mutation", "system_boundary", "dangerous"]);
const optionalString = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());

const lookupArgsSchema = z.object({
  input: optionalString,
  commandId: optionalString,
  safety: z.preprocess((value) => value === "" ? undefined : value, commandSafetySchema.optional()),
  limit: z.preprocess((value) => {
    if (value === "" || value === undefined || value === null) return undefined;
    return Number(value);
  }, z.number().int().min(1).max(40).optional())
});

const runtimeCommandArgsSchema = z.object({
  commandId: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({})
});

type CliExecutionResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type CosiaCliExecutor = (argv: string[], options: { cwd: string }) => Promise<CliExecutionResult>;

let testCliExecutor: CosiaCliExecutor | undefined;
const outputMaxChars = 8000;
const dynamicArgMaxChars = 1000;

export function setCosiaCliExecutorForTests(executor: CosiaCliExecutor | undefined): void {
  testCliExecutor = executor;
}

export async function executeCosiaCliCommandLookup(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const roleGate = gatewayLookupGate(ctx);
  if (!roleGate.allowed) {
    return blocked("gateway_role_denied", roleGate.reason);
  }

  try {
    const parsed = lookupArgsSchema.parse(args);
    const limit = parsed.limit ?? 12;
    const detectedTags = parsed.input ? detectRuntimeCommandTags(parsed.input) : [];
    const candidates = lookupDefinitions(parsed, limit, ctx);
    return {
      ok: true,
      content: toJson({
        status: candidates.length ? "ok" : "no_match",
        input: parsed.input,
        commandId: parsed.commandId,
        detectedTags,
        candidates
      })
    };
  } catch (error) {
    return blocked("lookup_invalid_args", sanitizedError(error));
  }
}

export async function executeCosiaRuntimeCommand(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  try {
    const parsed = runtimeCommandArgsSchema.parse(args);
    if (isCliLikeCommandId(parsed.commandId)) {
      return blocked("cli_string_not_allowed", "cosia_runtime_command accepts only commandId + args, not CLI strings.");
    }

    const definition = runtimeCommandDefinitionById(parsed.commandId);
    if (!definition) {
      return blocked("unknown_command", `Unknown runtime command: ${parsed.commandId}`);
    }

    const mode = modelExecutionMode(definition);
    const privateMasterCliOverride = isPrivateMasterDirectChat(ctx);
    if (privateMasterCliOverride) {
      if (isForbiddenPrivateMasterCliCommand(definition)) {
        return blocked("private_master_cli_command_blocked", `Command remains blocked even for private master CLI execution: ${definition.commandId}`, definition);
      }
    } else {
      const roleGate = gatewayExecutionGate(ctx, mode);
      if (!roleGate.allowed) {
        return blocked("gateway_role_denied", roleGate.reason, definition);
      }
      if (definition.modelCallable !== true) {
        return blocked("not_model_callable", `Runtime command is not model-callable: ${definition.commandId}`, definition);
      }
      if (mode === "blocked") {
        return blocked("execution_mode_blocked", `Runtime command is blocked for model execution: ${definition.commandId}`, definition);
      }
      if (definition.safety !== "read_only" || mode !== "execute_read_only") {
        return blocked("unsafe_command_blocked", "Only read_only commands with execute_read_only mode can run through model-facing CLI execution in v0.54.", definition);
      }
      if (isForbiddenModelRuntimeCommand(definition)) {
        return blocked("forbidden_model_command", `Command is not allowed through model-facing runtime command: ${definition.commandId}`, definition);
      }
    }

    const invalid = validateRuntimeCommandArgs(definition.commandId, parsed.args);
    if (invalid?.type === "needs_input") {
      return {
        ok: true,
        content: toJson({
          status: "needs_input",
          commandId: invalid.commandId,
          missingArgs: invalid.missing,
          recoveryHint: invalid.hint
        })
      };
    }
    if (invalid) {
      return blocked("invalid_args", "Runtime command arguments are invalid.", definition);
    }

    const argValidation = validateDynamicArgs(parsed.args);
    if (!argValidation.allowed) {
      return blocked("invalid_dynamic_arg", argValidation.reason, definition);
    }

    const argv = bindArgvTemplate(definition, parsed.args);
    const execution = await runCosiaCli(argv, ctx.workspaceRoot);
    return {
      ok: execution.exitCode === 0,
      content: toJson({
        status: execution.exitCode === 0 ? "ok" : "failed",
        commandId: definition.commandId,
        cliDisplay: definition.cliDisplay,
        safety: definition.safety,
        modelExecutionMode: mode,
        privateMasterCliOverride,
        argv: sanitizeArgvForDisplay(argv),
        exitCode: execution.exitCode,
        stdout: sanitizeRuntimeCommandOutput(execution.stdout),
        stderr: sanitizeRuntimeCommandOutput(execution.stderr)
      })
    };
  } catch (error) {
    return blocked("runtime_command_error", sanitizedError(error));
  }
}

function lookupDefinitions(input: z.infer<typeof lookupArgsSchema>, limit: number, ctx: ToolContext): Array<Record<string, unknown>> {
  const matches = input.commandId
    ? definitionToMatches(runtimeCommandDefinitionById(input.commandId))
    : input.input
      ? retrieveRuntimeCommandTagMatches(input.input, limit)
      : runtimeCommandDefinitions.map((definition) => ({
          definition,
          score: 1,
          confidence: "low" as const,
          matchReason: "catalog listing"
        }));

  return matches
    .filter((match) => matchesLookupFilters(match.definition, input))
    .slice(0, limit)
    .map((match) => ({
      ...definitionView(match.definition, ctx),
      confidence: match.confidence,
      matchReason: match.matchReason
    }));
}

function definitionToMatches(definition: RuntimeCommandDefinition | undefined): ReturnType<typeof retrieveRuntimeCommandTagMatches> {
  if (!definition) {
    return [];
  }
  return [{
    definition,
    score: 20,
    confidence: "high",
    matchReason: "commandId exact match"
  }];
}

function matchesLookupFilters(definition: RuntimeCommandDefinition, input: z.infer<typeof lookupArgsSchema>): boolean {
  if (input.safety && definition.safety !== input.safety) {
    return false;
  }
  return true;
}

function definitionView(definition: RuntimeCommandDefinition, ctx?: ToolContext): Record<string, unknown> {
  const privateMasterCliOverrideAvailable = ctx ? isPrivateMasterDirectChat(ctx) && !isForbiddenPrivateMasterCliCommand(definition) : false;
  return {
    commandId: definition.commandId,
    cliDisplay: definition.cliDisplay,
    description: definition.description,
    safety: definition.safety,
    tags: definition.tags ?? [],
    argsSchema: definition.argsSchema,
    requiresApproval: definition.requiresApproval ?? false,
    modelCallable: definition.modelCallable ?? false,
    modelExecutionMode: modelExecutionMode(definition),
    privateMasterCliOverrideAvailable,
    modelHint: definition.modelHint,
    modelToolHint: definition.modelToolHint
  };
}

function bindArgvTemplate(definition: RuntimeCommandDefinition, args: Record<string, unknown>): string[] {
  const argv: string[] = [];
  for (const token of definition.argvTemplate) {
    const slot = token.match(/^\$([A-Za-z0-9_]+)(\?)?$/);
    if (!slot) {
      argv.push(token);
      continue;
    }
    const key = slot[1];
    const optional = Boolean(slot[2]);
    const value = args[key];
    const previous = argv[argv.length - 1];
    if (optional && previous?.startsWith("--") && typeof value === "boolean") {
      if (!value) {
        argv.pop();
      }
      continue;
    }
    if (value === undefined || value === null || value === "") {
      if (optional) {
        if (previous?.startsWith("--")) {
          argv.pop();
        }
        continue;
      }
      throw new Error(`Missing required argv slot: ${key}`);
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`Unsupported argv slot value type for ${key}.`);
    }
    argv.push(String(value));
  }
  return argv;
}

async function runCosiaCli(argv: string[], workspaceRoot: string): Promise<CliExecutionResult> {
  if (testCliExecutor) {
    return testCliExecutor(argv, { cwd: workspaceRoot });
  }
  const entrypoint = resolveCosiaCliEntrypoint(workspaceRoot);
  try {
    const result = await execFileAsync(process.execPath, [entrypoint, ...argv], {
      cwd: workspaceRoot,
      timeout: 60_000,
      maxBuffer: 512 * 1024,
      windowsHide: true
    });
    return {
      exitCode: 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message
    };
  }
}

function resolveCosiaCliEntrypoint(workspaceRoot: string): string {
  const bundled = fileURLToPath(new URL("../bin.js", import.meta.url));
  if (existsSync(bundled)) {
    return bundled;
  }
  const built = join(workspaceRoot, "dist", "src", "bin.js");
  if (existsSync(built)) {
    return built;
  }
  return bundled;
}

function validateDynamicArgs(args: Record<string, unknown>): { allowed: true } | { allowed: false; reason: string } {
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return { allowed: false, reason: `Argument ${key} must be a scalar value.` };
    }
    const text = String(value);
    if (text.length > dynamicArgMaxChars) {
      return { allowed: false, reason: `Argument ${key} exceeds ${dynamicArgMaxChars} characters.` };
    }
    if (detectSecrets(text).matched) {
      return { allowed: false, reason: `Argument ${key} looks secret-like and cannot be passed through model-facing CLI execution.` };
    }
  }
  return { allowed: true };
}

function gatewayLookupGate(ctx: ToolContext): { allowed: true } | { allowed: false; reason: string } {
  if (ctx.sourceChannel !== "gateway") {
    return { allowed: true };
  }
  if (!ctx.gatewayRole || !gatewayRoleAtLeast(ctx.gatewayRole, "admin")) {
    return { allowed: false, reason: "Gateway command lookup requires role admin or higher." };
  }
  return { allowed: true };
}

function gatewayExecutionGate(ctx: ToolContext, mode: RuntimeCommandExecutionMode): { allowed: true } | { allowed: false; reason: string } {
  if (ctx.sourceChannel !== "gateway") {
    return { allowed: true };
  }
  if (!ctx.gatewayRole) {
    return { allowed: false, reason: "Gateway runtime command denied: missing role." };
  }
  if (mode === "execute_read_only") {
    return gatewayRoleAtLeast(ctx.gatewayRole, "admin")
      ? { allowed: true }
      : { allowed: false, reason: `Gateway role ${ctx.gatewayRole} is below required role admin.` };
  }
  if (mode === "preview_only") {
    return gatewayRoleAtLeast(ctx.gatewayRole, "master")
      ? { allowed: true }
      : { allowed: false, reason: `Gateway role ${ctx.gatewayRole} is below required role master for preview commands.` };
  }
  return { allowed: false, reason: `Runtime command mode is blocked for gateway: ${mode}.` };
}

function isCliLikeCommandId(commandId: string): boolean {
  const value = commandId.trim();
  return value.startsWith("/")
    || value.startsWith("#")
    || /^cosia\s+/i.test(value)
    || /\s/.test(value);
}

function isPrivateMasterDirectChat(ctx: ToolContext): boolean {
  if (ctx.sourceChannel !== "gateway" || ctx.gatewayRole !== "master" || !ctx.gatewayActor) {
    return false;
  }
  const chatId = String(ctx.gatewayActor.chatId ?? "");
  const userId = String(ctx.gatewayActor.userId ?? "");
  return chatId.length > 0
    && userId.length > 0
    && chatId === userId
    && (ctx.gatewayActor.chatType ?? "private") === "private";
}

function isForbiddenModelRuntimeCommand(definition: RuntimeCommandDefinition): boolean {
  return definition.safety === "dangerous"
    || definition.safety === "system_boundary"
    || definition.commandId === "shell.preview"
    || definition.commandId === "pending.apply"
    || definition.commandId === "pending.cancel"
    || definition.commandId.startsWith("gateway.telegram.set")
    || definition.commandId.startsWith("gateway.telegram.unset")
    || definition.commandId.startsWith("shell.");
}

function isForbiddenPrivateMasterCliCommand(definition: RuntimeCommandDefinition): boolean {
  return definition.safety === "dangerous"
    || definition.safety === "system_boundary"
    || definition.commandId === "shell.preview"
    || definition.commandId === "pending.apply"
    || definition.commandId === "pending.cancel"
    || definition.commandId.startsWith("shell.");
}

function modelExecutionMode(definition: RuntimeCommandDefinition): RuntimeCommandExecutionMode {
  return definition.modelExecutionMode ?? "blocked";
}

function sanitizeArgvForDisplay(argv: string[]): string[] {
  return argv.map((item) => sanitizeRuntimeCommandOutput(item));
}

function blocked(reason: string, message: string, definition?: RuntimeCommandDefinition): ToolResult {
  return {
    ok: false,
    content: toJson({
      status: "blocked",
      reason,
      message: sanitizeRuntimeCommandOutput(message),
      ...(definition ? { command: definitionView(definition) } : {})
    })
  };
}

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function sanitizeRuntimeCommandOutput(content: string): string {
  const detected = detectSecrets(content);
  const redacted = detected.matched ? detected.redactedPreview : content;
  const withoutStack = redacted
    .split(/\r?\n/)
    .filter((line) => !/^\s+at\s+\S+/.test(line))
    .join("\n")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/config[\\/](?:secrets|runtime)\.private\.json/gi, "config/[PRIVATE_CONFIG]");
  if (withoutStack.length <= outputMaxChars) {
    return withoutStack;
  }
  return `${withoutStack.slice(0, outputMaxChars)}\n[COSIA: runtime command output truncated, originalChars=${withoutStack.length}, retainedChars=${outputMaxChars}]`;
}

function sanitizedError(error: unknown): string {
  return sanitizeRuntimeCommandOutput((error as Error).message ?? String(error));
}
