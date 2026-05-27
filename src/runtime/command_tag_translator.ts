import {
  commandTagAliases,
  commandTagWeightValue,
  type CommandTagAlias,
  type CommandTagLocale
} from "./command_tag_lexicon.js";

export type CommandTagMatch = {
  alias: string;
  tag: string;
  locale: CommandTagLocale;
  weight: number;
};

export type CommandTagTranslation = {
  detectedLocale: CommandTagLocale | "mixed" | "unknown";
  tags: string[];
  matches: CommandTagMatch[];
};

const koreanParticleSuffixes = [
  "에서",
  "으로",
  "에게",
  "한테",
  "부터",
  "까지",
  "가",
  "를",
  "는",
  "이",
  "은",
  "을",
  "에",
  "도",
  "만"
].sort((a, b) => b.length - a.length);

export function translateCommandTags(input: string): CommandTagTranslation {
  const normalized = normalizeCommandTagText(input);
  if (!normalized) {
    return { detectedLocale: "unknown", tags: [], matches: [] };
  }

  const tokens = commandTagTokens(normalized);
  const matches = uniqueMatches([
    ...matchCompoundAliases(normalized),
    ...matchTokenAliases(normalized, tokens)
  ]);
  const tags = [...new Set(matches.map((match) => match.tag))].sort((a, b) => a.localeCompare(b));

  return {
    detectedLocale: detectMatchLocale(matches),
    tags,
    matches: matches.sort((a, b) => b.weight - a.weight || a.tag.localeCompare(b.tag) || a.alias.localeCompare(b.alias))
  };
}

export function commandTagTokens(normalizedInput: string): string[] {
  const tokens = new Set<string>();
  for (const token of normalizedInput.split(/\s+/).map((item) => item.trim()).filter(Boolean)) {
    tokens.add(token);
    const stripped = stripKoreanParticle(token);
    if (stripped) {
      tokens.add(stripped);
    }
  }
  return [...tokens];
}

export function normalizeCommandTagText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripKoreanParticle(token: string): string | undefined {
  if (!/[가-힣]/.test(token)) {
    return undefined;
  }
  for (const suffix of koreanParticleSuffixes) {
    if (!token.endsWith(suffix)) {
      continue;
    }
    const stem = token.slice(0, -suffix.length);
    if (stem.length >= 2) {
      return stem;
    }
  }
  return undefined;
}

function matchCompoundAliases(normalizedInput: string): CommandTagMatch[] {
  const matches: CommandTagMatch[] = [];
  for (const entry of commandTagAliases) {
    for (const alias of entry.aliases) {
      const normalizedAlias = normalizeCommandTagText(alias);
      if (!normalizedAlias || !normalizedAlias.includes(" ")) {
        continue;
      }
      if (containsNormalizedAlias(normalizedInput, normalizedAlias, entry.locale)) {
        matches.push(toMatch(entry, alias));
      }
    }
  }
  return matches;
}

function matchTokenAliases(normalizedInput: string, tokens: string[]): CommandTagMatch[] {
  const tokenSet = new Set(tokens);
  const matches: CommandTagMatch[] = [];
  for (const entry of commandTagAliases) {
    for (const alias of entry.aliases) {
      const normalizedAlias = normalizeCommandTagText(alias);
      if (!normalizedAlias || normalizedAlias.includes(" ")) {
        continue;
      }
      if (tokenSet.has(normalizedAlias) || containsNormalizedAlias(normalizedInput, normalizedAlias, entry.locale)) {
        matches.push(toMatch(entry, alias));
      }
    }
  }
  return matches;
}

function containsNormalizedAlias(input: string, alias: string, locale: CommandTagLocale): boolean {
  if (locale === "en" && isAsciiWord(alias)) {
    return new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(input);
  }
  return input.includes(alias);
}

function toMatch(entry: CommandTagAlias, alias: string): CommandTagMatch {
  return {
    alias,
    tag: entry.tag,
    locale: entry.locale,
    weight: commandTagWeightValue[entry.weight ?? "strong"]
  };
}

function uniqueMatches(matches: CommandTagMatch[]): CommandTagMatch[] {
  const best = new Map<string, CommandTagMatch>();
  for (const match of matches) {
    const key = `${match.locale}:${match.tag}:${match.alias}`;
    const existing = best.get(key);
    if (!existing || match.weight > existing.weight) {
      best.set(key, match);
    }
  }
  return [...best.values()];
}

function detectMatchLocale(matches: CommandTagMatch[]): CommandTagTranslation["detectedLocale"] {
  const locales = new Set(matches.map((match) => match.locale));
  if (locales.size === 0) {
    return "unknown";
  }
  if (locales.size > 1) {
    return "mixed";
  }
  return [...locales][0] ?? "unknown";
}

function isAsciiWord(value: string): boolean {
  return /^[a-z0-9_-]+$/i.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
