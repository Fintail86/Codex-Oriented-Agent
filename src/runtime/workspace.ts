import { dirname, resolve } from "node:path";
import { pathExists } from "./fs_utils.js";

export async function findWorkspaceRoot(startDir: string): Promise<string | undefined> {
  let current = resolve(startDir);
  while (true) {
    if (await isCosiaWorkspace(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export async function requireWorkspaceRoot(startDir: string): Promise<string> {
  const root = await findWorkspaceRoot(startDir);
  if (!root) {
    throw new Error("COSIA workspace not found. Run `cosia init` or move into a COSIA workspace.");
  }
  return root;
}

export async function workspaceRootForInit(startDir: string): Promise<string> {
  return (await findWorkspaceRoot(startDir)) ?? resolve(startDir);
}

async function isCosiaWorkspace(root: string): Promise<boolean> {
  const checks = [
    pathExists(resolve(root, "codex", "SECURITY.md")),
    pathExists(resolve(root, "agents")),
    pathExists(resolve(root, "sessions")),
    pathExists(resolve(root, "memory"))
  ];
  return (await Promise.all(checks)).every(Boolean);
}
