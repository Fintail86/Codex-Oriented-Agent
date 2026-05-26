import { Command } from "commander";
import { registerAgentSessionCommands } from "./cli_commands/agent_session_commands.js";
import { registerCapabilityShellCommands } from "./cli_commands/capability_shell_commands.js";
import { registerCodexCommands } from "./cli_commands/codex_commands.js";
import { registerConfigCommands } from "./cli_commands/config_commands.js";
import { registerGatewayCommands } from "./cli_commands/gateway_commands.js";
import { registerMemorySkillCommands } from "./cli_commands/memory_skill_commands.js";
import { registerPolicyCommands } from "./cli_commands/policy_commands.js";
import { registerProviderCommands } from "./cli_commands/provider_commands.js";
import {
  registerMvpReviewImproveCommandCommands,
  registerPendingApprovalCommands,
  registerStartRunChatCommands,
  registerStatusDoctorCommands
} from "./cli_commands/runtime_entry_commands.js";
import { registerToolCommands } from "./cli_commands/tool_commands.js";
import { COSIA_VERSION } from "./runtime/version.js";

export function createCliProgram(): Command {
  const program = new Command();

  program
    .name("cosia")
    .description("COSIA: lightweight provider-neutral agentic runtime guided by a user-amendable Codex")
    .version(COSIA_VERSION)
    .addHelpText("after", `

Normal flow:
  cosia init
  cosia provider setup
  cosia provider profile use <name>
  cosia start
  cosia chat --session <session-id>
  cosia run --session <session-id> --prompt "<request>"
  cosia status | cosia doctor
  cosia pending | cosia apply <id> --yes

Connectors:
  cosia gateway telegram enable
  cosia gateway telegram set chat-id <id>
  cosia gateway telegram set token
  cosia gateway start

Advanced governance:
  capability, tool candidate, tool active, tool blueprint, improve, command, mvp
`);

  registerStatusDoctorCommands(program);
  registerPendingApprovalCommands(program);
  registerProviderCommands(program);
  registerConfigCommands(program);
  registerGatewayCommands(program);
  registerMvpReviewImproveCommandCommands(program);
  registerAgentSessionCommands(program);
  registerMemorySkillCommands(program);
  registerPolicyCommands(program);
  registerCodexCommands(program);
  registerCapabilityShellCommands(program);
  registerToolCommands(program);
  registerStartRunChatCommands(program);

  return program;
}
