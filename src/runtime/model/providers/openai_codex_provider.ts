import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { arch as osArch, platform as osPlatform, release as osRelease } from "node:os";
import { join } from "node:path";
import { completeWithStructuredRetry } from "../model_provider.js";
import { previewText, ProviderError, providerFailureHint } from "../provider_errors.js";
import {
  getProviderOAuthSecret,
  setProviderOAuthSecret,
  type PrivateSecrets
} from "../../private_config.js";
import { writeText } from "../../fs_utils.js";
import type { AuthStatus, ModelInput, ModelOutput, ModelProvider } from "../../types.js";
import type { FetchLike } from "./openai_compatible_provider.js";

type JsonObject = Record<string, unknown>;
type OAuthSecret = NonNullable<PrivateSecrets["providers"][string]["oauth"]>;
type CodexResponseResult = {
  response: Response;
  diagnostics: CodexRequestDiagnostics;
  sessionId: string;
  url: string;
};

type CodexRequestDiagnostics = {
  endpointFamily: string;
  urlPath: string;
  hasAccountId: boolean;
  model: string;
  openaiBeta: string;
  bodyKeys: string[];
  inputIsArray: boolean;
  instructionsLength: number;
  store: unknown;
  stream: unknown;
  unsupportedKeys: string[];
};

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_ENDPOINT_PATH = "/codex/responses";
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_SCOPE = "openid profile email offline_access";
const DEFAULT_ORIGINATOR = "pi";
const DEFAULT_OPENAI_BETA = "responses=v1";
const DEFAULT_OAUTH_PORT = 1455;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const POWERSHELL_HTTP_STATUS_MARKER = "__COSIA_HTTP_STATUS__:";
const CODEX_ALLOWED_BODY_KEYS = new Set([
  "model",
  "instructions",
  "input",
  "store",
  "stream",
  "text",
  "include",
  "prompt_cache_key",
  "tool_choice",
  "parallel_tool_calls",
  "tools",
  "reasoning",
  "temperature"
]);

export type OpenAICodexProviderOptions = {
  id?: string;
  profileName: string;
  workspaceRoot: string;
  model?: string | null;
  baseUrl?: string | null;
  endpointPath?: string | null;
  timeoutMs: number;
  structuredRetryCount: number;
  maxPromptChars: number;
  fetchImpl?: FetchLike;
};

export type OpenAICodexOAuthLoginOptions = {
  timeoutMs?: number;
  onMessage?: (message: string) => void;
  fetchImpl?: FetchLike;
  port?: number;
};

export type OpenAICodexOAuthLoginResult = {
  ok: boolean;
  message: string;
  accountSummary?: string;
};

export class OpenAICodexProvider implements ModelProvider {
  readonly id: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: OpenAICodexProviderOptions) {
    this.id = options.id ?? "openai-codex";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async checkAuth(): Promise<AuthStatus> {
    try {
      const token = await this.validAccessToken();
      return {
        ok: true,
        message: `OpenAI Codex OAuth token sink is configured${formatAccountSuffix(token.secret)}.`
      };
    } catch (error) {
      const providerError = error instanceof ProviderError
        ? error
        : new ProviderError("auth_failed", (error as Error).message, { cause: error });
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
      (prompt) => this.completeOnce(prompt, input.sessionId)
    );
  }

  private async completeOnce(prompt: string, sessionId: string): Promise<string> {
    enforcePromptLimit(prompt, this.options.maxPromptChars, this.id);
    const firstToken = await this.validAccessToken();
    const first = await this.sendCodexRequest(prompt, sessionId, firstToken);
    if (first.response.status === 401 || first.response.status === 403) {
      const refreshed = await this.refreshOAuthToken(firstToken.secret);
      return this.sendCodexRequest(prompt, sessionId, refreshed).then((response) => this.responseTextOrThrow(response));
    }
    return this.responseTextOrThrow(first);
  }

  private async sendCodexRequest(
    prompt: string,
    sessionId: string,
    token: { accessToken: string; secret: OAuthSecret }
  ): Promise<CodexResponseResult> {
    const bodyObject = codexRequestBody(prompt, this.options.model ?? DEFAULT_MODEL, sessionId);
    const body = JSON.stringify(bodyObject);
    const headers = codexRequestHeaders(token, sessionId);
    const url = this.endpointUrl();
    const diagnostics = codexRequestDiagnostics({
      url,
      headers,
      body: bodyObject,
      accountId: token.secret.accountId
    });
    await writeProviderPromptDebug(this.options.workspaceRoot, sessionId, bodyObject, url, diagnostics);
    if (this.shouldUseNativeTransport()) {
      const response = await sendWithPowerShellNativeTransport({
        url,
        headers,
        body,
        timeoutMs: this.options.timeoutMs,
        providerId: this.id
      });
      return { response, diagnostics, sessionId, url };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal
      });
      return { response, diagnostics, sessionId, url };
    } catch (error) {
      if (controller.signal.aborted || (error as Error).name === "AbortError") {
        throw new ProviderError("timeout", `Provider timed out after ${this.options.timeoutMs}ms.`, {
          hint: providerFailureHint("timeout", this.id),
          cause: error
        });
      }
      throw new ProviderError("network_error", (error as Error).message, {
        hint: providerFailureHint("network_error", this.id),
        cause: error
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async responseTextOrThrow(result: CodexResponseResult): Promise<string> {
    const { response } = result;
    if (!response.ok) {
      throw await this.httpError(result);
    }
    const raw = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    if (looksLikeEventStream(contentType, raw)) {
      const streamed = extractProviderContentFromSse(raw);
      await writeProviderResponseDebug(this.options.workspaceRoot, result, raw, {
        contentType,
        usage: streamed.usage,
        streamed: true
      });
      if (streamed.error) {
        throw new ProviderError("malformed_response", `OpenAI Codex stream failed: ${streamed.error}`, {
          preview: previewText(raw)
        });
      }
      if (streamed.content) {
        return streamed.content;
      }
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      throw new ProviderError("malformed_response", `Provider response was not JSON or SSE: ${(error as Error).message}`, {
        preview: previewText(raw),
        cause: error
      });
    }
    const content = extractProviderContent(json);
    await writeProviderResponseDebug(this.options.workspaceRoot, result, raw, {
      contentType,
      usage: isObject(json) ? json.usage : undefined,
      streamed: false
    });
    if (!content) {
      throw new ProviderError("malformed_response", "OpenAI Codex response did not contain text content.", {
        preview: previewText(JSON.stringify(json))
      });
    }
    return content;
  }

  private endpointUrl(): string {
    const base = this.options.baseUrl ?? DEFAULT_BASE_URL;
    const endpoint = this.options.endpointPath ?? DEFAULT_ENDPOINT_PATH;
    return `${base.replace(/\/+$/, "")}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
  }

  private shouldUseNativeTransport(): boolean {
    if (this.options.fetchImpl) {
      return false;
    }
    const transport = process.env.COSIA_OPENAI_CODEX_TRANSPORT?.trim().toLowerCase();
    if (transport === "fetch" || transport === "node") {
      return false;
    }
    if (transport === "native" || transport === "powershell") {
      return process.platform === "win32";
    }
    return false;
  }

  private async validAccessToken(): Promise<{ accessToken: string; secret: OAuthSecret }> {
    const secret = getProviderOAuthSecret(this.options.workspaceRoot, this.options.profileName);
    if (!secret?.accessToken && !secret?.refreshToken) {
      throw new ProviderError("auth_failed", `OpenAI Codex OAuth token is missing for provider profile ${this.options.profileName}.`, {
        hint: `Run \`cosia provider oauth login ${this.options.profileName}\` and then \`cosia provider profile check ${this.options.profileName}\`.`
      });
    }
    if (secret.accessToken && !isExpired(secret.expiresAt)) {
      const normalized = await this.normalizeStoredOAuthSecret(secret);
      return { accessToken: normalized.accessToken!, secret: normalized };
    }
    if (!secret.refreshToken) {
      throw new ProviderError("auth_failed", `OpenAI Codex OAuth token is expired for provider profile ${this.options.profileName}.`, {
        hint: `Run \`cosia provider oauth login ${this.options.profileName}\` again.`
      });
    }
    return this.refreshOAuthToken(secret);
  }

  private async normalizeStoredOAuthSecret(secret: OAuthSecret): Promise<OAuthSecret> {
    if (!secret.accessToken) {
      return secret;
    }
    const accountId = accountIdFromAccessToken(secret.accessToken, secret.accountId);
    if (!accountId || accountId === secret.accountId) {
      return secret;
    }
    const normalized = { ...secret, accountId };
    await setProviderOAuthSecret(this.options.workspaceRoot, this.options.profileName, normalized);
    return normalized;
  }

  private async refreshOAuthToken(secret: OAuthSecret): Promise<{ accessToken: string; secret: OAuthSecret }> {
    if (!secret.refreshToken) {
      throw new ProviderError("auth_failed", "OpenAI Codex OAuth refresh token is missing.", {
        hint: `Run \`cosia provider oauth login ${this.options.profileName}\` again.`
      });
    }
    const refreshed = await exchangeOAuthToken(this.fetchImpl, {
      grant_type: "refresh_token",
      refresh_token: secret.refreshToken,
      client_id: oauthClientId()
    }, this.options.timeoutMs, this.id);
    const next = buildOAuthSecret(refreshed, {
      fallbackRefreshToken: secret.refreshToken,
      fallbackScope: secret.scope,
      fallbackAccountId: secret.accountId
    });
    await setProviderOAuthSecret(this.options.workspaceRoot, this.options.profileName, next);
    if (!next.accessToken) {
      throw new ProviderError("auth_failed", "OpenAI Codex OAuth refresh did not return an access token.", {
        hint: `Run \`cosia provider oauth login ${this.options.profileName}\` again.`
      });
    }
    return { accessToken: next.accessToken, secret: next };
  }

  private async httpError(result: CodexResponseResult): Promise<ProviderError> {
    const { response, diagnostics } = result;
    const body = previewText(await response.text().catch(() => ""), 200);
    await writeProviderResponseDebug(this.options.workspaceRoot, result, body, {
      contentType: response.headers.get("content-type") ?? "",
      streamed: false
    });
    const diagnosticPreview = formatCodexFailureDiagnostics(response, diagnostics, body);
    if (response.status === 401 || response.status === 403) {
      return new ProviderError("auth_failed", `OpenAI Codex returned HTTP ${response.status}.`, {
        statusCode: response.status,
        preview: diagnosticPreview,
        hint: openAICodexAuthFailureHint(response.status, diagnosticPreview, this.options.profileName)
      });
    }
    if (response.status === 429) {
      return new ProviderError("rate_limited", "OpenAI Codex returned HTTP 429.", {
        statusCode: response.status,
        preview: diagnosticPreview,
        hint: providerFailureHint("rate_limited", this.id)
      });
    }
    return new ProviderError("http_error", `OpenAI Codex returned HTTP ${response.status}.`, {
      statusCode: response.status,
      preview: diagnosticPreview,
      hint: providerFailureHint("http_error", this.id)
    });
  }
}

export async function loginOpenAICodexOAuth(
  workspaceRoot: string,
  profileName: string,
  options: OpenAICodexOAuthLoginOptions = {}
): Promise<OpenAICodexOAuthLoginResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const port = options.port ?? Number(process.env.COSIA_OPENAI_CODEX_OAUTH_PORT ?? DEFAULT_OAUTH_PORT);
  const redirectUri = `http://localhost:${port}/auth/callback`;
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(24));
  const callback = await waitForOAuthCallback(port, state, timeoutMs);
  const authUrl = authorizationUrl({
    redirectUri,
    state,
    codeChallenge: challenge
  });
  options.onMessage?.("OpenAI Codex OAuth login started.");
  options.onMessage?.(`Open: ${authUrl}`);
  options.onMessage?.("After browser sign-in, leave this command running until the local callback completes.");
  const { code } = await callback.start(authUrl);
  const token = await exchangeOAuthToken(fetchImpl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: oauthClientId(),
    code_verifier: verifier
  }, timeoutMs, "openai-codex");
  const secret = buildOAuthSecret(token);
  await setProviderOAuthSecret(workspaceRoot, profileName, secret);
  return {
    ok: true,
    message: `OpenAI Codex OAuth login completed${formatAccountSuffix(secret)}.`,
    accountSummary: accountSummaryFromSecret(secret)
  };
}

type OAuthCallbackWaiter = {
  start(authUrl: string): Promise<{ code: string }>;
};

async function waitForOAuthCallback(port: number, expectedState: string, timeoutMs: number): Promise<OAuthCallbackWaiter> {
  return {
    start: (authUrl) => new Promise((resolve, reject) => {
      let server: ReturnType<typeof createServer>;
      const timeout = setTimeout(() => {
        server.close();
        reject(new ProviderError("timeout", "Timed out waiting for OpenAI OAuth browser callback.", {
          hint: `Open the URL again and make sure it redirects to http://localhost:${port}/auth/callback.`
        }));
      }, timeoutMs);
      server = createServer((request, response) => {
        handleOAuthCallbackRequest(request, response, expectedState, (error, code) => {
          clearTimeout(timeout);
          server.close();
          if (error) {
            reject(error);
            return;
          }
          resolve({ code });
        });
      });
      server.once("error", (error) => {
        clearTimeout(timeout);
        reject(new ProviderError("missing_config", `Could not start local OAuth callback server on port ${port}: ${(error as Error).message}`, {
          hint: "Set COSIA_OPENAI_CODEX_OAUTH_PORT to another localhost port, then retry."
        }));
      });
      server.listen(port, "localhost");
      void authUrl;
    })
  };
}

function handleOAuthCallbackRequest(
  request: IncomingMessage,
  response: ServerResponse,
  expectedState: string,
  done: (error: Error | undefined, code: string) => void
): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/auth/callback") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found.");
    return;
  }
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("COSIA OpenAI Codex OAuth failed. You may close this tab.");
    done(new ProviderError("auth_failed", `OpenAI OAuth returned error: ${error}`, {
      hint: "Retry `cosia provider oauth login <profile>`."
    }), "");
    return;
  }
  if (state !== expectedState || !code) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("COSIA OpenAI Codex OAuth callback was invalid. You may close this tab.");
    done(new ProviderError("auth_failed", "OpenAI OAuth callback failed state/code validation.", {
      hint: "Retry `cosia provider oauth login <profile>`."
    }), "");
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><meta charset=\"utf-8\"><title>COSIA OAuth</title><p>COSIA OpenAI Codex OAuth completed. You may close this tab.</p>");
  done(undefined, code);
}

async function exchangeOAuthToken(
  fetchImpl: FetchLike,
  params: Record<string, string>,
  timeoutMs: number,
  providerId: string
): Promise<JsonObject> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json"
      },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted || (error as Error).name === "AbortError") {
      throw new ProviderError("timeout", `OAuth token exchange timed out after ${timeoutMs}ms.`, {
        hint: providerFailureHint("timeout", providerId),
        cause: error
      });
    }
    throw new ProviderError("network_error", (error as Error).message, {
      hint: providerFailureHint("network_error", providerId),
      cause: error
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new ProviderError("auth_failed", `OAuth token exchange returned HTTP ${response.status}.`, {
      statusCode: response.status,
      preview: previewText(await response.text().catch(() => "")),
      hint: "Retry OAuth login. If this persists, verify the OpenAI OAuth flow is currently available."
    });
  }
  const json = await response.json().catch((error: unknown) => {
    throw new ProviderError("malformed_response", `OAuth token response was not JSON: ${(error as Error).message}`, {
      cause: error
    });
  });
  return isObject(json) ? json : {};
}

function authorizationUrl(args: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL("https://auth.openai.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", oauthClientId());
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("scope", oauthScope());
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", args.state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", process.env.COSIA_OPENAI_CODEX_OAUTH_ORIGINATOR || DEFAULT_ORIGINATOR);
  return url.toString();
}

function buildOAuthSecret(
  token: JsonObject,
  fallbacks: {
    fallbackRefreshToken?: string;
    fallbackScope?: string;
    fallbackAccountId?: string;
  } = {}
): OAuthSecret {
  const accessToken = typeof token.access_token === "string" ? token.access_token : undefined;
  const refreshToken = typeof token.refresh_token === "string" ? token.refresh_token : fallbacks.fallbackRefreshToken;
  const tokenType = typeof token.token_type === "string" ? token.token_type : "Bearer";
  const scope = typeof token.scope === "string" ? token.scope : fallbacks.fallbackScope ?? oauthScope();
  const expiresAt = expiresAtFromToken(token);
  const accountId = accessToken ? accountIdFromAccessToken(accessToken, fallbacks.fallbackAccountId) : fallbacks.fallbackAccountId;
  return {
    ...(accessToken ? { accessToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    tokenType,
    scope,
    ...(accountId ? { accountId } : {}),
    providerId: "openai-codex",
    source: "cosia-owned-oauth"
  };
}

function accountIdFromAccessToken(accessToken: string, fallbackAccountId?: string): string | undefined {
  const account = jwtPayload(accessToken);
  const authClaim = account["https://api.openai.com/auth"];
  return firstString(
    authClaim && isObject(authClaim)
      ? firstString(
        authClaim.chatgpt_account_id,
        authClaim.account_id
      )
      : undefined,
    account.chatgpt_account_id,
    account.account_id,
    fallbackAccountId && !fallbackAccountId.startsWith("auth0|") ? fallbackAccountId : undefined
  );
}

function expiresAtFromToken(token: JsonObject): string | undefined {
  if (typeof token.expires_at === "string") {
    return token.expires_at;
  }
  if (typeof token.expires_at === "number") {
    return new Date(token.expires_at * 1000).toISOString();
  }
  if (typeof token.expires_in === "number") {
    return new Date(Date.now() + token.expires_in * 1000).toISOString();
  }
  return undefined;
}

function isExpired(expiresAt?: string): boolean {
  if (!expiresAt) {
    return false;
  }
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  return timestamp <= Date.now() + TOKEN_REFRESH_SKEW_MS;
}

function extractProviderContent(json: unknown): string | undefined {
  if (!isObject(json)) {
    return undefined;
  }
  if (typeof json.output_text === "string") {
    return json.output_text;
  }
  const chat = chatCompletionContent(json);
  if (chat) {
    return chat;
  }
  const collected: string[] = [];
  collectResponseText(json, collected);
  return collected.join("").trim() || undefined;
}

function looksLikeEventStream(contentType: string, raw: string): boolean {
  return contentType.toLowerCase().includes("text/event-stream")
    || raw.trimStart().startsWith("event:")
    || raw.trimStart().startsWith("data:")
    || raw.includes("\ndata:");
}

function extractProviderContentFromSse(raw: string): { content?: string; error?: string; usage?: unknown } {
  const deltas: string[] = [];
  const completedCandidates: string[] = [];
  let usage: unknown;
  for (const event of parseSseJsonEvents(raw)) {
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "error") {
      return { error: firstString(event.message, event.code, JSON.stringify(event)) };
    }
    if (type === "response.failed") {
      const message = isObject(event.response) && isObject(event.response.error)
        ? firstString(event.response.error.message, event.response.error.code)
        : undefined;
      return { error: message ?? "response.failed" };
    }
    if (type.includes("output_text") && type.endsWith(".delta") && typeof event.delta === "string") {
      deltas.push(event.delta);
      continue;
    }
    if (typeof event.text === "string" && type.includes("output_text")) {
      deltas.push(event.text);
      continue;
    }
    if ((type === "response.completed" || type === "response.done") && event.response) {
      if (isObject(event.response) && event.response.usage !== undefined) {
        usage = event.response.usage;
      }
      const content = extractProviderContent(event.response);
      if (content) {
        completedCandidates.push(content);
      }
    }
  }
  const streamed = deltas.join("").trim();
  if (streamed) {
    return { content: streamed, usage };
  }
  const completed = completedCandidates.join("").trim();
  return completed ? { content: completed, usage } : { usage };
}

function parseSseJsonEvents(raw: string): JsonObject[] {
  const normalized = raw.replace(/\r\n/g, "\n");
  const chunks = normalized.split(/\n\n+/);
  const events: JsonObject[] = [];
  for (const chunk of chunks) {
    const data = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      const parsed = JSON.parse(data) as unknown;
      if (isObject(parsed)) {
        events.push(parsed);
      }
    } catch {
      // Ignore malformed event fragments and let the caller fail if no content is collected.
    }
  }
  return events;
}

function codexRequestBody(prompt: string, model: string, sessionId: string): JsonObject {
  const parts = normalizePromptForCodex(prompt);
  const promptCacheKey = codexPromptCacheKey(parts.instructions);
  return {
    model: normalizeCodexModelId(model),
    store: false,
    stream: true,
    instructions: parts.instructions,
    input: parts.input,
    text: { verbosity: "medium" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: promptCacheKey,
    tool_choice: "auto",
    parallel_tool_calls: true
  };
}

function normalizePromptForCodex(prompt: string): { instructions: string; input: JsonObject[] } {
  const sections = parsePromptSections(prompt);
  if (!sections.length) {
    return {
      instructions: codexInstructions(),
      input: [responsesUserMessage(prompt)]
    };
  }

  const currentRequest = sectionContent(sections, "CURRENT USER REQUEST") ?? "";
  const instructionBlocks = [
    codexInstructions(),
    ...sections
      .filter(isInstructionSection)
      .map((section) => formatPromptSection(section.title, section.content))
  ].filter(Boolean);

  const contextBlocks = sections
    .filter((section) => !isInstructionSection(section) && section.title !== "CURRENT USER REQUEST")
    .map((section) => formatPromptSection(section.title, section.content))
    .filter(Boolean);

  return {
    instructions: instructionBlocks.join("\n\n"),
    input: [
      ...(contextBlocks.length ? [responsesUserMessage(`# COSIA prompt context\n\n${contextBlocks.join("\n\n")}`)] : []),
      responsesUserMessage(currentRequest || prompt)
    ]
  };
}

type PromptSection = {
  title: string;
  content: string;
};

function parsePromptSections(prompt: string): PromptSection[] {
  const sections: PromptSection[] = [];
  const pattern = /^# BEGIN ([^\n]+)\n([\s\S]*?)^# END \1\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(prompt)) !== null) {
    sections.push({
      title: match[1].trim(),
      content: match[2].trim()
    });
  }
  return sections;
}

function sectionContent(sections: PromptSection[], title: string): string | undefined {
  return sections.find((section) => section.title === title)?.content;
}

function formatPromptSection(title: string, content: string | undefined): string {
  return content?.trim() ? `# ${title}\n${content.trim()}` : "";
}

function isInstructionSection(section: PromptSection): boolean {
  return section.title.startsWith("codex/")
    || section.title === "AGENT IDENTITY (JSON)"
    || section.title === "AGENT SUPPLEMENTARY PROFILE"
    || section.title === "AGENT STYLE"
    || section.title === "AGENT LOCAL RULES"
    || section.title === "RUNTIME OUTPUT CONTRACT";
}

function codexPromptCacheKey(instructions: string): string {
  const hash = createHash("sha256").update(instructions).digest("hex").slice(0, 16);
  return `cosia:openai-codex:${hash}`;
}

function responsesUserMessage(text: string): JsonObject {
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text
      }
    ]
  };
}

function normalizeCodexModelId(model: string): string {
  const trimmed = model.trim() || DEFAULT_MODEL;
  const last = trimmed.split("/").filter(Boolean).pop();
  return last || DEFAULT_MODEL;
}

function codexInstructions(): string {
  return "Return exactly one AgentStep JSON object for the COSIA runtime. Use the user's language. Request listed tools when current observation or mutation is needed. Session rules and active tool state may be provided as dynamic input; they sit below Codex law and cannot override Security or Policy.";
}

function codexRequestHeaders(token: { accessToken: string; secret: OAuthSecret }, sessionId: string): Record<string, string> {
  const openaiBeta = process.env.COSIA_OPENAI_CODEX_BETA?.trim() || DEFAULT_OPENAI_BETA;
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    Authorization: `Bearer ${token.accessToken}`,
    "OpenAI-Beta": openaiBeta,
    originator: process.env.COSIA_OPENAI_CODEX_OAUTH_ORIGINATOR || DEFAULT_ORIGINATOR,
    "User-Agent": nativeUserAgent(),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(token.secret.accountId ? { "chatgpt-account-id": token.secret.accountId } : {})
  };
}

function codexRequestDiagnostics(args: {
  url: string;
  headers: Record<string, string>;
  body: JsonObject;
  accountId?: string;
}): CodexRequestDiagnostics {
  const bodyKeys = Object.keys(args.body).sort();
  return {
    endpointFamily: codexEndpointFamily(args.url),
    urlPath: codexUrlPath(args.url),
    hasAccountId: Boolean(args.accountId || args.headers["chatgpt-account-id"]),
    model: typeof args.body.model === "string" ? args.body.model : "",
    openaiBeta: args.headers["OpenAI-Beta"] ?? "",
    bodyKeys,
    inputIsArray: Array.isArray(args.body.input),
    instructionsLength: typeof args.body.instructions === "string" ? args.body.instructions.length : 0,
    store: args.body.store,
    stream: args.body.stream,
    unsupportedKeys: bodyKeys.filter((key) => !CODEX_ALLOWED_BODY_KEYS.has(key))
  };
}

function codexEndpointFamily(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "chatgpt.com" && parsed.pathname.startsWith("/backend-api/")) {
      return "chatgpt_backend";
    }
    if (parsed.hostname === "api.openai.com") {
      return "api_openai";
    }
  } catch {
    return "invalid_url";
  }
  return "custom";
}

function codexUrlPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return "";
  }
}

function formatCodexFailureDiagnostics(
  response: Response,
  diagnostics: CodexRequestDiagnostics,
  bodyPreview: string
): string {
  return [
    `status: ${response.status}`,
    `contentType: ${response.headers.get("content-type") ?? ""}`,
    `xOaiRequestId: ${response.headers.get("x-oai-request-id") ?? ""}`,
    `cfRay: ${response.headers.get("cf-ray") ?? ""}`,
    `endpointFamily: ${diagnostics.endpointFamily}`,
    `urlPath: ${diagnostics.urlPath}`,
    `hasAccountId: ${diagnostics.hasAccountId ? "yes" : "no"}`,
    `model: ${diagnostics.model}`,
    `openaiBeta: ${diagnostics.openaiBeta}`,
    `bodyKeys: ${diagnostics.bodyKeys.join(",")}`,
    `inputIsArray: ${diagnostics.inputIsArray ? "yes" : "no"}`,
    `instructionsLength: ${diagnostics.instructionsLength}`,
    `store: ${String(diagnostics.store)}`,
    `stream: ${String(diagnostics.stream)}`,
    `unsupportedKeys: ${diagnostics.unsupportedKeys.join(",") || "none"}`,
    `responseBodyPreview: ${bodyPreview}`
  ].join("\n");
}

async function writeProviderPromptDebug(
  workspaceRoot: string,
  sessionId: string,
  body: JsonObject,
  url: string,
  diagnostics: CodexRequestDiagnostics
): Promise<void> {
  try {
    await writeText(
      join(workspaceRoot, "sessions", sessionId, "debug", "LAST_PROVIDER_PROMPT.md"),
      renderProviderPromptDebug(body, url, diagnostics)
    );
  } catch {
    // Debug output must never break provider execution.
  }
}

async function writeProviderResponseDebug(
  workspaceRoot: string,
  result: CodexResponseResult,
  raw: string,
  details: {
    contentType: string;
    usage?: unknown;
    streamed: boolean;
  }
): Promise<void> {
  try {
    await writeText(
      join(workspaceRoot, "sessions", result.sessionId, "debug", "LAST_PROVIDER_RESPONSE.md"),
      renderProviderResponseDebug(result, raw, details)
    );
  } catch {
    // Debug output must never break provider execution.
  }
}

function renderProviderPromptDebug(body: JsonObject, url: string, diagnostics: CodexRequestDiagnostics): string {
  const inputTexts = providerInputTexts(body.input);
  const metadata = {
    provider: "openai-codex",
    endpointFamily: diagnostics.endpointFamily,
    urlPath: diagnostics.urlPath,
    model: diagnostics.model,
    openaiBeta: diagnostics.openaiBeta,
    store: diagnostics.store,
    stream: diagnostics.stream,
    promptCacheKey: typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : "",
    instructionsChars: diagnostics.instructionsLength,
    inputCount: inputTexts.length,
    inputChars: inputTexts.reduce((sum, text) => sum + text.length, 0),
    bodyKeys: diagnostics.bodyKeys,
    unsupportedKeys: diagnostics.unsupportedKeys,
    endpoint: safeEndpointForDebug(url)
  };
  return [
    "# LAST PROVIDER PROMPT",
    "",
    "> This debug file is overwritten on each provider request for this session.",
    "> It shows the actual text layout sent to the provider, excluding auth headers and secret values.",
    "",
    "## Metadata",
    "",
    "```json",
    JSON.stringify(metadata, null, 2),
    "```",
    "",
    "## Instructions",
    "",
    "```text",
    String(body.instructions ?? "").trimEnd(),
    "```",
    "",
    "## Input Messages",
    "",
    ...inputTexts.flatMap((text, index) => [
      `### Input ${index + 1}`,
      "",
      "```text",
      text.trimEnd(),
      "```",
      ""
    ])
  ].join("\n").trimEnd() + "\n";
}

function renderProviderResponseDebug(
  result: CodexResponseResult,
  raw: string,
  details: {
    contentType: string;
    usage?: unknown;
    streamed: boolean;
  }
): string {
  const usage = isObject(details.usage) ? details.usage : {};
  const metadata = {
    provider: "openai-codex",
    endpointFamily: result.diagnostics.endpointFamily,
    urlPath: result.diagnostics.urlPath,
    model: result.diagnostics.model,
    status: result.response.status,
    ok: result.response.ok,
    contentType: details.contentType,
    streamed: details.streamed,
    xOaiRequestId: result.response.headers.get("x-oai-request-id") ?? "",
    cfRay: result.response.headers.get("cf-ray") ?? "",
    promptCacheKeySource: "request debug metadata",
    rawResponseChars: raw.length,
    cachedTokens: cachedTokensFromUsage(usage),
    promptTokens: numberFromPath(usage, ["prompt_tokens"]) ?? numberFromPath(usage, ["input_tokens"]),
    completionTokens: numberFromPath(usage, ["completion_tokens"]) ?? numberFromPath(usage, ["output_tokens"]),
    totalTokens: numberFromPath(usage, ["total_tokens"])
  };
  return [
    "# LAST PROVIDER RESPONSE",
    "",
    "> This debug file is overwritten on each provider response for this session.",
    "> It stores response metadata and usage only. Auth headers, token values, and raw model output are not stored here.",
    "",
    "## Metadata",
    "",
    "```json",
    JSON.stringify(metadata, null, 2),
    "```",
    "",
    "## Usage",
    "",
    "```json",
    JSON.stringify(usage, null, 2),
    "```",
    "",
    "## Notes",
    "",
    "- `cachedTokens` is read from `usage.prompt_tokens_details.cached_tokens` or `usage.input_tokens_details.cached_tokens` when present.",
    "- Raw model output is intentionally not stored in this response debug file."
  ].join("\n").trimEnd() + "\n";
}

function cachedTokensFromUsage(usage: JsonObject): number | undefined {
  return numberFromPath(usage, ["prompt_tokens_details", "cached_tokens"])
    ?? numberFromPath(usage, ["input_tokens_details", "cached_tokens"]);
}

function numberFromPath(value: unknown, path: string[]): number | undefined {
  let cursor = value;
  for (const key of path) {
    if (!isObject(cursor)) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return typeof cursor === "number" ? cursor : undefined;
}

function providerInputTexts(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.map((item) => {
    if (!isObject(item) || !Array.isArray(item.content)) {
      return "";
    }
    return item.content
      .map((content) => isObject(content) && typeof content.text === "string" ? content.text : "")
      .filter(Boolean)
      .join("\n");
  });
}

function safeEndpointForDebug(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

function openAICodexAuthFailureHint(status: number, bodyPreview: string, profileName: string): string {
  if (status === 403 && (looksLikeHtml(bodyPreview) || bodyPreview.includes("contentType: text/html"))) {
    return [
      "The OpenAI Codex OAuth token exists, but the ChatGPT Codex backend rejected COSIA's direct transport with an HTML 403.",
      "Restart the gateway after updating COSIA. If it still repeats, run `cosia provider oauth login " + profileName + "` once more, or select another provider profile until a supported Codex API route is available."
    ].join(" ");
  }
  return providerFailureHint("auth_failed", "openai-codex");
}

function looksLikeHtml(value: string): boolean {
  return /^\s*<!doctype html/i.test(value) || /^\s*<html[\s>]/i.test(value);
}

function nativeUserAgent(): string {
  return `pi (${osPlatform()} ${osRelease()}; ${osArch()})`;
}

async function sendWithPowerShellNativeTransport(args: {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  providerId: string;
}): Promise<Response> {
  const script = powershellRequestScript(args);
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new ProviderError("timeout", `Native OpenAI Codex transport timed out after ${args.timeoutMs}ms.`, {
        hint: providerFailureHint("timeout", args.providerId),
        preview: previewText(stderr)
      }));
    }, args.timeoutMs + 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new ProviderError("network_error", `Could not start native OpenAI Codex transport: ${error.message}`, {
        hint: "Use COSIA_OPENAI_CODEX_TRANSPORT=fetch to force Node fetch, or verify powershell.exe is available.",
        cause: error
      }));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (!stdout.includes(POWERSHELL_HTTP_STATUS_MARKER)) {
        reject(new ProviderError("network_error", `Native OpenAI Codex transport did not return an HTTP status marker.`, {
          hint: providerFailureHint("network_error", args.providerId),
          preview: previewText(stderr || stdout)
        }));
        return;
      }
      if (code !== 0) {
        reject(new ProviderError("network_error", `Native OpenAI Codex transport exited with code ${code}.`, {
          hint: providerFailureHint("network_error", args.providerId),
          preview: previewText(stderr || stdout)
        }));
        return;
      }
      resolve(parsePowerShellTransportResponse(stdout));
    });
    child.stdin.end(script);
  });
}

function powershellRequestScript(args: {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}): string {
  const headerPairs = Object.entries(args.headers)
    .map(([name, value]) => `@('${base64Utf8(name)}','${base64Utf8(value)}')`)
    .join(", ");
  const headerPairsLiteral = headerPairs ? `@(${headerPairs})` : "@()";
  const body = Buffer.from(args.body, "utf8").toString("base64");
  const url = Buffer.from(args.url, "utf8").toString("base64");
  const timeoutSec = Math.max(1, Math.ceil(args.timeoutMs / 1000));
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Net.Http",
    `$url = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${url}'))`,
    `$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${body}'))`,
    `$headerPairs = ${headerPairsLiteral}`,
    "$status = 0",
    "$content = ''",
    "$client = $null",
    "$request = $null",
    [
      "try {",
      "$client = [System.Net.Http.HttpClient]::new()",
      `$client.Timeout = [TimeSpan]::FromSeconds(${timeoutSec})`,
      "$request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $url)",
      "$request.Content = [System.Net.Http.StringContent]::new($body, [Text.Encoding]::UTF8, 'application/json')",
      "foreach ($pair in $headerPairs) { $name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$pair[0])); $value = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$pair[1])); if ($name -ine 'content-type') { [void]$request.Headers.TryAddWithoutValidation($name, $value) } }",
      "$response = $client.SendAsync($request).GetAwaiter().GetResult()",
      "$status = [int]$response.StatusCode",
      "$content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()",
      "} catch {",
      "$content = $_.Exception.Message",
      "} finally {",
      "if ($null -ne $request) { $request.Dispose() }",
      "if ($null -ne $client) { $client.Dispose() }",
      "}"
    ].join("; "),
    "[Console]::Out.WriteLine($content)",
    `[Console]::Out.WriteLine('${POWERSHELL_HTTP_STATUS_MARKER}' + $status)`
  ].join("; ");
}

function base64Utf8(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function parsePowerShellTransportResponse(stdout: string): Response {
  const index = stdout.lastIndexOf(POWERSHELL_HTTP_STATUS_MARKER);
  if (index === -1) {
    return new Response(stdout, { status: 599 });
  }
  const body = stdout.slice(0, index).trimEnd();
  const statusText = stdout.slice(index + POWERSHELL_HTTP_STATUS_MARKER.length).trim();
  const status = Number.parseInt(statusText, 10);
  const normalizedStatus = Number.isFinite(status) && status >= 200 && status <= 599 ? status : 599;
  return new Response(body, {
    status: normalizedStatus,
    headers: {
      "content-type": body.trimStart().startsWith("{") ? "application/json" : "text/plain"
    }
  });
}

function chatCompletionContent(json: JsonObject): string | undefined {
  const choices = json.choices;
  if (!Array.isArray(choices)) {
    return undefined;
  }
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  return typeof first?.message?.content === "string" ? first.message.content : undefined;
}

function collectResponseText(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectResponseText(item, out);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }
  if (typeof value.text === "string") {
    out.push(value.text);
  }
  if (typeof value.content === "string") {
    out.push(value.content);
  }
  for (const item of Object.values(value)) {
    if (isObject(item) || Array.isArray(item)) {
      collectResponseText(item, out);
    }
  }
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

function oauthClientId(): string {
  return process.env.COSIA_OPENAI_CODEX_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID;
}

function oauthScope(): string {
  return process.env.COSIA_OPENAI_CODEX_OAUTH_SCOPE || DEFAULT_SCOPE;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function jwtPayload(token: string): JsonObject {
  const [, payload] = token.split(".");
  if (!payload) {
    return {};
  }
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = `${normalized}${"=".repeat((4 - normalized.length % 4) % 4)}`;
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function accountSummaryFromSecret(secret: OAuthSecret): string | undefined {
  return secret.accountId;
}

function formatAccountSuffix(secret: OAuthSecret): string {
  const summary = accountSummaryFromSecret(secret);
  return summary ? ` (${summary})` : "";
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
