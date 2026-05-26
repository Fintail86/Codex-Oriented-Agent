import type { Command } from "commander";
import { registerMemoryCommands } from "./memory_commands.js";
import { registerSkillCommands } from "./skill_commands.js";

export function registerMemorySkillCommands(program: Command): void {
  registerMemoryCommands(program);
  registerSkillCommands(program);
}
