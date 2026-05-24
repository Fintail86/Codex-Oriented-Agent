import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, pathExists, readText, writeText, writeTextIfMissing } from "./fs_utils.js";
import type { PromptManifest } from "./prompt_builder.js";
import { sessionMetadataSchema, type SessionMetadata } from "./types.js";

export type ContextUndoResult = {
  moved: boolean;
  movedAt?: string;
  archivePath?: string;
  message: string;
};

export type ContextHealthLevel = "ok" | "warning" | "critical";

export type ContextHealth = {
  sessionId: string;
  chars: number;
  warningChars: number;
  criticalChars: number;
  level: ContextHealthLevel;
};

export type ContextStatus = ContextHealth & {
  runEntryCount: number;
  archiveEntryCount: number;
  summaryIsPlaceholder: boolean;
  compactRecommended: boolean;
};

export type LastTurnDebugInput = {
  userMessage: string;
  prompt: string;
  runId: string;
  modelStep: number;
  promptChars: number;
  estimatedTokens: number;
  timestamp?: string;
};

export type LastTurnDebugRecord = {
  sessionId: string;
  debugDir: string;
  metadata: Record<string, unknown>;
  userMessage: string;
  prompt: string;
};

export type LastTurnDebugPart = "metadata" | "user-message" | "prompt" | "all";

export class SessionManager {
  constructor(private readonly workspaceRoot: string) {}

  async createSession(assignedAgentId: string | null, goal: string): Promise<SessionMetadata> {
    await ensureDir(this.sessionsDir());
    const id = await this.nextSessionId();
    const sessionDir = this.sessionDir(id);
    await ensureDir(sessionDir);
    const now = new Date().toISOString();
    const metadata: SessionMetadata = {
      id,
      assignedAgentId,
      status: "active",
      goal,
      createdAt: now,
      updatedAt: now
    };
    await this.writeSessionMetadata(metadata);
    await this.writeSessionMarkdown(metadata);
    await writeTextIfMissing(join(sessionDir, "SESSION_RULES.md"), "# SESSION RULES\n\nNo session-only rules yet.\n");
    await writeTextIfMissing(join(sessionDir, "SESSION_SUMMARY.md"), "# SESSION SUMMARY\n\nNo compact session summary yet.\n");
    await writeTextIfMissing(join(sessionDir, "CONTEXT_MEMORY.md"), "# CONTEXT MEMORY\n\n");
    await writeTextIfMissing(join(sessionDir, "CONTEXT_ARCHIVE.md"), "# CONTEXT ARCHIVE\n\n");
    await writeTextIfMissing(join(sessionDir, "REF_MEMORY.md"), "# REFERENCE MEMORY\n\nNo reference memory loaded yet.\n");
    await writeTextIfMissing(join(sessionDir, "NOTES.md"), "# NOTES\n\n");
    await writeTextIfMissing(join(sessionDir, "POLICY_AUDIT.jsonl"), "");
    await writeTextIfMissing(join(sessionDir, "PROMPT_MANIFEST.jsonl"), "");
    return metadata;
  }

  async loadSession(sessionId: string): Promise<SessionMetadata> {
    const sessionPath = join(this.sessionDir(sessionId), "session.json");
    const parsed = JSON.parse(await readText(sessionPath));
    const session = sessionMetadataSchema.parse(parsed);
    if (parsed.agentId !== undefined || parsed.assignedAgentId !== session.assignedAgentId) {
      await this.writeSessionMetadata(session);
    }
    return session;
  }

  async listSessions(options: { agentId?: string } = {}): Promise<SessionMetadata[]> {
    if (!(await pathExists(this.sessionsDir()))) {
      return [];
    }
    const entries = await readdir(this.sessionsDir(), { withFileTypes: true });
    const sessions: SessionMetadata[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        const session = await this.loadSession(entry.name);
        if (!options.agentId || session.assignedAgentId === options.agentId) {
          sessions.push(session);
        }
      } catch {
        // Ignore incomplete session folders in status/list output.
      }
    }
    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async assignAgent(sessionId: string, agentId: string | null): Promise<SessionMetadata> {
    const session = await this.loadSession(sessionId);
    const next: SessionMetadata = {
      ...session,
      assignedAgentId: agentId,
      updatedAt: new Date().toISOString()
    };
    await this.writeSessionMetadata(next);
    await this.writeSessionMarkdown(next);
    return next;
  }

  async archiveSession(sessionId: string): Promise<SessionMetadata> {
    const session = await this.loadSession(sessionId);
    const next: SessionMetadata = {
      ...session,
      status: "archived",
      updatedAt: new Date().toISOString()
    };
    await this.writeSessionMetadata(next);
    await this.writeSessionMarkdown(next);
    return next;
  }

  async ensureSessionSupportFiles(sessionId: string): Promise<void> {
    const sessionDir = this.sessionDir(sessionId);
    await writeTextIfMissing(join(sessionDir, "SESSION_SUMMARY.md"), "# SESSION SUMMARY\n\nNo compact session summary yet.\n");
    await writeTextIfMissing(join(sessionDir, "PROMPT_MANIFEST.jsonl"), "");
    await writeTextIfMissing(join(sessionDir, "POLICY_AUDIT.jsonl"), "");
    await writeTextIfMissing(join(sessionDir, "REF_MEMORY.md"), "# REFERENCE MEMORY\n\nNo reference memory loaded yet.\n");
    await writeTextIfMissing(join(sessionDir, "CONTEXT_MEMORY.md"), "# CONTEXT MEMORY\n\n");
    await writeTextIfMissing(join(sessionDir, "CONTEXT_ARCHIVE.md"), "# CONTEXT ARCHIVE\n\n");
  }

  async updateSummary(sessionId: string, content: string): Promise<void> {
    await this.ensureSessionSupportFiles(sessionId);
    await writeText(join(this.sessionDir(sessionId), "SESSION_SUMMARY.md"), `# SESSION SUMMARY\n\n${content.trim()}\n`);
  }

  async contextTail(sessionId: string, maxChars = 1200): Promise<string> {
    const path = join(this.sessionDir(sessionId), "CONTEXT_MEMORY.md");
    if (!(await pathExists(path))) {
      return "";
    }
    const content = await readText(path);
    return content.length > maxChars ? content.slice(content.length - maxChars) : content;
  }

  async contextHealth(sessionId: string, thresholds: { warningChars: number; criticalChars: number }): Promise<ContextHealth> {
    const status = await this.contextStatus(sessionId, thresholds);
    return {
      sessionId: status.sessionId,
      chars: status.chars,
      warningChars: status.warningChars,
      criticalChars: status.criticalChars,
      level: status.level
    };
  }

  async contextStatus(sessionId: string, thresholds: { warningChars: number; criticalChars: number }): Promise<ContextStatus> {
    await this.ensureSessionSupportFiles(sessionId);
    const sessionDir = this.sessionDir(sessionId);
    const contextPath = join(sessionDir, "CONTEXT_MEMORY.md");
    const archivePath = join(sessionDir, "CONTEXT_ARCHIVE.md");
    const summaryPath = join(sessionDir, "SESSION_SUMMARY.md");
    const context = (await pathExists(contextPath)) ? await readText(contextPath) : "";
    const archive = (await pathExists(archivePath)) ? await readText(archivePath) : "";
    const summary = (await pathExists(summaryPath)) ? await readText(summaryPath) : "";
    const chars = context.length;
    const level: ContextHealthLevel = chars >= thresholds.criticalChars
      ? "critical"
      : chars >= thresholds.warningChars
        ? "warning"
        : "ok";
    return {
      sessionId,
      chars,
      warningChars: thresholds.warningChars,
      criticalChars: thresholds.criticalChars,
      level,
      runEntryCount: splitContextRuns(context).runs.length,
      archiveEntryCount: countArchivedContextEntries(archive),
      summaryIsPlaceholder: isPlaceholderSessionSummary(summary),
      compactRecommended: level !== "ok" && splitContextRuns(context).runs.length > 1
    };
  }

  async contextHealthForSessions(thresholds: { warningChars: number; criticalChars: number }): Promise<ContextHealth[]> {
    const sessions = await this.listSessions();
    return Promise.all(sessions.map((session) => this.contextHealth(session.id, thresholds)));
  }

  async appendContext(sessionId: string, content: string): Promise<void> {
    const path = join(this.sessionDir(sessionId), "CONTEXT_MEMORY.md");
    const current = (await pathExists(path)) ? await readText(path) : "# CONTEXT MEMORY\n\n";
    await writeText(path, `${current.trimEnd()}\n\n${content.trim()}\n`);
  }

  async writeLastTurnDebug(sessionId: string, input: LastTurnDebugInput): Promise<void> {
    const timestamp = input.timestamp ?? new Date().toISOString();
    const metadata = {
      sessionId,
      runId: input.runId,
      modelStep: input.modelStep,
      timestamp,
      promptChars: input.promptChars,
      estimatedTokens: input.estimatedTokens
    };
    const debugDir = join(this.sessionDir(sessionId), "debug");
    await writeText(join(debugDir, "LAST_TURN.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    await writeText(join(debugDir, "LAST_USER_MESSAGE.md"), renderDebugText("LAST USER MESSAGE", input.userMessage, metadata));
    await writeText(join(debugDir, "LAST_PROMPT.md"), renderDebugText("LAST PROMPT", input.prompt, metadata));
  }

  async readLastTurnDebug(sessionId: string): Promise<LastTurnDebugRecord | null> {
    const session = await this.loadSession(sessionId);
    const debugDir = join(this.sessionDir(session.id), "debug");
    const metadataPath = join(debugDir, "LAST_TURN.json");
    const userMessagePath = join(debugDir, "LAST_USER_MESSAGE.md");
    const promptPath = join(debugDir, "LAST_PROMPT.md");
    if (!(await pathExists(metadataPath))) {
      return null;
    }
    return {
      sessionId: session.id,
      debugDir,
      metadata: JSON.parse(await readText(metadataPath)) as Record<string, unknown>,
      userMessage: (await pathExists(userMessagePath)) ? await readText(userMessagePath) : "",
      prompt: (await pathExists(promptPath)) ? await readText(promptPath) : ""
    };
  }

  async listPromptManifests(sessionId: string, limit = 1): Promise<PromptManifest[]> {
    await this.ensureSessionSupportFiles(sessionId);
    const path = join(this.sessionDir(sessionId), "PROMPT_MANIFEST.jsonl");
    const content = await readText(path);
    const manifests = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PromptManifest)
      .reverse();
    return manifests.slice(0, Math.max(1, limit));
  }

  async undoLastContextEntry(sessionId: string, reason: string): Promise<ContextUndoResult> {
    await this.ensureSessionSupportFiles(sessionId);
    const contextPath = join(this.sessionDir(sessionId), "CONTEXT_MEMORY.md");
    const archivePath = join(this.sessionDir(sessionId), "CONTEXT_ARCHIVE.md");
    const content = await readText(contextPath);
    const runStart = lastRunEntryIndex(content);
    if (runStart < 0) {
      return {
        moved: false,
        message: "No context run entry to archive."
      };
    }

    const movedAt = new Date().toISOString();
    const entry = content.slice(runStart).trim();
    const remaining = `${content.slice(0, runStart).trimEnd() || "# CONTEXT MEMORY"}\n\n`;
    const archive = await readText(archivePath);
    const archiveEntry = [
      `## Archived Context ${movedAt}`,
      "",
      `Reason: ${reason}`,
      "",
      "Original Entry:",
      "",
      entry,
      ""
    ].join("\n");
    await writeText(contextPath, remaining);
    await writeText(archivePath, `${archive.trimEnd()}\n\n${archiveEntry}`);
    return {
      moved: true,
      movedAt,
      archivePath,
      message: "Archived last context entry."
    };
  }

  async compactContext(sessionId: string, options: {
    keepLast: number;
    reason: string;
    apply?: boolean;
    allowEmptySummary?: boolean;
  }): Promise<ContextCompactResult> {
    await this.ensureSessionSupportFiles(sessionId);
    if (options.keepLast < 0) {
      throw new Error("--keep-last must be 0 or greater.");
    }
    const contextPath = join(this.sessionDir(sessionId), "CONTEXT_MEMORY.md");
    const archivePath = join(this.sessionDir(sessionId), "CONTEXT_ARCHIVE.md");
    const summaryPath = join(this.sessionDir(sessionId), "SESSION_SUMMARY.md");
    const content = await readText(contextPath);
    const summary = await readText(summaryPath);
    const parsed = splitContextRuns(content);
    const archiveRuns = parsed.runs.slice(0, Math.max(0, parsed.runs.length - options.keepLast));
    const keptRuns = parsed.runs.slice(Math.max(0, parsed.runs.length - options.keepLast));
    const summaryIsPlaceholder = isPlaceholderSessionSummary(summary);
    const blocked = archiveRuns.length > 0 && summaryIsPlaceholder && !options.allowEmptySummary;
    const nextContext = renderContextMemory(parsed.preamble, keptRuns);
    if (!options.apply || blocked || archiveRuns.length === 0) {
      return {
        applied: false,
        blocked,
        movedAt: undefined,
        message: blocked
          ? "SESSION_SUMMARY.md is still a placeholder. Write a summary first or pass --allow-empty-summary."
          : archiveRuns.length === 0
            ? "No old context run entries to compact."
            : "Context compact preview. Re-run with --yes to apply.",
        contextCharsBefore: content.length,
        contextCharsAfter: nextContext.length,
        keptRuns: keptRuns.length,
        archivedRuns: archiveRuns.length,
        summaryIsPlaceholder
      };
    }

    const movedAt = new Date().toISOString();
    const archive = await readText(archivePath);
    const archiveEntry = [
      `## Archived Context ${movedAt}`,
      "",
      `Reason: ${options.reason}`,
      `Kept runs: ${keptRuns.length}`,
      `Archived runs: ${archiveRuns.length}`,
      "",
      "Original Run Blocks:",
      "",
      archiveRuns.join("\n\n"),
      ""
    ].join("\n");
    await writeText(contextPath, nextContext);
    await writeText(archivePath, `${archive.trimEnd()}\n\n${archiveEntry}`);
    return {
      applied: true,
      blocked: false,
      movedAt,
      message: "Compacted context run entries.",
      contextCharsBefore: content.length,
      contextCharsAfter: nextContext.length,
      keptRuns: keptRuns.length,
      archivedRuns: archiveRuns.length,
      summaryIsPlaceholder
    };
  }

  async summarySource(sessionId: string, maxContextChars: number): Promise<ContextSummarySource> {
    await this.ensureSessionSupportFiles(sessionId);
    const sessionDir = this.sessionDir(sessionId);
    const context = await readText(join(sessionDir, "CONTEXT_MEMORY.md"));
    const summary = await readText(join(sessionDir, "SESSION_SUMMARY.md"));
    return {
      existingSummary: summary.trim(),
      summaryIsPlaceholder: isPlaceholderSessionSummary(summary),
      contextTail: context.length > maxContextChars ? context.slice(context.length - maxContextChars) : context,
      contextChars: context.length,
      retainedContextChars: Math.min(context.length, maxContextChars),
      runEntryCount: splitContextRuns(context).runs.length
    };
  }

  sessionDir(sessionId: string): string {
    return join(this.sessionsDir(), sessionId);
  }

  private sessionsDir(): string {
    return join(this.workspaceRoot, "sessions");
  }

  private async nextSessionId(): Promise<string> {
    const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const prefix = `session_${date}_`;
    const entries = (await pathExists(this.sessionsDir())) ? await readdir(this.sessionsDir()) : [];
    const next = entries.filter((entry) => entry.startsWith(prefix)).length + 1;
    return `${prefix}${String(next).padStart(3, "0")}`;
  }

  private async writeSessionMetadata(metadata: SessionMetadata): Promise<void> {
    await writeFile(join(this.sessionDir(metadata.id), "session.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }

  private async writeSessionMarkdown(metadata: SessionMetadata): Promise<void> {
    await writeText(
      join(this.sessionDir(metadata.id), "SESSION.md"),
      `# SESSION\n\n- id: ${metadata.id}\n- assigned agent: ${metadata.assignedAgentId ?? "none"}\n- status: ${metadata.status}\n- goal: ${metadata.goal}\n`
    );
  }
}

function lastRunEntryIndex(content: string): number {
  const matches = [...content.matchAll(/^## Run .+$/gm)];
  if (!matches.length) {
    return -1;
  }
  return matches[matches.length - 1].index ?? -1;
}

export type ContextCompactResult = {
  applied: boolean;
  blocked: boolean;
  movedAt?: string;
  message: string;
  contextCharsBefore: number;
  contextCharsAfter: number;
  keptRuns: number;
  archivedRuns: number;
  summaryIsPlaceholder: boolean;
};

export type ContextSummarySource = {
  existingSummary: string;
  summaryIsPlaceholder: boolean;
  contextTail: string;
  contextChars: number;
  retainedContextChars: number;
  runEntryCount: number;
};

export function splitContextRuns(content: string): { preamble: string; runs: string[] } {
  const matches = [...content.matchAll(/^## Run .+$/gm)];
  if (!matches.length) {
    return {
      preamble: content.trimEnd() || "# CONTEXT MEMORY",
      runs: []
    };
  }
  const firstRunStart = matches[0].index ?? 0;
  const preamble = content.slice(0, firstRunStart).trimEnd() || "# CONTEXT MEMORY";
  const runs = matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? content.length : content.length;
    return content.slice(start, end).trim();
  });
  return { preamble, runs };
}

export function isPlaceholderSessionSummary(content: string): boolean {
  const normalized = content
    .replace(/^# SESSION SUMMARY\s*/i, "")
    .trim();
  return normalized.length === 0 || normalized === "No compact session summary yet.";
}

export function formatLastTurnDebug(
  record: LastTurnDebugRecord,
  options: { part?: LastTurnDebugPart; maxChars?: number } = {}
): string {
  const part = options.part ?? "metadata";
  const maxChars = Math.max(0, options.maxChars ?? 4000);
  if (part === "metadata") {
    return formatLastTurnDebugMetadata(record);
  }
  if (part === "user-message") {
    return [
      "Last user message debug record",
      "Layer: diagnostic record, not memory.",
      `Session: ${record.sessionId}`,
      "",
      capDebugText(record.userMessage || "No LAST_USER_MESSAGE.md content.", maxChars)
    ].join("\n");
  }
  if (part === "prompt") {
    return [
      "Last prompt debug record",
      "Layer: diagnostic record, not prompt manifest and not memory.",
      `Session: ${record.sessionId}`,
      "",
      capDebugText(record.prompt || "No LAST_PROMPT.md content.", maxChars)
    ].join("\n");
  }
  return [
    formatLastTurnDebugMetadata(record),
    "",
    "# Last user message",
    "",
    capDebugText(record.userMessage || "No LAST_USER_MESSAGE.md content.", maxChars),
    "",
    "# Last prompt",
    "",
    capDebugText(record.prompt || "No LAST_PROMPT.md content.", maxChars)
  ].join("\n");
}

function formatLastTurnDebugMetadata(record: LastTurnDebugRecord): string {
  return [
    "Session debug metadata",
    "Layer: diagnostic record, not memory.",
    `Session: ${record.sessionId}`,
    `Location: sessions/${record.sessionId}/debug/`,
    `Run: ${String(record.metadata.runId ?? "unknown")}`,
    `Model step: ${String(record.metadata.modelStep ?? "unknown")}`,
    `Timestamp: ${String(record.metadata.timestamp ?? "unknown")}`,
    `Prompt chars: ${String(record.metadata.promptChars ?? "unknown")}`,
    `Estimated tokens: ${String(record.metadata.estimatedTokens ?? "unknown")}`
  ].join("\n");
}

function capDebugText(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content.trimEnd();
  }
  return `${content.slice(0, maxChars).trimEnd()}\n\n[truncated: showing ${maxChars} of ${content.length} chars]`;
}

function renderDebugText(title: string, content: string, metadata: Record<string, unknown>): string {
  return [
    `# ${title}`,
    "",
    "> This debug file is overwritten on each model step for this session.",
    "",
    "## Metadata",
    "",
    "```json",
    JSON.stringify(metadata, null, 2),
    "```",
    "",
    "## Content",
    "",
    content.trimEnd(),
    ""
  ].join("\n");
}

function renderContextMemory(preamble: string, runs: string[]): string {
  const header = preamble.trimEnd() || "# CONTEXT MEMORY";
  if (!runs.length) {
    return `${header}\n\n`;
  }
  return `${header}\n\n${runs.join("\n\n")}\n`;
}

function countArchivedContextEntries(content: string): number {
  return [...content.matchAll(/^## Archived Context .+$/gm)].length;
}
