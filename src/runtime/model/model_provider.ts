import { agentStepSchema, type AgentStep, type ModelOutput } from "../types.js";
import { previewText, ProviderError } from "./provider_errors.js";

export function parseModelOutput(raw: string): ModelOutput {
  const json = extractJsonObject(raw);
  const parsed = JSON.parse(json);
  return {
    step: agentStepSchema.parse(parsed),
    raw
  };
}

export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return extractJsonObject(fenced[1]);
  }

  const start = trimmed.indexOf("{");
  if (start === -1) {
    throw new Error("Model output did not contain a JSON object.");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(start, i + 1);
      }
    }
  }
  throw new Error("Model output contained an incomplete JSON object.");
}

export async function completeWithStructuredRetry(
  input: { prompt: string; retryInstruction?: string },
  structuredRetryCount: number,
  completeOnce: (prompt: string) => Promise<string>
): Promise<ModelOutput> {
  let lastRaw = "";
  let lastError: unknown;
  for (let attempt = 0; attempt <= structuredRetryCount; attempt += 1) {
    const prompt = attempt === 0
      ? input.prompt
      : `${input.prompt}

${input.retryInstruction ?? modelInstructionForRetry(lastError, lastRaw)}
`;
    lastRaw = await completeOnce(prompt);
    try {
      return parseModelOutput(lastRaw);
    } catch (error) {
      lastError = error;
      if (attempt >= structuredRetryCount) {
        throw new ProviderError(
          "malformed_agent_step",
          `Provider returned invalid AgentStep JSON: ${(error as Error).message}`,
          {
            preview: previewText(lastRaw),
            cause: error
          }
        );
      }
    }
  }
  throw new ProviderError("malformed_agent_step", "Provider did not return AgentStep JSON.");
}

export function modelInstructionForRetry(error: unknown, malformedOutput = ""): string {
  return `You returned invalid JSON. Fix the error below and return ONLY valid AgentStep JSON.

Parse error:
${(error as Error).message}

Previous malformed output preview:
${previewText(malformedOutput, 600)}

Return ONLY one JSON object matching the AgentStep schema.`;
}

export function formatAgentStepForPrompt(step: AgentStep): string {
  return JSON.stringify(step, null, 2);
}
