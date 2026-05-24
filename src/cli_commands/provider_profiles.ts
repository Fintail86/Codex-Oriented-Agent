import type { Command } from "commander";
import { checkProvider } from "../runtime/model/provider_registry.js";
import { PolicyManager } from "../runtime/policy_manager.js";
import {
  addProviderProfile,
  formatProviderProfileAdded,
  formatProviderProfileList,
  formatProviderProfileShow,
  formatProviderProfileUsed,
  listProviderProfileSummaries,
  removeProviderProfile,
  requireProviderProfile,
  useProviderProfile
} from "../runtime/provider_profiles.js";

type CliMain = (
  fn: (workspaceRoot: string) => Promise<void>,
  options?: { allowUninitialized?: boolean }
) => Promise<void>;

export function registerProviderProfileCommands(
  providerCommand: Command,
  deps: {
    main: CliMain;
    promptHidden: (prompt: string) => Promise<string>;
  }
): void {
  const providerProfile = providerCommand.command("profile").description("Manage explicit provider profiles.");

  providerProfile
    .command("add")
    .argument("<name>")
    .requiredOption("--provider <provider-id>", "Provider implementation id, e.g. openrouter, openai-compatible, codex-cli.")
    .option("--oauth", "Use provider-managed OAuth status. For codex-cli this uses an explicit Codex CLI-backed profile.", false)
    .option("--api-key", "Prompt for an API key and store it in the private secret store.", false)
    .option("--api-key-env <env-name>", "Read the API key from an environment variable.")
    .option("--model <model-id>", "Model id for OpenAI-compatible providers.")
    .option("--base-url <url>", "Base URL for openai-compatible providers.")
    .description("Add or update a provider profile.")
    .action(async (name: string, options: {
      provider: string;
      oauth: boolean;
      apiKey: boolean;
      apiKeyEnv?: string;
      model?: string;
      baseUrl?: string;
    }) => {
      await deps.main(async (workspaceRoot) => {
        const authModes = [options.oauth, options.apiKey, Boolean(options.apiKeyEnv)].filter(Boolean).length;
        if (authModes !== 1) {
          throw new Error("Choose exactly one auth mode: --oauth, --api-key, or --api-key-env <ENV_NAME>.");
        }
        if (options.oauth && options.provider !== "codex-cli") {
          throw new Error("--oauth is currently supported for --provider codex-cli.");
        }
        const apiKey = options.apiKey ? await deps.promptHidden("API key: ") : undefined;
        console.log(formatProviderProfileAdded(await addProviderProfile(workspaceRoot, name, {
          providerId: options.provider,
          oauth: options.oauth,
          apiKey,
          apiKeyEnv: options.apiKeyEnv,
          model: options.model,
          baseUrl: options.baseUrl
        })));
      });
    });

  providerProfile
    .command("use")
    .argument("<name>")
    .description("Select the active provider profile.")
    .action(async (name: string) => {
      await deps.main(async (workspaceRoot) => {
        console.log(formatProviderProfileUsed(await useProviderProfile(workspaceRoot, name)));
      });
    });

  providerProfile
    .command("list")
    .description("List provider profiles without printing secrets.")
    .action(async () => {
      await deps.main(async (workspaceRoot) => {
        console.log(formatProviderProfileList(await listProviderProfileSummaries(workspaceRoot)));
      });
    });

  providerProfile
    .command("show")
    .argument("<name>")
    .description("Show one provider profile without printing secrets.")
    .action(async (name: string) => {
      await deps.main(async (workspaceRoot) => {
        const item = (await listProviderProfileSummaries(workspaceRoot)).find((profile) => profile.name === name);
        if (!item) {
          throw new Error(`Provider profile not found: ${name}`);
        }
        console.log(formatProviderProfileShow(item));
      });
    });

  providerProfile
    .command("check")
    .argument("[name]")
    .description("Check a provider profile configuration and auth status.")
    .action(async (name?: string) => {
      await deps.main(async (workspaceRoot) => {
        const policy = await new PolicyManager(workspaceRoot).loadPolicy();
        const profileName = name ?? policy.model.activeProviderProfile;
        if (!profileName) {
          throw new Error("No active provider profile is configured. Run `cosia provider profile use <name>`.");
        }
        await requireProviderProfile(workspaceRoot, profileName);
        const result = await checkProvider(profileName, workspaceRoot, policy);
        console.log(`Provider profile: ${profileName}`);
        console.log(`Status: ${result.ok ? "ok" : "failed"}`);
        console.log(`Message: ${result.message}`);
        if (result.reason) {
          console.log(`Reason: ${result.reason}`);
        }
        if (result.hint) {
          console.log(`Hint: ${result.hint}`);
        }
      });
    });

  providerProfile
    .command("remove")
    .argument("<name>")
    .description("Remove a provider profile and its private API key, if present.")
    .action(async (name: string) => {
      await deps.main(async (workspaceRoot) => {
        const removed = await removeProviderProfile(workspaceRoot, name);
        console.log(removed ? `Provider profile removed: ${name}` : `Provider profile not found: ${name}`);
      });
    });
}
