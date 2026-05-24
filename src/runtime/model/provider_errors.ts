import type { ProviderFailureReason } from "../types.js";

export type ProviderErrorOptions = {
  hint?: string;
  preview?: string;
  statusCode?: number;
  cause?: unknown;
};

export class ProviderError extends Error {
  readonly reason: ProviderFailureReason;
  readonly hint?: string;
  readonly preview?: string;
  readonly statusCode?: number;

  constructor(reason: ProviderFailureReason, message: string, options: ProviderErrorOptions = {}) {
    super(message);
    this.name = "ProviderError";
    this.reason = reason;
    this.hint = options.hint;
    this.preview = options.preview;
    this.statusCode = options.statusCode;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

export function providerErrorFromUnknown(error: unknown, fallbackReason: ProviderFailureReason = "malformed_response"): ProviderError {
  if (isProviderError(error)) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(fallbackReason, message, { cause: error });
}

export function previewText(value: string | undefined, maxChars = 800): string {
  const text = (value ?? "").trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

export function providerFailureHint(reason: ProviderFailureReason, providerId: string): string {
  switch (reason) {
    case "cli_missing":
      return providerId === "openai-codex"
        ? "Install a Codex build with `codex app-server` support, or choose another provider profile."
        : "Install the Codex CLI and make sure `codex` is available on PATH.";
    case "auth_failed":
      return providerId === "openai-codex"
        ? "Run `cosia provider oauth login <profile>` and then `cosia provider profile check <profile>`."
        : providerId === "codex-cli"
        ? "Run `codex login` and verify with `codex login status`."
        : "Check the provider API key and authentication settings.";
    case "disabled":
      return `Run \`cosia provider setup --provider ${providerId}\` or create and select an explicit provider profile.`;
    case "missing_config":
      return `Run \`cosia provider setup --provider ${providerId}\`, then \`cosia provider profile use <name>\`.`;
    case "missing_api_key":
      return "Configure the provider profile API key with hidden input or an environment variable.";
    case "timeout":
      return "Increase --provider-timeout-ms or check whether the provider is hanging.";
    case "rate_limited":
      return "Wait and retry, or use another configured provider.";
    case "network_error":
      return "Check network reachability and provider baseUrl.";
    case "http_error":
      return "Check provider URL, model name, request compatibility, and server response.";
    case "malformed_response":
      return "The provider returned a response shape COSIA could not read.";
    case "malformed_agent_step":
      return "The model did not return valid AgentStep JSON after structured retry.";
    case "unknown_provider":
      return "Run `cosia provider list-supported`, then `cosia provider setup` or choose a configured provider profile.";
  }
}

export function formatProviderFailure(error: unknown, providerId: string): string {
  const providerError = providerErrorFromUnknown(error);
  const hint = providerError.hint ?? providerFailureHint(providerError.reason, providerId);
  const parts = [
    `Provider ${providerId} failed [${providerError.reason}]: ${providerError.message}`,
    `Hint: ${hint}`
  ];
  if (providerError.preview) {
    parts.push(`Preview: ${providerError.preview}`);
  }
  return parts.join("\n");
}
