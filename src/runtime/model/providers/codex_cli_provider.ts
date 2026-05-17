import { spawn } from "node:child_process";
import { parseModelOutput, modelInstructionForRetry } from "../model_provider.js";
import type { AuthStatus, ModelInput, ModelOutput, ModelProvider } from "../../types.js";

type CodexCliProviderOptions = {
  workspaceRoot: string;
};

export class CodexCliProvider implements ModelProvider {
  readonly id = "codex-cli";

  constructor(private readonly options: CodexCliProviderOptions) {}

  async checkAuth(): Promise<AuthStatus> {
    const result = await runCodex(["login", "status"], "", this.options.workspaceRoot);
    if (result.code === 0) {
      return { ok: true, message: result.stdout.trim() || "Codex login status is OK." };
    }
    const smoke = await runCodex(
      ["exec", "--json", "--ephemeral", "--sandbox", "read-only", "-"],
      "Say only: codex-ready",
      this.options.workspaceRoot
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
    const result = await runCodex(
      ["exec", "--json", "--ephemeral", "--sandbox", "read-only", "-"],
      prompt,
      this.options.workspaceRoot
    );
    if (result.code !== 0) {
      throw new Error(`codex exec failed: ${result.stderr || result.stdout}`);
    }
    return extractFinalMessage(result.stdout) || result.stdout;
  }
}

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

function runCodex(args: string[], stdin: string, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

function quoteCmdArg(arg: string): string {
  if (/^[a-zA-Z0-9._:/=-]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replaceAll("\"", "\\\"")}"`;
}
