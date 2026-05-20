import { join } from "node:path";
import { ensureDir, writeTextIfMissing } from "./fs_utils.js";
import { codexTemplates } from "./templates.js";
import { MemoryManager } from "./memory_manager.js";
import { PolicyManager } from "./policy_manager.js";
import { SkillManager } from "./skill_manager.js";
import { AgentManager } from "./agent_manager.js";

export async function initProject(workspaceRoot: string): Promise<string[]> {
  const created: string[] = [];
  for (const dir of ["codex", "agents", "sessions", "memory", "skills"]) {
    await ensureDir(join(workspaceRoot, dir));
    created.push(`${dir}/`);
  }
  for (const [fileName, content] of Object.entries(codexTemplates)) {
    const didCreate = await writeTextIfMissing(join(workspaceRoot, "codex", fileName), content);
    if (didCreate) {
      created.push(`codex/${fileName}`);
    }
  }
  const policyManager = new PolicyManager(workspaceRoot);
  created.push(...await policyManager.ensurePolicyFiles());
  const policy = await policyManager.loadPolicy();
  created.push(...await new AgentManager(workspaceRoot).ensureDefaultAgent(policy.agents.defaultAgentId));
  const memory = new MemoryManager(workspaceRoot);
  memory.ensureSchema();
  new SkillManager(workspaceRoot).ensureSchema();
  return created;
}
