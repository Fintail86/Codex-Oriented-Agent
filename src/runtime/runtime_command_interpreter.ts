import { z } from "zod";
import { runtimeCommandDefinitionById, type RuntimeCommandDefinition, type RuntimeCommandResult, runtimeCommandUsageHint, validateRuntimeCommandArgs } from "./runtime_command_catalog.js";
import type { PolicyConfig } from "./policy_manager.js";
import { createProvider } from "./model/provider_registry.js";
import { extractJsonObject } from "./model/model_provider.js";
import { previewText, ProviderError } from "./model/provider_errors.js";

const interpreterRetryCount = 1;

const interpretedCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("matched"),
    commandId: z.string().min(1),
    confidence: z.enum(["high", "medium"]).default("medium"),
    args: z.record(z.string(), z.unknown()).default({})
  }),
  z.object({
    type: z.literal("needs_input"),
    commandId: z.string().min(1),
    missing: z.array(z.string()).default([]),
    hint: z.string().default("")
  }),
  z.object({
    type: z.literal("ambiguous"),
    candidates: z.array(z.string()).default([]),
    hint: z.string().default("")
  }),
  z.object({
    type: z.literal("no_match")
  })
]);

export type RuntimeCommandInterpreterOptions = {
  input: string;
  candidates: RuntimeCommandDefinition[];
  workspaceRoot: string;
  providerId: string;
  policy: PolicyConfig;
  sessionId: string;
  providerTimeoutMs?: number;
  completePrompt?: (prompt: string) => Promise<string>;
};

export async function interpretRuntimeHashCommand(options: RuntimeCommandInterpreterOptions): Promise<RuntimeCommandResult> {
  if (options.candidates.length === 0) {
    return { type: "no_match" };
  }

  const basePrompt = buildRuntimeCommandInterpreterPrompt(options.input, options.candidates);
  let lastRaw = "";
  let lastError: unknown;
  for (let attempt = 0; attempt <= interpreterRetryCount; attempt += 1) {
    const prompt = attempt === 0
      ? basePrompt
      : `${basePrompt}

${runtimeCommandInterpreterRetryInstruction(lastError, lastRaw)}
`;
    lastRaw = await completeInterpreterPrompt(prompt, options);
    try {
      return validateRuntimeCommandInterpreterResult(lastRaw, options.candidates);
    } catch (error) {
      lastError = error;
      if (attempt >= interpreterRetryCount) {
        throw new ProviderError("malformed_response", `Command interpreter returned invalid JSON: ${(error as Error).message}`, {
          preview: previewText(lastRaw),
          cause: error
        });
      }
    }
  }

  return { type: "no_match" };
}

export function buildRuntimeCommandInterpreterPrompt(input: string, candidates: RuntimeCommandDefinition[]): string {
  return [
    "You are COSIA's constrained runtime command translator.",
    "",
    "Task:",
    "- Translate the user's hash-prefixed natural command into one runtime command result.",
    "- You do not execute anything.",
    "- You must choose only from the provided command candidates.",
    "- You must not invent command ids, CLI commands, shell commands, tool calls, activation actions, or policy changes.",
    "- If the request is unclear, return ambiguous or no_match.",
    "",
    "Strict formatting:",
    "- Return ONLY raw JSON.",
    "- Do not use Markdown.",
    "- Do not wrap in ```json.",
    "- Do not explain.",
    "- If this provider requires an AgentStep wrapper, set final.content to ONLY this raw JSON string.",
    "",
    "Allowed JSON result shapes:",
    JSON.stringify({
      type: "matched",
      commandId: "status.show",
      confidence: "high",
      args: {}
    }),
    JSON.stringify({
      type: "needs_input",
      commandId: "review.discard",
      missing: ["reason"],
      hint: "Try: #review 3 discard because duplicate"
    }),
    JSON.stringify({
      type: "ambiguous",
      candidates: ["review.list", "review.discard_conflicts"],
      hint: "Try #review or #discard all conflicting memories because duplicate"
    }),
    JSON.stringify({ type: "no_match" }),
    "",
    "User input:",
    input,
    "",
    "Command candidates:",
    JSON.stringify(candidates.map(commandCandidateForPrompt), null, 2)
  ].join("\n");
}

export function validateRuntimeCommandInterpreterResult(raw: string, candidates: RuntimeCommandDefinition[]): RuntimeCommandResult {
  const parsed = interpretedCommandSchema.parse(JSON.parse(extractJsonObject(raw)));
  if (parsed.type !== "matched") {
    return parsed;
  }

  const known = runtimeCommandDefinitionById(parsed.commandId);
  if (!known) {
    return {
      type: "ambiguous",
      candidates: [],
      hint: `Interpreter returned an unknown commandId: ${parsed.commandId}`
    };
  }

  const allowed = candidates.some((candidate) => candidate.commandId === parsed.commandId);
  if (!allowed) {
    return {
      type: "ambiguous",
      candidates: candidates.map((candidate) => candidate.commandId),
      hint: `Interpreter selected ${parsed.commandId}, but it was not in the command shortlist.`
    };
  }

  const invalid = validateRuntimeCommandArgs(parsed.commandId, parsed.args);
  if (invalid) {
    return invalid;
  }

  return parsed;
}

export function runtimeCommandInterpreterRetryInstruction(error: unknown, malformedOutput = ""): string {
  return `You returned invalid JSON. Fix the error below and return ONLY raw command interpreter JSON.

Parse error:
${(error as Error).message}

Previous malformed output preview:
${previewText(malformedOutput, 600)}

Return ONLY one JSON object matching the command interpreter result schema.`;
}

async function completeInterpreterPrompt(prompt: string, options: RuntimeCommandInterpreterOptions): Promise<string> {
  if (options.completePrompt) {
    return options.completePrompt(prompt);
  }
  const provider = createProvider(options.providerId, options.workspaceRoot, {
    policy: options.policy,
    timeoutMs: options.providerTimeoutMs
  });
  const output = await provider.complete({
    prompt,
    sessionId: options.sessionId
  });
  if (output.step.type !== "final") {
    throw new ProviderError("malformed_response", "Command interpreter provider returned a tool_call AgentStep.", {
      preview: previewText(output.raw)
    });
  }
  return output.step.content;
}

function commandCandidateForPrompt(candidate: RuntimeCommandDefinition): Record<string, unknown> {
  return {
    commandId: candidate.commandId,
    safety: candidate.safety,
    description: candidate.description,
    argsSchema: candidate.argsSchema,
    examples: candidate.examples
  };
}
