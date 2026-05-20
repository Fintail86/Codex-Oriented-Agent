export function slugifySkillId(skillName: string, candidateId: string): string {
  const slug = skillName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `skill-${candidateId.slice(0, 8)}`;
}

export function normalizeTriggers(triggers: string[]): string[] {
  return [...new Set(triggers.map((trigger) => normalizeTriggerText(trigger)).filter(Boolean))];
}

export function normalizeTriggerText(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, " ");
}

export function triggerMatches(trigger: string, text: string): boolean {
  if (!trigger || !text) {
    return false;
  }
  if (isAsciiCodeLike(trigger)) {
    const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`, "i").test(text);
  }
  return text.includes(trigger);
}

export function isAsciiCodeLike(trigger: string): boolean {
  return /^[a-z0-9_.:-]+$/i.test(trigger);
}

export function neutralizeXmlBoundaries(content: string): string {
  return content
    .replace(/<\/(skill|skill_markdown|available_skills)>/gi, "<\\/$1>")
    .replace(/<(skill|skill_markdown|available_skills)(\s|>)/gi, "&lt;$1$2");
}

export function truncateSkillContent(content: string, maxChars: number, skillId: string): string {
  const marker = `\n[COSIA: skill ${skillId} truncated, originalChars=${content.length}, retainedChars=${maxChars}]`;
  return `${content.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

export function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function indentXmlText(value: string, prefix: string): string {
  return value.split(/\r?\n/).map((line) => `${prefix}${line}`).join("\n");
}

export function preview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

export function pad(value: string, length: number): string {
  return value.length >= length ? value : `${value}${" ".repeat(length - value.length)}`;
}

export function clampSkillWeight(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(5, Math.max(0, Math.round(value)));
}

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

export function titleFromMarkdown(content: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(content);
  return match?.[1]?.trim();
}
