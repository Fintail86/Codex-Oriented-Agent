import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { completeWithStructuredRetry } from "../model_provider.js";
import { previewText, ProviderError, providerFailureHint } from "../provider_errors.js";
import {
  getProviderOAuthSecret,
  setProviderOAuthSecret,
  type PrivateSecrets
} from "../../private_config.js";
import type { AuthStatus, ModelInput, ModelOutput, ModelProvider } from "../../types.js";
import type { FetchLike } from "./openai_compatible_provider.js";

type JsonObject = Record<string, unknown>;
type OAuthSecret = NonNullable<PrivateSecrets["providers"][string]["oauth"]>;

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_ENDPOINT_PATH = "/codex/responses";
const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_SCOPE = "openid profile email offline_access model.request";
const DEFAULT_OAUTH_PORT = 1455;
const TOKEN_REFRESH_SKEW_MS = 60_000;

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
      (prompt) => this.completeOnce(prompt)
    );
  }

  private async completeOnce(prompt: string): Promise<string> {
    enforcePromptLimit(prompt, this.options.maxPromptChars, this.id);
    const firstToken = await this.validAccessToken();
    const first = await this.sendCodexRequest(prompt, firstToken.accessToken);
    if (first.status === 401 || first.status === 403) {
      const refreshed = await this.refreshOAuthToken(firstToken.secret);
      return this.sendCodexRequest(prompt, refreshed.accessToken).then((response) => this.responseTextOrThrow(response));
    }
    return this.responseTextOrThrow(first);
  }

  private async sendCodexRequest(prompt: string, accessToken: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      return await this.fetchImpl(this.endpointUrl(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          model: this.options.model ?? DEFAULT_MODEL,
          input: boundaryPrompt(prompt),
          stream: false
        }),
        signal: controller.signal
      });
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

  private async responseTextOrThrow(response: Response): Promise<string> {
    if (!response.ok) {
      throw await this.httpError(response);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new ProviderError("malformed_response", `Provider response was not JSON: ${(error as Error).message}`, {
        cause: error
      });
    }
    const content = extractProviderContent(json);
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

  private async validAccessToken(): Promise<{ accessToken: string; secret: OAuthSecret }> {
    const secret = getProviderOAuthSecret(this.options.workspaceRoot, this.options.profileName);
    if (!secret?.accessToken && !secret?.refreshToken) {
      throw new ProviderError("auth_failed", `OpenAI Codex OAuth token is missing for provider profile ${this.options.profileName}.`, {
        hint: `Run \`cosia provider oauth login ${this.options.profileName}\` and then \`cosia provider profile check ${this.options.profileName}\`.`
      });
    }
    if (secret.accessToken && !isExpired(secret.expiresAt)) {
      return { accessToken: secret.accessToken, secret };
    }
    if (!secret.refreshToken) {
      throw new ProviderError("auth_failed", `OpenAI Codex OAuth token is expired for provider profile ${this.options.profileName}.`, {
        hint: `Run \`cosia provider oauth login ${this.options.profileName}\` again.`
      });
    }
    return this.refreshOAuthToken(secret);
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

  private async httpError(response: Response): Promise<ProviderError> {
    const body = previewText(await response.text().catch(() => ""));
    if (response.status === 401 || response.status === 403) {
      return new ProviderError("auth_failed", `OpenAI Codex returned HTTP ${response.status}.`, {
        statusCode: response.status,
        preview: body,
        hint: providerFailureHint("auth_failed", this.id)
      });
    }
    if (response.status === 429) {
      return new ProviderError("rate_limited", "OpenAI Codex returned HTTP 429.", {
        statusCode: response.status,
        preview: body,
        hint: providerFailureHint("rate_limited", this.id)
      });
    }
    return new ProviderError("http_error", `OpenAI Codex returned HTTP ${response.status}.`, {
      statusCode: response.status,
      preview: body,
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
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
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
          hint: `Open the URL again and make sure it redirects to http://127.0.0.1:${port}/auth/callback.`
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
      server.listen(port, "127.0.0.1");
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
  url.searchParams.set("originator", "cosia");
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
  const account = accessToken ? jwtPayload(accessToken) : {};
  const accountId = firstString(
    account.account_id,
    account.sub,
    account["https://api.openai.com/auth"] && isObject(account["https://api.openai.com/auth"])
      ? account["https://api.openai.com/auth"].account_id
      : undefined,
    fallbacks.fallbackAccountId
  );
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

function boundaryPrompt(prompt: string): string {
  return `Return exactly one COSIA AgentStep JSON object for the runtime. Do not execute commands or edit files yourself; request COSIA tool calls when needed.

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
