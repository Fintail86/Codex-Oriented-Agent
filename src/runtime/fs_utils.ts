import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, relative } from "node:path";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content, "utf8");
}

export async function writeTextIfMissing(path: string, content: string): Promise<boolean> {
  if (await pathExists(path)) {
    return false;
  }
  await writeText(path, content);
  return true;
}

export function resolveInside(root: string, inputPath: string): string {
  const rootResolved = resolve(root);
  const target = isAbsolute(inputPath) ? resolve(inputPath) : resolve(rootResolved, inputPath);
  const rel = relative(rootResolved, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return target;
  }
  throw new Error(`Path is outside workspace: ${inputPath}`);
}

export async function resolveExistingInside(root: string, inputPath: string): Promise<string> {
  const target = resolveInside(root, inputPath);
  const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(target)]);
  const rel = relative(rootReal, targetReal);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return targetReal;
  }
  throw new Error(`Path is outside workspace: ${inputPath}`);
}
