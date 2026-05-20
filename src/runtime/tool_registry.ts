import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { readText, resolveExistingInside, resolveInside, writeText } from "./fs_utils.js";
import { summarizePolicyArgs } from "./policy_audit.js";
import { PolicyEngine } from "./policy_engine.js";
import { PolicyManager } from "./policy_manager.js";
import type { ToolContext, ToolDefinition, ToolName, ToolResult } from "./types.js";

const execFileAsync = promisify(execFile);

const readFileArgs = z.object({
  path: z.string().min(1)
});

const writeFileArgs = z.object({
  path: z.string().min(1),
  content: z.string()
});

const searchFilesArgs = z.object({
  query: z.string().min(1),
  directory: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional())
});

const gitDiffArgs = z.object({
  path: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional()),
  staged: z.boolean().optional()
});

const gitLogArgs = z.object({
  maxCount: z.number().int().positive().optional()
});

const toolOutputMaxChars = 12000;
const searchFallbackMaxFiles = 1000;
const searchFallbackMaxMatches = 80;
const searchFallbackTimeoutMs = 5000;

type PathSearchResult = {
  matches: string[];
  diagnostics?: string;
};

type FileListResult = {
  files: string[];
  stoppedReason?: string;
};

export class ToolRegistry {
  private readonly tools = new Map<ToolName, ToolDefinition>();

  constructor() {
    this.register({
      name: "read_file",
      permission: "read_only",
      execute: async (args, ctx) => {
        const parsed = readFileArgs.parse(args);
        const resolved = await resolveExistingInside(ctx.workspaceRoot, parsed.path);
        return { ok: true, content: await readText(resolved) };
      }
    });
    this.register({
      name: "write_file",
      permission: "write_local",
      execute: async (args, ctx) => {
        const parsed = writeFileArgs.parse(args);
        const resolved = resolveInside(ctx.workspaceRoot, parsed.path);
        await writeText(resolved, parsed.content);
        return { ok: true, content: `Wrote ${parsed.path}` };
      }
    });
    this.register({
      name: "search_files",
      permission: "read_only",
      execute: async (args, ctx) => {
        const parsed = searchFilesArgs.parse(args);
        const directory = resolveInside(ctx.workspaceRoot, parsed.directory ?? ".");
        const [contentMatches, pathSearch] = await Promise.all([
          runTextSearch(parsed.query, directory),
          findPathMatches(parsed.query, directory)
        ]);
        const content = formatSearchResult(contentMatches, pathSearch.matches, pathSearch.diagnostics);
        return { ok: true, content };
      }
    });
    this.register({
      name: "git_status",
      permission: "read_only",
      execute: async (_args, ctx) => runWorkspaceCommand("git", ["status", "--short", "--branch"], ctx.workspaceRoot)
    });
    this.register({
      name: "git_diff",
      permission: "read_only",
      execute: async (args, ctx) => {
        const parsed = gitDiffArgs.parse(args);
        const commandArgs = ["diff"];
        if (parsed.staged) {
          commandArgs.push("--staged");
        }
        if (parsed.path) {
          const resolved = resolveInside(ctx.workspaceRoot, parsed.path);
          commandArgs.push("--", toDisplayPath(resolved, ctx.workspaceRoot));
        }
        return runWorkspaceCommand("git", commandArgs, ctx.workspaceRoot);
      }
    });
    this.register({
      name: "git_log",
      permission: "read_only",
      execute: async (args, ctx) => {
        const parsed = gitLogArgs.parse(args);
        const maxCount = Math.min(parsed.maxCount ?? 20, 50);
        return runWorkspaceCommand("git", ["log", `--max-count=${maxCount}`, "--date=short", "--pretty=format:%h %ad %s"], ctx.workspaceRoot);
      }
    });
    this.register({
      name: "npm_test",
      permission: "read_only",
      execute: async (_args, ctx) => runPackageScript(ctx.workspaceRoot, "test", ["test"])
    });
    this.register({
      name: "npm_typecheck",
      permission: "read_only",
      execute: async (_args, ctx) => runPackageScript(ctx.workspaceRoot, "typecheck", ["run", "typecheck"])
    });
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: ToolName): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool is not registered: ${name}`);
    }
    return tool;
  }

  async execute(name: ToolName, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const tool = this.get(name);
      const argsSummary = summarizePolicyArgs(args);
      if (!ctx.allowedTools.includes(name)) {
        await ctx.policyAudit?.({
          eventType: "tool_decision",
          allowed: false,
          ruleId: "agent.allowed_tools",
          reason: `Tool is not allowed for this agent: ${name}`,
          tool: name,
          permission: tool.permission,
          argsSummary
        });
        return { ok: false, content: `Tool is not allowed for this agent: ${name}` };
      }
      const policy = await new PolicyManager(ctx.workspaceRoot).loadPolicy();
      const engine = new PolicyEngine(policy);
      const decision = engine.evaluate(tool, args, ctx.workspaceRoot);
      await ctx.policyAudit?.({
        eventType: "tool_decision",
        allowed: decision.allowed,
        ruleId: decision.ruleId,
        reason: decision.reason,
        tool: name,
        permission: tool.permission,
        argsSummary
      });
      if (!decision.allowed) {
        return { ok: false, content: decision.reason };
      }
      if (name === "write_file" && await engine.requiresOverwriteApproval(args, ctx.workspaceRoot)) {
        await ctx.policyAudit?.({
          eventType: "approval_required",
          allowed: false,
          ruleId: "write.overwrite_approval_required",
          reason: "Existing file overwrite requires approval.",
          tool: name,
          permission: tool.permission,
          argsSummary
        });
        const parsed = writeFileArgs.parse(args);
        const resolved = resolveInside(ctx.workspaceRoot, parsed.path);
        const approved = ctx.approveOverwrite ? await ctx.approveOverwrite(resolved) : false;
        if (!approved) {
          return { ok: false, content: `Overwrite denied: ${parsed.path}` };
        }
      }
      return await tool.execute(args, ctx);
    } catch (error) {
      return { ok: false, content: (error as Error).message };
    }
  }
}

async function runPackageScript(workspaceRoot: string, scriptName: "test" | "typecheck", npmArgs: string[]): Promise<ToolResult> {
  let packageJsonPath: string;
  try {
    packageJsonPath = await resolveExistingInside(workspaceRoot, "package.json");
  } catch {
    return { ok: false, content: `package.json script not found: ${scriptName}` };
  }
  const packageJson = JSON.parse(await readText(packageJsonPath)) as { scripts?: Record<string, string> };
  if (!packageJson.scripts?.[scriptName]) {
    return { ok: false, content: `package.json script not found: ${scriptName}` };
  }
  return runNpmCommand(npmArgs, workspaceRoot);
}

async function runWorkspaceCommand(command: string, args: string[], cwd: string): Promise<ToolResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024
    });
    return { ok: true, content: truncateToolOutput(formatCommandOutput(result.stdout, result.stderr), toolOutputMaxChars) };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    const output = formatCommandOutput(err.stdout ?? "", err.stderr ?? err.message);
    return {
      ok: false,
      content: truncateToolOutput(`Exit code: ${String(err.code ?? "unknown")}\n${output}`, toolOutputMaxChars)
    };
  }
}

function formatCommandOutput(stdout: string, stderr: string): string {
  const sections: string[] = [];
  if (stdout.trim()) {
    sections.push(stdout.trimEnd());
  }
  if (stderr.trim()) {
    sections.push(`stderr:\n${stderr.trimEnd()}`);
  }
  return sections.join("\n\n") || "No output.";
}

function runNpmCommand(args: string[], cwd: string): Promise<ToolResult> {
  if (process.platform === "win32") {
    return runWorkspaceCommand("cmd.exe", ["/d", "/s", "/c", "npm", ...args], cwd);
  }
  return runWorkspaceCommand("npm", args, cwd);
}

async function runRipgrep(query: string, directory: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("rg", ["--line-number", "--no-heading", query, directory], {
      maxBuffer: 1024 * 1024
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    if (err.code === 1) {
      return { stdout: "", stderr: "" };
    }
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message
    };
  }
}

async function runTextSearch(query: string, directory: string): Promise<{ stdout: string; stderr: string }> {
  const rgResult = await runRipgrep(query, directory);
  if (rgResult.stdout.trim()) {
    return rgResult;
  }
  const fallback = await fallbackTextSearch(query, directory);
  const stderr = [rgResult.stderr.trim(), fallback.stoppedReason ? searchFallbackMarker(fallback.stoppedReason) : ""]
    .filter(Boolean)
    .join("\n");
  return { stdout: fallback.matches.join("\n"), stderr };
}

async function fallbackTextSearch(query: string, directory: string): Promise<{ matches: string[]; stoppedReason?: string }> {
  const matches: string[] = [];
  const needle = query.toLowerCase();
  const tokens = pathQueryTokens(query.toLowerCase()).filter((token) => token.length >= 3);
  const deadline = Date.now() + searchFallbackTimeoutMs;

  async function collectFileMatches(filePath: string): Promise<void> {
    if (Date.now() > deadline) {
      return;
    }
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      return;
    }
    if (content.includes("\0")) {
      return;
    }
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length && matches.length < searchFallbackMaxMatches; index += 1) {
      if (Date.now() > deadline) {
        return;
      }
      const line = lines[index];
      const lower = line.toLowerCase();
      const matched = lower.includes(needle) || tokens.some((token) => lower.includes(token));
      if (matched) {
        matches.push(`${toDisplayPath(filePath, directory)}:${index + 1}:${line.trimEnd()}`);
      }
    }
  }

  const listed = await listWorkspaceFiles(directory, searchFallbackMaxFiles, deadline);
  for (const filePath of listed.files) {
    if (matches.length >= searchFallbackMaxMatches || Date.now() > deadline) {
      break;
    }
    await collectFileMatches(filePath);
  }
  const stoppedReason = matches.length >= searchFallbackMaxMatches
    ? "max_matches"
    : Date.now() > deadline
      ? "timeout"
      : listed.stoppedReason;
  return { matches, stoppedReason };
}

async function findPathMatches(query: string, directory: string): Promise<PathSearchResult> {
  let files: string[];
  let diagnostics: string | undefined;
  try {
    const result = await execFileAsync("rg", ["--files", directory], {
      maxBuffer: 1024 * 1024
    });
    files = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    const listed = await listWorkspaceFiles(directory, searchFallbackMaxFiles, Date.now() + searchFallbackTimeoutMs);
    files = listed.files;
    diagnostics = listed.stoppedReason ? searchFallbackMarker(listed.stoppedReason) : undefined;
  }
  if (files.length === 0) {
    const listed = await listWorkspaceFiles(directory, searchFallbackMaxFiles, Date.now() + searchFallbackTimeoutMs);
    files = listed.files;
    diagnostics = listed.stoppedReason ? searchFallbackMarker(listed.stoppedReason) : diagnostics;
  }
  const matches = files
    .map((line) => toDisplayPath(line, directory))
    .map((path) => ({ path, score: scorePathQuery(path, query) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map((match) => match.path)
    .slice(0, 40);
  return { matches, diagnostics };
}

async function listWorkspaceFiles(directory: string, maxFiles: number, deadline = Date.now() + searchFallbackTimeoutMs): Promise<FileListResult> {
  const files: string[] = [];
  const skipDirs = new Set([".git", "node_modules", "dist", "coverage", ".next", ".turbo"]);
  let stoppedReason: string | undefined;

  async function visit(current: string): Promise<void> {
    if (files.length >= maxFiles) {
      stoppedReason = "max_files";
      return;
    }
    if (Date.now() > deadline) {
      stoppedReason = "timeout";
      return;
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        stoppedReason = "max_files";
        return;
      }
      if (Date.now() > deadline) {
        stoppedReason = "timeout";
        return;
      }
      const fullPath = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          await visit(fullPath);
        }
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  await visit(directory);
  return { files, stoppedReason };
}

function formatSearchResult(
  contentMatches: { stdout: string; stderr: string },
  pathMatches: string[],
  pathDiagnostics?: string
): string {
  const sections: string[] = [];
  if (pathMatches.length > 0) {
    sections.push(`Path matches:\n${pathMatches.join("\n")}`);
  }
  const content = contentMatches.stdout.trim();
  if (content) {
    sections.push(`Content matches:\n${content}`);
  }
  const errors = [contentMatches.stderr.trim(), pathDiagnostics?.trim()].filter(Boolean).join("\n");
  if (errors) {
    sections.push(`Search diagnostics:\n${errors}`);
  }
  return sections.join("\n\n") || "No matches.";
}

function searchFallbackMarker(reason: string): string {
  return `[COSIA: search fallback stopped early, reason=${reason}]`;
}

function toDisplayPath(path: string, directory: string): string {
  const display = isAbsolute(path) ? relative(directory, path) : path;
  return display.replaceAll("\\", "/");
}

function scorePathQuery(path: string, query: string): number {
  const pathText = path.toLowerCase();
  const normalizedQuery = query
    .toLowerCase()
    .replace(/[`"']/g, "")
    .replaceAll("\\", "/")
    .trim();
  if (normalizedQuery && pathText.includes(normalizedQuery)) {
    return 1000 + normalizedQuery.length;
  }
  const tokens = pathQueryTokens(normalizedQuery);
  return tokens.reduce((score, token) => {
    if (!pathText.includes(token)) {
      return score;
    }
    const structuralBonus = token.includes("/") || token.includes(".") ? 20 : 0;
    const boundaryBonus = pathText.includes(`/${token}`) || pathText.includes(`${token}.`) ? 10 : 0;
    return score + token.length + structuralBonus + boundaryBonus;
  }, 0);
}

function pathQueryTokens(query: string): string[] {
  const rawTokens = query.match(/[a-z0-9_./-]+/gi) ?? [];
  const expanded = rawTokens.flatMap((token) => {
    const parts = token.split(/[/-]+/).filter(Boolean);
    return [token, ...parts];
  });
  return [...new Set(expanded.filter((token) => token.length >= 2))];
}

function truncateToolOutput(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  const marker = `\n[COSIA: tool output truncated, originalChars=${content.length}, retainedChars=${maxChars}, omittedChars=${content.length - maxChars}. Do not infer that omitted output was inspected or problem-free.]`;
  const middleMarker = "\n[COSIA: omitted middle output]\n";
  const available = maxChars - marker.length - middleMarker.length;
  if (available <= 0) {
    return marker.trimStart();
  }
  const headChars = Math.ceil(available / 2);
  const tailChars = Math.floor(available / 2);
  return `${content.slice(0, headChars)}${middleMarker}${content.slice(content.length - tailChars)}${marker}`;
}
