import { join } from "node:path";
import { ensureDir, writeTextIfMissing } from "./fs_utils.js";
import { codexTemplates } from "./templates.js";
import { MemoryManager } from "./memory_manager.js";
import { PolicyManager } from "./policy_manager.js";

export async function initProject(workspaceRoot: string): Promise<string[]> {
  const created: string[] = [];
  for (const dir of ["codex", "agents", "sessions", "memory"]) {
    await ensureDir(join(workspaceRoot, dir));
    created.push(`${dir}/`);
  }
  for (const [fileName, content] of Object.entries(codexTemplates)) {
    const didCreate = await writeTextIfMissing(join(workspaceRoot, "codex", fileName), content);
    if (didCreate) {
      created.push(`codex/${fileName}`);
    }
  }
  created.push(...await new PolicyManager(workspaceRoot).ensurePolicyFiles());
  const memory = new MemoryManager(workspaceRoot);
  memory.ensureSchema();
  return created;
}
