import { agentStepSchema, type AgentStep, type ModelOutput } from "../types.js";

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
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

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

export function modelInstructionForRetry(error: unknown): string {
  return `Your previous response could not be parsed as the required AgentStep JSON. Return only one JSON object. Parse error: ${(error as Error).message}`;
}

export function formatAgentStepForPrompt(step: AgentStep): string {
  return JSON.stringify(step, null, 2);
}
