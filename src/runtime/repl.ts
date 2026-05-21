import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { AgentManager } from "./agent_manager.js";
import { MemoryManager } from "./memory_manager.js";
import { PolicyManager } from "./policy_manager.js";
import { loadPromptStaticBlocks } from "./prompt_builder.js";
import { runSession } from "./runner.js";
import { SessionManager } from "./session_manager.js";
import { SkillManager } from "./skill_manager.js";

export type ChatReplOptions = {
  workspaceRoot: string;
  sessionId: string;
  agentId?: string;
  providerId?: string;
  providerTimeoutMs?: number;
  approveOverwriteFiles?: boolean;
  requireTools?: boolean;
  manualSkillIds?: string[];
  input?: Readable;
  output?: Writable;
  errorOutput?: Writable;
};

export type ChatReplResult = {
  turns: number;
  endedBy: "exit" | "eof";
};

export function formatChatHelp(): string {
  return [
    "COSIA chat commands:",
    "  /help                                      Show this command list.",
    "  /status                                    Show session, provider, budget, context, and selected skills.",
    "  /context status                            Show context health.",
    "  /context compact --keep-last <n> --reason \"<reason>\" [--yes]",
    "                                             Preview/apply context compaction.",
    "  /summary show                              Show SESSION_SUMMARY.md.",
    "  /summary update <summary>                  Replace SESSION_SUMMARY.md content.",
    "  /memory refresh                            Regenerate REF_MEMORY.md.",
    "  /skills list                               List global skills and current selection state.",
    "  /skills use <id>                           Manually include a skill.",
    "  /skills drop <id>                          Remove a manually selected skill.",
    "  /skills clear                              Clear manual skill selections.",
    "  /exit                                      Leave chat."
  ].join("\n");
}

export async function runChatRepl(options: ChatReplOptions): Promise<ChatReplResult> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const sessions = new SessionManager(options.workspaceRoot);
  const session = await sessions.loadSession(options.sessionId);
  await sessions.ensureSessionSupportFiles(session.id);
  const executingAgentId = options.agentId ?? session.assignedAgentId;
  if (!executingAgentId) {
    throw new Error(`Session has no assigned agent. Run \`cosia session assign ${session.id} --agent <agent-id>\` or pass --agent <agent-id>.`);
  }
  const agent = await new AgentManager(options.workspaceRoot).loadAgent(executingAgentId);
  const policyManager = new PolicyManager(options.workspaceRoot);
  const policy = await policyManager.loadPolicy();
  if (await policyManager.ensureMarkdownCurrent()) {
    writeLine(errorOutput, "[cosia] policy mirror synced from POLICY.json");
  }
  const providerId = !options.providerId || options.providerId === "default"
    ? policy.model.defaultProvider
    : options.providerId;
  const memory = new MemoryManager(options.workspaceRoot);
  const skills = new SkillManager(options.workspaceRoot);
  await memory.writeReferenceMemory(session, session.goal, agent.id);
  const staticBlocks = await loadPromptStaticBlocks({ workspaceRoot: options.workspaceRoot, agent, session });
  const history: Array<{ prompt: string; response: string }> = [];
  let lastPrompt = session.goal;
  const manualSkills = new Set(options.manualSkillIds ?? []);
  const rl = createInterface({ input, output });
  let endedBy: ChatReplResult["endedBy"] = "eof";

  writeLine(errorOutput, `[cosia] chat started: ${session.id}`);
  writeLine(errorOutput, "[cosia] Type /help for commands. Type /exit to leave.");
  const lineIterator = rl[Symbol.asyncIterator]();
  try {
    while (true) {
      output.write("cosia> ");
      const next = await lineIterator.next();
      if (next.done) {
        endedBy = "eof";
        break;
      }
      const line = next.value;
      const prompt = line.trim();
      if (!prompt) {
        continue;
      }
      if (prompt === "/exit") {
        endedBy = "exit";
        writeLine(errorOutput, `[cosia] chat ended after ${history.length} turn(s).`);
        const status = await sessions.contextStatus(session.id, {
          warningChars: policy.promptBudget.contextWarningChars,
          criticalChars: policy.promptBudget.contextCriticalChars
        });
        if (status.level !== "ok" || status.summaryIsPlaceholder) {
          writeLine(errorOutput, `[cosia] summary hint: cosia session summarize ${session.id} --content "<summary>"`);
        }
        if (status.level !== "ok" || status.compactRecommended) {
          writeLine(errorOutput, `[cosia] context hint: cosia session context compact ${session.id} --keep-last 5 --reason "<reason>"`);
        }
        break;
      }
      if (prompt === "/help") {
        writeLine(output, formatChatHelp());
        continue;
      }
      if (prompt === "/status") {
        writeLine(output, `Session: ${session.id}`);
        writeLine(output, `Assigned agent: ${session.assignedAgentId ?? "none"}`);
        writeLine(output, `Executing agent: ${agent.id}`);
        writeLine(output, `Provider: ${providerId}`);
        writeLine(output, `Prompt budget: ${policy.promptBudget.maxPromptChars} chars`);
        writeLine(output, `Context tail: ${policy.promptBudget.contextTailChars} chars`);
        writeLine(output, `Manual skills: ${manualSkills.size ? [...manualSkills].join(", ") : "none"}`);
        const health = await sessions.contextStatus(session.id, {
          warningChars: policy.promptBudget.contextWarningChars,
          criticalChars: policy.promptBudget.contextCriticalChars
        });
        writeLine(output, "Context status:");
        writeLine(output, formatContextStatus(health));
        if (health.level !== "ok" || health.compactRecommended) {
          writeLine(output, contextMaintenanceHint(session.id));
        }
        writeLine(output, `Turns in this REPL: ${history.length}`);
        continue;
      }
      if (prompt === "/context status") {
        const status = await sessions.contextStatus(session.id, {
          warningChars: policy.promptBudget.contextWarningChars,
          criticalChars: policy.promptBudget.contextCriticalChars
        });
        writeLine(output, formatContextStatus(status));
        if (status.level !== "ok" || status.compactRecommended) {
          writeLine(output, contextMaintenanceHint(session.id));
        }
        continue;
      }
      if (prompt.startsWith("/context compact ")) {
        const args = parseCommandLineArgs(prompt.slice("/context compact ".length));
        const flags = parseFlagArgs(args);
        const keepLast = flags["keep-last"];
        const reason = flags.reason;
        if (!keepLast || !reason) {
          throw new Error("Usage: /context compact --keep-last <n> --reason \"<reason>\" [--yes] [--allow-empty-summary]");
        }
        const result = await sessions.compactContext(session.id, {
          keepLast: parseIntegerOption(keepLast, "keep-last"),
          reason,
          apply: flags.yes === "true",
          allowEmptySummary: flags["allow-empty-summary"] === "true"
        });
        writeLine(output, formatContextCompactResult(result));
        if (result.blocked) {
          writeLine(output, contextMaintenanceHint(session.id));
        } else if (!result.applied && result.archivedRuns > 0) {
          writeLine(output, "Re-run the same /context compact command with --yes to apply.");
        }
        continue;
      }
      if (prompt === "/summary show") {
        const source = await sessions.summarySource(session.id, policy.promptBudget.contextTailChars);
        writeLine(output, source.existingSummary || "# SESSION SUMMARY\n\nNo compact session summary yet.");
        continue;
      }
      if (prompt.startsWith("/summary update ")) {
        const summary = prompt.slice("/summary update ".length).trim();
        if (!summary) {
          throw new Error("Usage: /summary update <summary>");
        }
        await sessions.updateSummary(session.id, summary);
        writeLine(errorOutput, `[cosia] updated SESSION_SUMMARY.md for ${session.id}`);
        continue;
      }
      if (prompt === "/memory refresh") {
        await memory.writeReferenceMemory(session, lastPrompt, agent.id);
        writeLine(errorOutput, `[cosia] refreshed REF_MEMORY.md for ${session.id}`);
        continue;
      }
      if (prompt === "/skills list") {
        const globalSkills = skills.listSkills();
        if (!globalSkills.length) {
          writeLine(output, "No global skills.");
        } else {
          for (const item of globalSkills) {
            const state = agent.blockedSkills.includes(item.id)
              ? "blocked"
              : manualSkills.has(item.id)
                ? "selected"
                : agent.preferredSkills.includes(item.id)
                  ? "preferred"
                  : "available";
            const weight = agent.skillWeights?.[item.id] ? ` weight:${agent.skillWeights[item.id]}` : "";
            writeLine(output, `${item.id}\t${state}${weight}\t${item.manualOnly ? "manual-only" : `triggers:${item.triggers.join(",")}`}`);
          }
        }
        continue;
      }
      if (prompt.startsWith("/skills use ")) {
        const skillId = prompt.slice("/skills use ".length).trim();
        const skill = skills.getSkill(skillId);
        if (agent.blockedSkills.includes(skill.id)) {
          throw new Error(`Skill is blocked for ${agent.id}: ${skill.id}`);
        }
        manualSkills.add(skill.id);
        writeLine(errorOutput, `[cosia] selected skill ${skill.id}`);
        continue;
      }
      if (prompt.startsWith("/skills drop ")) {
        const skillId = prompt.slice("/skills drop ".length).trim();
        const skill = skills.getSkill(skillId);
        manualSkills.delete(skill.id);
        writeLine(errorOutput, `[cosia] dropped skill ${skill.id}`);
        continue;
      }
      if (prompt === "/skills clear") {
        manualSkills.clear();
        writeLine(errorOutput, "[cosia] cleared manual skills");
        continue;
      }

      let shouldRefreshMemory = false;
      const content = await runSession(options.workspaceRoot, {
        sessionId: session.id,
        prompt,
        agentId: agent.id,
        providerId,
        providerTimeoutMs: options.providerTimeoutMs,
        approveOverwriteFiles: options.approveOverwriteFiles,
        requireTools: options.requireTools,
        promptStaticBlocks: staticBlocks,
        manualSkillIds: [...manualSkills],
        refreshReferenceMemory: false,
        refreshReferenceMemoryAfterRun: false,
        onMemoryReview: (summary) => {
          shouldRefreshMemory = summary.autoPromoted > 0;
        },
        onEvent: (message) => writeLine(errorOutput, `[cosia] ${message}`)
      });
      history.push({ prompt, response: content });
      lastPrompt = prompt;
      writeLine(output, content);
      if (shouldRefreshMemory) {
        await memory.writeReferenceMemory(session, prompt, agent.id);
        writeLine(errorOutput, "[cosia] refreshed REF_MEMORY.md after memory auto-promotion");
      }
    }
  } finally {
    rl.close();
  }
  return { turns: history.length, endedBy };
}

function writeLine(stream: Writable, value = ""): void {
  stream.write(`${value}\n`);
}

function formatContextStatus(status: {
  sessionId: string;
  chars: number;
  warningChars: number;
  criticalChars: number;
  level: string;
  runEntryCount: number;
  archiveEntryCount: number;
  summaryIsPlaceholder: boolean;
  compactRecommended: boolean;
}): string {
  return [
    `Session: ${status.sessionId}`,
    `Context: ${status.level} ${status.chars} chars (warning:${status.warningChars}, critical:${status.criticalChars})`,
    `Run entries: ${status.runEntryCount}`,
    `Archived entries: ${status.archiveEntryCount}`,
    `Summary placeholder: ${status.summaryIsPlaceholder}`,
    `Compact recommended: ${status.compactRecommended}`
  ].join("\n");
}

function formatContextCompactResult(result: {
  applied: boolean;
  blocked: boolean;
  movedAt?: string;
  message: string;
  contextCharsBefore: number;
  contextCharsAfter: number;
  keptRuns: number;
  archivedRuns: number;
  summaryIsPlaceholder: boolean;
}): string {
  const lines = [
    result.message,
    `Applied: ${result.applied}`,
    `Blocked: ${result.blocked}`,
    `Kept runs: ${result.keptRuns}`,
    `Archived runs: ${result.archivedRuns}`,
    `Context chars: ${result.contextCharsBefore} -> ${result.contextCharsAfter}`,
    `Summary placeholder: ${result.summaryIsPlaceholder}`
  ];
  if (result.movedAt) {
    lines.push(`Moved at: ${result.movedAt}`);
  }
  return lines.join("\n");
}

function contextMaintenanceHint(sessionId: string): string {
  return [
    "Suggested context maintenance:",
    `- cosia session context status ${sessionId}`,
    `- cosia session prompt ${sessionId} --latest`,
    `- cosia session summarize ${sessionId} --content \"<summary>\"`,
    `- cosia session summarize ${sessionId} --from-context --provider <provider>`,
    `- cosia session context compact ${sessionId} --keep-last 5 --reason \"<reason>\"`,
    `- cosia session context undo-last ${sessionId} --reason \"<reason>\"`
  ].join("\n");
}

function parseIntegerOption(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function parseCommandLineArgs(value: string): string[] {
  const matches = value.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g);
  return [...matches].map((match) => match[1] ?? match[2] ?? match[3]);
}

function parseFlagArgs(tokens: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = tokens[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}
