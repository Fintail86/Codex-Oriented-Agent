import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, pathExists, readText, writeText, writeTextIfMissing } from "./fs_utils.js";
import { sessionMetadataSchema, type SessionMetadata } from "./types.js";

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
    await writeTextIfMissing(join(sessionDir, "CONTEXT_MEMORY.md"), "# CONTEXT MEMORY\n\n");
    await writeTextIfMissing(join(sessionDir, "REF_MEMORY.md"), "# REFERENCE MEMORY\n\nNo reference memory loaded yet.\n");
    await writeTextIfMissing(join(sessionDir, "NOTES.md"), "# NOTES\n\n");
    return metadata;
  }

  async loadSession(sessionId: string): Promise<SessionMetadata> {
    const sessionPath = join(this.sessionDir(sessionId), "session.json");
    const parsed = JSON.parse(await readText(sessionPath));
    return sessionMetadataSchema.parse(parsed);
  }

  async appendContext(sessionId: string, content: string): Promise<void> {
    const path = join(this.sessionDir(sessionId), "CONTEXT_MEMORY.md");
    const current = (await pathExists(path)) ? await readText(path) : "# CONTEXT MEMORY\n\n";
    await writeText(path, `${current.trimEnd()}\n\n${content.trim()}\n`);
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
