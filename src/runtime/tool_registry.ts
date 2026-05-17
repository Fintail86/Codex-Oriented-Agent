import { execFile } from "node:child_process";
import { isAbsolute, relative } from "node:path";
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
        const [contentMatches, pathMatches] = await Promise.all([
          runRipgrep(parsed.query, directory),
          findPathMatches(parsed.query, directory)
        ]);
        const content = formatSearchResult(contentMatches, pathMatches);
        return { ok: true, content };
      }
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

async function findPathMatches(query: string, directory: string): Promise<string[]> {
  try {
    const result = await execFileAsync("rg", ["--files", directory], {
      maxBuffer: 1024 * 1024
    });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => toDisplayPath(line, directory))
      .map((path) => ({ path, score: scorePathQuery(path, query) }))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .map((match) => match.path)
      .slice(0, 40);
  } catch {
    return [];
  }
}

function formatSearchResult(
  contentMatches: { stdout: string; stderr: string },
  pathMatches: string[]
): string {
  const sections: string[] = [];
  if (pathMatches.length > 0) {
    sections.push(`Path matches:\n${pathMatches.join("\n")}`);
  }
  const content = contentMatches.stdout.trim();
  if (content) {
    sections.push(`Content matches:\n${content}`);
  }
  const errors = contentMatches.stderr.trim();
  if (errors) {
    sections.push(`Search diagnostics:\n${errors}`);
  }
  return sections.join("\n\n") || "No matches.";
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
