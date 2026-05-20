import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, pathExists, readText, writeTextIfMissing } from "./fs_utils.js";
import { agentTemplates, architectAllowedTools, architectManifest } from "./templates.js";
import { agentManifestSchema, type AgentManifest } from "./types.js";

export class AgentManager {
  constructor(private readonly workspaceRoot: string) {}

  async createAgent(agentId: string, template: string): Promise<AgentManifest> {
    if (template !== "architect") {
      throw new Error(`Unsupported agent template: ${template}`);
    }
    const agentDir = this.agentDir(agentId);
    if (await pathExists(agentDir)) {
      throw new Error(`Agent already exists: ${agentId}`);
    }
    await mkdir(agentDir, { recursive: true });
    for (const [fileName, content] of Object.entries(agentTemplates)) {
      await writeTextIfMissing(join(agentDir, fileName), content);
    }
    const manifest = architectManifest(agentId);
    await writeFile(join(agentDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  }

  async loadAgent(agentId: string): Promise<AgentManifest> {
    const manifestPath = join(this.agentDir(agentId), "manifest.json");
    const parsed = JSON.parse(await readText(manifestPath));
    const manifest = agentManifestSchema.parse(parsed);
    const repaired = repairArchitectManifest(manifest);
    if (repaired !== manifest) {
      await writeFile(manifestPath, `${JSON.stringify(repaired, null, 2)}\n`, "utf8");
    }
    return repaired;
  }

  async listAgents(): Promise<AgentManifest[]> {
    const agentsDir = join(this.workspaceRoot, "agents");
    if (!(await pathExists(agentsDir))) {
      return [];
    }
    const entries = await readdir(agentsDir, { withFileTypes: true });
    const agents: AgentManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        agents.push(await this.loadAgent(entry.name));
      } catch {
        // Ignore incomplete agent folders in status/list output.
      }
    }
    return agents.sort((left, right) => left.id.localeCompare(right.id));
  }

  async ensureAgentsDir(): Promise<void> {
    await ensureDir(join(this.workspaceRoot, "agents"));
  }

  agentDir(agentId: string): string {
    return join(this.workspaceRoot, "agents", agentId);
  }
}

function repairArchitectManifest(manifest: AgentManifest): AgentManifest {
  if (manifest.name !== "Architect Agent") {
    return manifest;
  }
  const allowedTools = [...new Set([...manifest.allowedTools, ...architectAllowedTools])];
  if (allowedTools.length === manifest.allowedTools.length) {
    return manifest;
  }
  return {
    ...manifest,
    allowedTools
  };
}
