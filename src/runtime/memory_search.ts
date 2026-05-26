import type { MemoryRecord } from "./types.js";
import { intersectMemoryTokens, memoryTokenSet, normalizeMemoryText } from "./memory_text.js";

export type MemorySearchResult = {
  record: MemoryRecord;
  score: number;
  matchedTokens: string[];
};

export function calculateMemoryScore(query: string, record: MemoryRecord): MemorySearchResult {
  const normalizedQuery = normalizeMemoryText(query);
  const queryTokens = memoryTokenSet(query);
  const haystack = normalizeMemoryText(`${record.content} ${record.kind} ${record.tier} ${record.ownerId ?? ""}`);
  const matchedTokens = intersectMemoryTokens([...queryTokens], memoryTokenSet(haystack));
  const exactPhrase = Boolean(normalizedQuery && haystack.includes(normalizedQuery));
  const relevant = exactPhrase || matchedTokens.length > 0;
  if (!relevant) {
    return { record, score: 0, matchedTokens: [] };
  }

  let score = 0;
  if (exactPhrase) {
    score += 6;
  }
  score += matchedTokens.length * 2;
  score += record.importance;
  score += record.confidence * 2;
  score += recencyScore(record.updatedAt);

  return {
    record,
    score: Number(score.toFixed(2)),
    matchedTokens
  };
}

export function formatReferenceMemoryLine(result: MemorySearchResult): string {
  const record = result.record;
  return `- [mem:${record.id.slice(0, 8)} score:${result.score.toFixed(2)} ${record.tier}/${record.kind}] ${record.content}`;
}

function recencyScore(updatedAt: string): number {
  const ageMs = Date.now() - Date.parse(updatedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return 1.5;
  }
  const ageDays = ageMs / 86_400_000;
  if (ageDays <= 7) {
    return 1.5;
  }
  if (ageDays <= 30) {
    return 1;
  }
  if (ageDays <= 90) {
    return 0.5;
  }
  return 0;
}
