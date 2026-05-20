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

export class SessionManager {
  constructor(private readonly workspaceRoot: string) {}

  async createSession(agentId: string, goal: string): Promise<SessionMetadata> {
    await ensureDir(this.sessionsDir());
    const id = await this.nextSessionId(agentId);
    const sessionDir = this.sessionDir(id);
    await ensureDir(sessionDir);
    const now = new Date().toISOString();
    const metadata: SessionMetadata = {
      id,
      agentId,
      status: "active",
      goal,
      createdAt: now,
      updatedAt: now
    };
    await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await writeText(join(sessionDir, "SESSION.md"), `# SESSION\n\n- id: ${id}\n- agent: ${agentId}\n- status: active\n- goal: ${goal}\n`);
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
    return sessionMetadataSchema.parse(parsed);
  }

  async listSessions(): Promise<SessionMetadata[]> {
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
        sessions.push(await this.loadSession(entry.name));
      } catch {
        // Ignore incomplete session folders in status/list output.
      }
    }
    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
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

  async appendContext(sessionId: string, content: string): Promise<void> {
    const path = join(this.sessionDir(sessionId), "CONTEXT_MEMORY.md");
    const current = (await pathExists(path)) ? await readText(path) : "# CONTEXT MEMORY\n\n";
    await writeText(path, `${current.trimEnd()}\n\n${content.trim()}\n`);
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

  sessionDir(sessionId: string): string {
    return join(this.sessionsDir(), sessionId);
  }

  private sessionsDir(): string {
    return join(this.workspaceRoot, "sessions");
  }

  private async nextSessionId(agentId: string): Promise<string> {
    const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const safeAgent = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const prefix = `session_${date}_${safeAgent}_`;
    const entries = (await pathExists(this.sessionsDir())) ? await readdir(this.sessionsDir()) : [];
    const next = entries.filter((entry) => entry.startsWith(prefix)).length + 1;
    return `${prefix}${String(next).padStart(3, "0")}`;
  }
}

function lastRunEntryIndex(content: string): number {
  const matches = [...content.matchAll(/^## Run .+$/gm)];
  if (!matches.length) {
    return -1;
  }
  return matches[matches.length - 1].index ?? -1;
}
