#!/usr/bin/env node
import { Command } from "commander";
import { registerAgentSessionCommands } from "./cli_commands/agent_session_commands.js";
import { registerCapabilityShellCommands } from "./cli_commands/capability_shell_commands.js";
import { registerConfigCommands } from "./cli_commands/config_commands.js";
import { registerGatewayCommands } from "./cli_commands/gateway_commands.js";
import { registerMemorySkillCommands } from "./cli_commands/memory_skill_commands.js";
import { registerPolicyCommands } from "./cli_commands/policy_commands.js";
import { registerProviderCommands } from "./cli_commands/provider_commands.js";
import {
  registerMvpReviewImproveCommandCommands,
  registerStartRunChatCommands,
  registerStatusDoctorCommands
} from "./cli_commands/runtime_entry_commands.js";
import { registerToolCommands } from "./cli_commands/tool_commands.js";
import { COSIA_VERSION } from "./runtime/version.js";

const program = new Command();

program
  .name("cosia")
  .description("COSIA: lightweight agentic runtime guided by a user-amendable Codex")
  .version(COSIA_VERSION);

registerStatusDoctorCommands(program);
registerProviderCommands(program);
registerConfigCommands(program);
registerGatewayCommands(program);
registerMvpReviewImproveCommandCommands(program);
registerAgentSessionCommands(program);
registerMemorySkillCommands(program);
registerPolicyCommands(program);
registerCapabilityShellCommands(program);
registerToolCommands(program);
registerStartRunChatCommands(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
