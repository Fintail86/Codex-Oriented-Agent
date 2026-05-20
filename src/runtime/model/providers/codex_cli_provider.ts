import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseModelOutput, modelInstructionForRetry } from "../model_provider.js";
import type { AuthStatus, ModelInput, ModelOutput, ModelProvider } from "../../types.js";

type CodexCliProviderOptions = {
  workspaceRoot: string;
  timeoutMs?: number;
};

export class CodexCliProvider implements ModelProvider {
  readonly id = "codex-cli";

  constructor(private readonly options: CodexCliProviderOptions) {}

  async checkAuth(): Promise<AuthStatus> {
    const result = await runCodex(["login", "status"], "", this.options.workspaceRoot, 10_000);
    if (result.code === 0) {
      return { ok: true, message: result.stdout.trim() || "Codex login status is OK." };
    }
    const isolated = await ensureProviderWorkdir();
    const schemaPath = await ensureOutputSchema(isolated);
    const smoke = await runCodex(
      codexExecArgs(schemaPath),
      boundaryPrompt(
        "Say only this JSON object: {\"type\":\"final\",\"tool\":\"read_file\",\"args\":{\"path\":\"\",\"content\":\"\",\"query\":\"\",\"directory\":\"\"},\"content\":\"codex-ready\",\"memoryCandidates\":[]}"
      ),
      isolated,
      30_000
    );
    return {
      ok: smoke.code === 0,
      message: smoke.code === 0 ? "Codex exec smoke test succeeded." : smoke.stderr || smoke.stdout
    };
  }

  async complete(input: ModelInput): Promise<ModelOutput> {
    const first = await this.completeOnce(input.prompt);
    try {
      return parseModelOutput(first);
    } catch (error) {
      const retryPrompt = `${input.prompt}

${input.retryInstruction ?? modelInstructionForRetry(error)}
`;
      const second = await this.completeOnce(retryPrompt);
      return parseModelOutput(second);
    }
  }

  private async completeOnce(prompt: string): Promise<string> {
    const isolated = await ensureProviderWorkdir();
    const schemaPath = await ensureOutputSchema(isolated);
    const result = await runCodex(
      codexExecArgs(schemaPath),
      boundaryPrompt(prompt),
      isolated,
      this.options.timeoutMs ?? 120_000
    );
    if (result.code !== 0) {
      throw new Error(`codex exec failed: ${result.stderr || result.stdout}`);
    }
    return extractFinalMessage(result.stdout) || result.stdout;
  }
}

function codexExecArgs(schemaPath: string): string[] {
  return [
    "exec",
    "--disable",
    "plugins",
    "--disable",
    "remote_plugin",
    "--disable",
    "shell_tool",
    "--disable",
    "shell_snapshot",
    "--disable",
    "browser_use",
    "--disable",
    "computer_use",
    "--json",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--output-schema",
    schemaPath.replaceAll("\\", "/"),
    "-"
  ];
}

function boundaryPrompt(prompt: string): string {
  return `You are being used as COSIA's model provider, not as an autonomous Codex coding agent.

Provider boundary:
- Do not use Codex CLI internal tools.
- Do not run shell commands.
- Do not call rg, grep, Get-Content, Select-String, cat, ls, or any filesystem command.
- Do not inspect files directly through Codex.
- If you need file or implementation information, return a COSIA JSON tool_call for read_file or search_files.
- Return only one JSON object matching the AgentStep schema.

${prompt}`;
}

async function ensureProviderWorkdir(): Promise<string> {
  const dir = join(tmpdir(), "cosia-codex-provider");
  await mkdir(dir, { recursive: true });
  return dir;
}

async function ensureOutputSchema(dir: string): Promise<string> {
  const schemaPath = join(dir, "agent-step.schema.json");
  await writeFile(schemaPath, JSON.stringify(agentStepJsonSchema, null, 2), "utf8");
  return schemaPath;
}

const agentStepJsonSchema = {
  type: "object",
  properties: {
    type: {
      enum: ["tool_call", "final"]
    },
    tool: {
      enum: ["read_file", "write_file", "search_files", "git_status", "git_diff", "git_log", "npm_test", "npm_typecheck"]
    },
    args: {
      type: "object",
      properties: {
        path: {
          type: "string"
        },
        content: {
          type: "string"
        },
        query: {
          type: "string"
        },
        directory: {
          type: "string"
        }
      },
      required: ["path", "content", "query", "directory"],
      additionalProperties: false
    },
    content: {
      type: "string"
    },
    memoryCandidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          scope: {
            enum: ["global", "user", "codex", "agent", "project", "session", "task", "tool"]
          },
          ownerId: {
            type: "string"
          },
          kind: {
            type: "string"
          },
          content: {
            type: "string"
          },
          importance: {
            type: "integer",
            minimum: 1,
            maximum: 5
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1
          }
        },
        required: ["scope", "ownerId", "kind", "content", "importance", "confidence"],
        additionalProperties: false
      }
    },
    skillCandidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          agentId: {
            type: "string"
          },
          skillName: {
            type: "string"
          },
          reason: {
            type: "string"
          },
          content: {
            type: "string"
          },
          triggers: {
            type: "array",
            items: {
              type: "string"
            }
          },
          riskLevel: {
            enum: ["low", "medium", "high"]
          }
        },
        required: ["agentId", "skillName", "reason", "content", "triggers", "riskLevel"],
        additionalProperties: false
      }
    }
  },
  required: ["type", "tool", "args", "content", "memoryCandidates", "skillCandidates"],
  additionalProperties: false
};

function extractFinalMessage(stdout: string): string | undefined {
  const candidates: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      collectStrings(event, candidates);
    } catch {
      candidates.push(trimmed);
    }
  }
  return candidates.findLast((candidate) => candidate.includes("\"type\"") && candidate.includes("final"))
    ?? candidates.findLast((candidate) => candidate.includes("{"))
    ?? candidates.at(-1);
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) {
      out.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, out);
    }
  }
}

function runCodex(
  args: string[],
  stdin: string,
  cwd: string,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? "cmd.exe" : "codex";
    const commandArgs = process.platform === "win32"
      ? ["/d", "/s", "/c", ["codex", ...args.map(quoteCmdArg)].join(" ")]
      : args;
    const child = spawn(command, commandArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      stderr += `\nTimed out after ${timeoutMs}ms while running: codex ${args.join(" ")}`;
      void killProcessTree(child.pid);
      resolve({ code: null, stdout, stderr });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

function killProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) {
    return Promise.resolve();
  }
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.on("close", () => resolve());
    killer.on("error", () => resolve());
  });
}

function quoteCmdArg(arg: string): string {
  if (/^[a-zA-Z0-9._:/=-]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replaceAll("\"", "\\\"")}"`;
}
