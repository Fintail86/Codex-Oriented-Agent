export function normalizeMemoryText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function previewMemoryText(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

export function memoryTokenSet(value: string): Set<string> {
  const normalized = normalizeMemoryText(value);
  if (!normalized) {
    return new Set();
  }
  return new Set(normalized.split(" ").filter((token) => token.length >= 2));
}

export function intersectMemoryTokens(tokens: string[], target: Set<string>): string[] {
  return [...new Set(tokens)].filter((token) => target.has(token));
}
