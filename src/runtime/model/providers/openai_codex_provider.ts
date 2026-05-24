import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { completeWithStructuredRetry } from "../model_provider.js";
import { previewText, ProviderError, providerFailureHint } from "../provider_errors.js";
import { COSIA_VERSION } from "../../version.js";
import type { AuthStatus, ModelInput, ModelOutput, ModelProvider } from "../../types.js";

type JsonObject = Record<string, unknown>;

export type OpenAICodexProviderOptions = {
  id?: string;
  workspaceRoot: string;
  model?: string | null;
  timeoutMs: number;
  structuredRetryCount: number;
  maxPromptChars: number;
};

export type OpenAICodexOAuthLoginOptions = {
  timeoutMs?: number;
  onMessage?: (message: string) => void;
};

export type OpenAICodexOAuthLoginResult = {
  ok: boolean;
  message: string;
  accountSummary?: string;
};

export class OpenAICodexProvider implements ModelProvider {
  readonly id: string;

  constructor(private readonly options: OpenAICodexProviderOptions) {
    this.id = options.id ?? "openai-codex";
  }

  async checkAuth(): Promise<AuthStatus> {
    try {
      return await withOpenAICodexAppServer(
        this.options.workspaceRoot,
        this.options.timeoutMs,
        async (client) => {
          await client.initialize();
          const account = await readAccount(client, true);
          if (isChatGptOAuthAccount(account)) {
            return {
              ok: true,
              message: `OpenAI Codex OAuth status is OK${formatAccountSuffix(account)}.`
            };
          }
          return {
            ok: false,
            message: accountMessage(account),
            reason: "auth_failed",
            hint: providerFailureHint("auth_failed", this.id)
          };
        }
      );
    } catch (error) {
      const providerError = classifyAppServerError(error, this.id);
      return {
        ok: false,
        message: providerError.message,
        reason: providerError.reason,
        hint: providerError.hint ?? providerFailureHint(providerError.reason, this.id)
      };
    }
  }

  async complete(input: ModelInput): Promise<ModelOutput> {
    return completeWithStructuredRetry(
      input,
      this.options.structuredRetryCount,
      (prompt) => this.completeOnce(prompt)
    );
  }

  private async completeOnce(prompt: string): Promise<string> {
    enforcePromptLimit(prompt, this.options.maxPromptChars, this.id);
    return withOpenAICodexAppServer(
      this.options.workspaceRoot,
      this.options.timeoutMs,
      async (client) => {
        await client.initialize();
        const account = await readAccount(client, true);
        if (!isChatGptOAuthAccount(account)) {
          throw new ProviderError("auth_failed", accountMessage(account), {
            hint: providerFailureHint("auth_failed", this.id)
          });
        }

        const thread = await client.request("thread/start", {
          ...(this.options.model ? { model: this.options.model } : {}),
          cwd: this.options.workspaceRoot,
          serviceName: "cosia_openai_codex_provider"
        }, 30_000);
        const threadId = extractThreadId(thread);
        if (!threadId) {
          throw new ProviderError("malformed_response", "openai-codex app-server did not return a thread id.", {
            preview: previewText(JSON.stringify(thread))
          });
        }

        const chunks: string[] = [];
        const removeHandler = client.onNotification((message) => {
          chunks.push(...extractAgentMessageText(message));
        });
        const completed = client.waitForNotification(
          (message) => message.method === "turn/completed",
          this.options.timeoutMs
        );
        try {
          await client.request("turn/start", {
            threadId,
            input: [
              {
                type: "text",
                text: boundaryPrompt(prompt)
              }
            ]
          }, 30_000);
          await completed;
        } finally {
          removeHandler();
        }

        const text = chunks.join("").trim();
        if (!text) {
          throw new ProviderError("malformed_response", "openai-codex app-server did not emit an agent message.", {
            hint: "Try `cosia provider profile check <profile>` first, or choose another provider profile."
          });
        }
        return text;
      }
    );
  }
}

export async function loginOpenAICodexOAuth(
  workspaceRoot: string,
  options: OpenAICodexOAuthLoginOptions = {}
): Promise<OpenAICodexOAuthLoginResult> {
  return withOpenAICodexAppServer(
    workspaceRoot,
    options.timeoutMs ?? 10 * 60_000,
    async (client) => {
      await client.initialize();
      const started = await client.request("account/login/start", {
        type: "chatgptDeviceCode"
      }, 30_000);
      const login = parseDeviceCodeLogin(started);
      options.onMessage?.("OpenAI Codex OAuth device login started.");
      options.onMessage?.(`Open: ${login.verificationUrl}`);
      options.onMessage?.(`Code: ${login.userCode}`);
      options.onMessage?.("Complete the browser sign-in, then leave this command running until it finishes.");

      const completed = await client.waitForNotification((message) => {
        if (message.method !== "account/login/completed") {
          return false;
        }
        const params = isObject(message.params) ? message.params : {};
        return params.loginId === login.loginId;
      }, options.timeoutMs ?? 10 * 60_000);
      const completedParams = isObject(completed.params) ? completed.params : {};
      if (completedParams.success !== true) {
        throw new ProviderError("auth_failed", String(completedParams.error ?? "OpenAI Codex OAuth login failed."), {
          hint: providerFailureHint("auth_failed", "openai-codex")
        });
      }
      const account = await readAccount(client, true);
      if (!isChatGptOAuthAccount(account)) {
        throw new ProviderError("auth_failed", accountMessage(account), {
          hint: providerFailureHint("auth_failed", "openai-codex")
        });
      }
      return {
        ok: true,
        message: `OpenAI Codex OAuth login completed${formatAccountSuffix(account)}.`,
        accountSummary: accountSummary(account)
      };
    }
  );
}

async function withOpenAICodexAppServer<T>(
  workspaceRoot: string,
  timeoutMs: number,
  fn: (client: CodexAppServerClient) => Promise<T>
): Promise<T> {
  const client = CodexAppServerClient.start(workspaceRoot, timeoutMs);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

class CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
    timeout: NodeJS.Timeout;
  }>();
  private readonly notificationHandlers = new Set<(message: JsonRpcMessage) => void>();
  private stderr = "";
  private closed = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly defaultTimeoutMs: number
  ) {
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr += String(chunk);
    });
    child.on("error", (error) => this.rejectAll(classifyAppServerError(error, "openai-codex")));
    child.on("close", (code) => {
      this.closed = true;
      if (this.pending.size) {
        this.rejectAll(new ProviderError("malformed_response", `openai-codex app-server exited with code ${code}.`, {
          preview: previewText(this.stderr)
        }));
      }
    });
  }

  static start(workspaceRoot: string, timeoutMs: number): CodexAppServerClient {
    const command = process.platform === "win32" ? "cmd.exe" : "codex";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", "codex app-server --listen stdio://"]
      : ["app-server", "--listen", "stdio://"];
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    return new CodexAppServerClient(child, timeoutMs);
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "cosia",
        title: "COSIA",
        version: COSIA_VERSION
      }
    }, 30_000);
    this.notify("initialized", {});
  }

  request(method: string, params?: unknown, timeoutMs = this.defaultTimeoutMs): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new ProviderError("malformed_response", "openai-codex app-server is closed."));
    }
    const id = this.nextId++;
    const message: JsonRpcMessage = { id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProviderError("timeout", `openai-codex app-server request timed out: ${method}`, {
          hint: providerFailureHint("timeout", "openai-codex"),
          preview: previewText(this.stderr)
        }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.write(message);
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  onNotification(handler: (message: JsonRpcMessage) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  waitForNotification(
    predicate: (message: JsonRpcMessage) => boolean,
    timeoutMs: number
  ): Promise<JsonRpcMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        remove();
        reject(new ProviderError("timeout", "Timed out waiting for openai-codex app-server notification.", {
          hint: providerFailureHint("timeout", "openai-codex"),
          preview: previewText(this.stderr)
        }));
      }, timeoutMs);
      const remove = this.onNotification((message) => {
        if (!predicate(message)) {
          return;
        }
        clearTimeout(timeout);
        remove();
        resolve(message);
      });
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
    }
    this.pending.clear();
    try {
      this.child.kill();
    } catch {
      // Process already closed.
    }
  }

  private write(message: JsonRpcMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.stderr += `\nNon-JSON app-server output: ${line}`;
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new ProviderError("malformed_response", appServerErrorMessage(message.error), {
          preview: previewText(JSON.stringify(message.error))
        }));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    for (const handler of this.notificationHandlers) {
      handler(message);
    }
  }

  private rejectAll(error: unknown): void {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }
}

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

async function readAccount(client: CodexAppServerClient, refreshToken: boolean): Promise<JsonObject> {
  const result = await client.request("account/read", { refreshToken }, 30_000);
  return isObject(result) ? result : {};
}

function isChatGptOAuthAccount(result: JsonObject): boolean {
  const account = isObject(result.account) ? result.account : undefined;
  return account?.type === "chatgpt" || account?.type === "chatgptAuthTokens";
}

function accountMessage(result: JsonObject): string {
  const account = isObject(result.account) ? result.account : undefined;
  if (!account) {
    return "OpenAI Codex OAuth is not logged in.";
  }
  if (account.type === "apiKey") {
    return "OpenAI Codex profile requires ChatGPT OAuth, but app-server is authenticated with an API key.";
  }
  return `OpenAI Codex OAuth account type is not usable: ${String(account.type ?? "unknown")}.`;
}

function accountSummary(result: JsonObject): string | undefined {
  const account = isObject(result.account) ? result.account : undefined;
  if (!account) {
    return undefined;
  }
  const parts = [
    typeof account.email === "string" ? account.email : undefined,
    typeof account.planType === "string" ? account.planType : undefined
  ].filter(Boolean);
  return parts.length ? parts.join(" / ") : undefined;
}

function formatAccountSuffix(result: JsonObject): string {
  const summary = accountSummary(result);
  return summary ? ` (${summary})` : "";
}

function parseDeviceCodeLogin(result: unknown): { loginId: string; verificationUrl: string; userCode: string } {
  if (!isObject(result)
    || result.type !== "chatgptDeviceCode"
    || typeof result.loginId !== "string"
    || typeof result.verificationUrl !== "string"
    || typeof result.userCode !== "string") {
    throw new ProviderError("malformed_response", "openai-codex app-server did not return a device-code login response.", {
      preview: previewText(JSON.stringify(result))
    });
  }
  return {
    loginId: result.loginId,
    verificationUrl: result.verificationUrl,
    userCode: result.userCode
  };
}

function extractThreadId(result: unknown): string | undefined {
  if (!isObject(result) || !isObject(result.thread)) {
    return undefined;
  }
  const id = result.thread.id ?? result.thread.sessionId;
  return typeof id === "string" ? id : undefined;
}

function extractAgentMessageText(message: JsonRpcMessage): string[] {
  if (!message.method?.includes("agentMessage")) {
    return [];
  }
  const out: string[] = [];
  collectTextFields(message.params, out);
  return out;
}

function collectTextFields(value: unknown, out: string[]): void {
  if (!isObject(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if ((key === "delta" || key === "text" || key === "content") && typeof item === "string") {
      out.push(item);
      continue;
    }
    if (isObject(item)) {
      collectTextFields(item, out);
    }
  }
}

function boundaryPrompt(prompt: string): string {
  return `You are being used as COSIA's OpenAI Codex OAuth-backed model provider, not as an autonomous coding agent.

Provider boundary:
- Return only one JSON object matching COSIA's AgentStep schema.
- Do not run commands.
- Do not modify files.
- If implementation context is needed, return a COSIA JSON tool_call for read_file or search_files.

${prompt}`;
}

function enforcePromptLimit(prompt: string, maxPromptChars: number, providerId: string): void {
  if (prompt.length <= maxPromptChars) {
    return;
  }
  throw new ProviderError(
    "malformed_response",
    `Prompt is ${prompt.length} chars, above provider maxPromptChars ${maxPromptChars}.`,
    {
      hint: `Reduce prompt size or raise model.providers.${providerId}.maxPromptChars in config/runtime.private.json.`
    }
  );
}

function classifyAppServerError(error: unknown, providerId: string): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || looksLikeMissingAppServer(message)) {
    return new ProviderError("cli_missing", message, {
      hint: providerFailureHint("cli_missing", providerId),
      cause: error
    });
  }
  if (code === "EPERM" || /permission denied|eperm/i.test(message)) {
    return new ProviderError("cli_missing", message, {
      hint: "COSIA could not start `codex app-server`. Run this command from a normal terminal, or choose another provider profile.",
      cause: error
    });
  }
  return new ProviderError("malformed_response", message, {
    hint: providerFailureHint("malformed_response", providerId),
    cause: error
  });
}

function looksLikeMissingAppServer(text: string): boolean {
  return /not recognized|cannot find|enoent|command not found|is not recognized|unknown command/i.test(text);
}

function appServerErrorMessage(error: unknown): string {
  if (!isObject(error)) {
    return String(error);
  }
  return typeof error.message === "string"
    ? error.message
    : JSON.stringify(error);
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
