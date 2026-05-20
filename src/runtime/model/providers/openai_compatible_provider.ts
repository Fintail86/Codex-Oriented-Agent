import { completeWithStructuredRetry } from "../model_provider.js";
import { previewText, ProviderError, providerFailureHint } from "../provider_errors.js";
import type { AuthStatus, ModelInput, ModelOutput, ModelProvider } from "../../types.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type OpenAICompatibleProviderOptions = {
  enabled: boolean;
  baseUrl: string | null;
  model: string | null;
  apiKeyEnv: string;
  endpointPath: string;
  timeoutMs: number;
  structuredRetryCount: number;
  maxPromptChars: number;
  fetchImpl?: FetchLike;
};

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai-compatible";
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: OpenAICompatibleProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async checkAuth(): Promise<AuthStatus> {
    try {
      this.validateConfig();
      return {
        ok: true,
        message: `Provider ${this.id} is configured. Live model calls use ${this.options.apiKeyEnv}.`
      };
    } catch (error) {
      const providerError = error instanceof ProviderError
        ? error
        : new ProviderError("missing_config", (error as Error).message, { cause: error });
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
    this.validateConfig();
    if (prompt.length > this.options.maxPromptChars) {
      throw new ProviderError(
        "malformed_response",
        `Prompt is ${prompt.length} chars, above provider maxPromptChars ${this.options.maxPromptChars}.`,
        { hint: "Reduce prompt size or raise provider maxPromptChars in codex/POLICY.json." }
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpointUrl(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey()}`
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: 0
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

    const content = extractChatCompletionContent(json);
    if (!content) {
      throw new ProviderError("malformed_response", "Provider response did not contain choices[0].message.content.", {
        preview: previewText(JSON.stringify(json))
      });
    }
    return content;
  }

  private validateConfig(): void {
    if (!this.options.enabled) {
      throw new ProviderError("disabled", "Provider openai-compatible is disabled.", {
        hint: providerFailureHint("disabled", this.id)
      });
    }
    if (!this.options.baseUrl || !this.options.model || !this.options.endpointPath) {
      throw new ProviderError("missing_config", "Provider openai-compatible requires baseUrl, model, and endpointPath.", {
        hint: providerFailureHint("missing_config", this.id)
      });
    }
    if (!this.options.apiKeyEnv) {
      throw new ProviderError("missing_config", "Provider openai-compatible requires apiKeyEnv.", {
        hint: providerFailureHint("missing_config", this.id)
      });
    }
    if (!this.apiKey()) {
      throw new ProviderError("missing_api_key", `Environment variable ${this.options.apiKeyEnv} is not set.`, {
        hint: providerFailureHint("missing_api_key", this.id)
      });
    }
  }

  private apiKey(): string {
    return process.env[this.options.apiKeyEnv] ?? "";
  }

  private endpointUrl(): string {
    const base = this.options.baseUrl ?? "";
    const endpoint = this.options.endpointPath.startsWith("/")
      ? this.options.endpointPath
      : `/${this.options.endpointPath}`;
    return `${base.replace(/\/+$/, "")}${endpoint}`;
  }

  private async httpError(response: Response): Promise<ProviderError> {
    const body = previewText(await response.text().catch(() => ""));
    if (response.status === 401 || response.status === 403) {
      return new ProviderError("auth_failed", `Provider returned HTTP ${response.status}.`, {
        statusCode: response.status,
        preview: body,
        hint: providerFailureHint("auth_failed", this.id)
      });
    }
    if (response.status === 429) {
      return new ProviderError("rate_limited", "Provider returned HTTP 429.", {
        statusCode: response.status,
        preview: body,
        hint: providerFailureHint("rate_limited", this.id)
      });
    }
    return new ProviderError("http_error", `Provider returned HTTP ${response.status}.`, {
      statusCode: response.status,
      preview: body,
      hint: providerFailureHint("http_error", this.id)
    });
  }
}

function extractChatCompletionContent(json: unknown): string | undefined {
  if (!json || typeof json !== "object") {
    return undefined;
  }
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) {
    return undefined;
  }
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  return typeof first?.message?.content === "string" ? first.message.content : undefined;
}
