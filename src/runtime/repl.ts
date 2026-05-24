import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { AgentManager } from "./agent_manager.js";
import {
  applyPendingCommand,
  cancelPendingCommand,
  createCodexAmendmentPendingCommand,
  executeReadOnlyCommand,
  formatAmbiguousCommand,
  formatNeedsInput,
  formatPendingCommand,
  isPendingExpired,
  previewMutationCommand,
  type PendingCommand
} from "./runtime_command_executor.js";
import { interpretRuntimeHashCommand } from "./runtime_command_interpreter.js";
import { parseRuntimeHashCommand, retrieveRuntimeCommandCandidates } from "./runtime_command_catalog.js";
import { withSessionLock } from "./gateway_locks.js";
import { MemoryManager } from "./memory_manager.js";
import { PolicyManager } from "./policy_manager.js";
import { resolveProviderSelection } from "./model/provider_registry.js";
import { loadPromptStaticBlocks } from "./prompt_builder.js";
import { formatReviewBatchDiscard, formatReviewCleanup, formatReviewInbox, formatReviewNext, formatReviewStats, formatReviewUpdate, ReviewInboxService, type ReviewFilter, type ReviewPromoteOptions } from "./review_inbox.js";
import { runSession } from "./runner.js";
import { SessionManager } from "./session_manager.js";
import { SkillManager } from "./skill_manager.js";
import {
  formatToolGrowthActivation,
  formatToolGrowthCancelled,
  formatToolGrowthRejected,
  formatToolGrowthReview,
  formatToolGrowthRoutine,
  formatToolGrowthStart,
  formatToolGrowthTest,
  ToolGrowthManager,
  type ToolGrowthRoutine
} from "./tool_growth.js";
import { ToolAcquisitionManager } from "./tool_acquisition.js";

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
  now?: () => number;
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
    "  /review                                    Show pending memory and skill review items.",
    "  /review memory|skill                       Filter the review inbox.",
    "  /review show <index|id>                    Show a review item. Prefer id prefixes.",
    "  /review conflicts <index|id>               Show memory conflicts for a review item.",
    "  /review promote <index|id> [options]       Promote memory or preview/apply skill candidates.",
    "                                             Memory conflicts can use --replace 1 or --merge 1.",
    "  /review discard <index|id> --reason \"...\"  Discard a review item.",
    "  /review discard-conflicts --reason \"...\" [--yes]",
    "                                             Preview/apply discard for all conflicted memory candidates.",
    "  /review stats                              Show review queue statistics.",
    "  /review cleanup                            Preview discarded candidate cleanup.",
    "  /review next                               Show the oldest pending review item.",
    "  /shell <command>                           Preview a one-shot shell approval. Use #적용 to run once.",
    "  /shell cancel                              Cancel the current shell/review preview.",
    "  /tool grow <request>                        Create a tool growth routine candidate.",
    "  /tool grow show [routine-id]                Show the current or selected tool growth routine.",
    "  /tool grow test [routine-id] --yes          Run the selected candidate test.",
    "  /tool grow activate [routine-id] --agent <agent-id> --yes",
    "                                             Approve candidate design and activate explicitly.",
    "  /tool grow reject [routine-id] --reason \"...\"",
    "                                             Reject the current candidate while preserving evidence.",
    "  /tool grow retry [routine-id]               Append a new draft/candidate attempt.",
    "  /tool grow cancel [routine-id] --reason \"...\"",
    "                                             Cancel the routine without deleting evidence.",
    "",
    "Natural commands:",
    "  #상태 보여줘                              Run a COSIA status command.",
    "  #show status                              English hash commands are supported.",
    "  #리뷰 보여줘                              Show the review inbox.",
    "  #리뷰 3번 디스카드해 이유는 중복          Preview discarding a review item.",
    "  #discard all conflicting memories because duplicate",
    "                                             Preview discarding conflicted memory candidates.",
    "  #컨플릭트 메모리 전부 디스카드해 이유는 중복",
    "                                             Preview discarding conflicted memory candidates.",
    "  #쉘로 <command> 실행 제안해                Preview a one-shot shell approval.",
    "  #도구 성장 <request>                       Create a tool growth routine.",
    "  #이 도구 테스트해                          Test the current tool growth candidate.",
    "  #이 도구 활성화해                          Activate the current routine for this agent.",
    "  #이건 내가 원한 기능이 아니야 이유는 ...   Reject the current candidate.",
    "  #다른 도구 후보 만들어줘                  Retry the current routine.",
    "  #도구 생성 취소                            Cancel the current routine.",
    "  #적용                                     Apply the current pending preview.",
    "  #취소                                     Cancel the current pending preview.",
    "  #대기중인 작업 보여줘                     Show the pending preview and remaining time.",
    "  \\#해시로 시작하는 문장                    Send a leading # to the model conversation.",
    "  /exit                                      Leave chat."
  ].join("\n");
}

export async function runChatRepl(options: ChatReplOptions): Promise<ChatReplResult> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const now = options.now ?? (() => Date.now());
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
  const providerId = resolveProviderSelection(policy, options.providerId);
  const memory = new MemoryManager(options.workspaceRoot);
  const skills = new SkillManager(options.workspaceRoot);
  const reviewInbox = new ReviewInboxService(options.workspaceRoot);
  await memory.writeReferenceMemory(session, session.goal, agent.id);
  const staticBlocks = await loadPromptStaticBlocks({ workspaceRoot: options.workspaceRoot, agent, session });
  const history: Array<{ prompt: string; response: string }> = [];
  let lastPrompt = session.goal;
  const manualSkills = new Set(options.manualSkillIds ?? []);
  let pendingCommand: PendingCommand | undefined;
  let currentToolGrowthRoutineId: string | undefined;
  const rl = createInterface({ input, output });
  let endedBy: ChatReplResult["endedBy"] = "eof";

  writeLine(errorOutput, `[cosia] chat started: ${session.id}`);
  writeLine(errorOutput, "[cosia] Type /help for commands. Type /exit to leave.");
  writeLine(errorOutput, "[cosia] Use # for natural runtime commands, e.g. #상태 보여줘.");
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
      let prompt = line.trim();
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
      if (prompt === "/shell cancel") {
        if (pendingCommand) {
          try {
            writeLine(output, await cancelPendingCommand(pendingCommand, {
              workspaceRoot: options.workspaceRoot,
              session,
              agent,
              providerId,
              policy,
              sessions,
              memory,
              skills,
              reviewInbox,
              now,
              previewScope: { sessionId: session.id }
            }));
          } catch (error) {
            writeLine(output, `[FAILED] ${(error as Error).message}`);
          }
        } else {
          writeLine(output, "[BLOCKED] 적용할 대기 작업이 없습니다.");
        }
        pendingCommand = undefined;
        continue;
      }
      if (prompt.startsWith("/shell ")) {
        const command = prompt.slice("/shell ".length).trim();
        if (!command) {
          writeLine(output, "Usage: /shell <command>");
          continue;
        }
        const preview = await previewMutationCommand({
          type: "matched",
          commandId: "shell.preview",
          confidence: "high",
          args: { command, reason: "User requested a shell execution preview from chat." }
        }, {
          workspaceRoot: options.workspaceRoot,
          session,
          agent,
          providerId,
          policy,
          sessions,
          memory,
          skills,
          reviewInbox,
          now,
          previewScope: { sessionId: session.id }
        });
        pendingCommand = preview?.pending;
        writeLine(output, preview?.output ?? "[BLOCKED] Shell preview is unavailable.");
        continue;
      }
      if (prompt === "/tool grow" || prompt.startsWith("/tool grow ")) {
        try {
          const result = await handleToolGrowthSlashCommand({
            prompt,
            workspaceRoot: options.workspaceRoot,
            providerId,
            executingAgentId,
            currentRoutineId: currentToolGrowthRoutineId
          });
          currentToolGrowthRoutineId = updateCurrentToolGrowthRoutineId(currentToolGrowthRoutineId, result.routine);
          writeLine(output, result.output);
        } catch (error) {
          writeLine(output, `[FAILED] ${(error as Error).message}`);
        }
        continue;
      }
      if (prompt === "/review" || prompt.startsWith("/review ")) {
        try {
          await handleReviewCommand(prompt, reviewInbox, output);
        } catch (error) {
          writeLine(output, (error as Error).message);
        }
        continue;
      }
      if (prompt.startsWith("\\#")) {
        prompt = prompt.slice(1);
      } else if (prompt.startsWith("#")) {
        const toolGrowthHash = await handleToolGrowthHashCommand({
          prompt,
          workspaceRoot: options.workspaceRoot,
          providerId,
          executingAgentId,
          currentRoutineId: currentToolGrowthRoutineId
        });
        if (toolGrowthHash.handled) {
          currentToolGrowthRoutineId = updateCurrentToolGrowthRoutineId(currentToolGrowthRoutineId, toolGrowthHash.routine);
          writeLine(output, toolGrowthHash.output);
          continue;
        }
        let intent = parseRuntimeHashCommand(prompt);
        const commandContext = {
          workspaceRoot: options.workspaceRoot,
          session,
          agent,
          providerId,
          policy,
          sessions,
          memory,
          skills,
          reviewInbox,
          now,
          previewScope: {
            sessionId: session.id
          }
        };
        if (intent.type === "no_match") {
          const candidates = retrieveRuntimeCommandCandidates(prompt, 8, options.workspaceRoot);
          if (candidates.length === 0) {
            writeLine(output, "[BLOCKED] Natural command not recognized.");
            writeLine(output, "Try #상태 보여줘, #show status, #리뷰 보여줘, or type /help.");
            continue;
          }
          try {
            intent = await interpretRuntimeHashCommand({
              input: prompt,
              candidates,
              workspaceRoot: options.workspaceRoot,
              providerId,
              policy,
              sessionId: session.id,
              providerTimeoutMs: options.providerTimeoutMs
            });
          } catch (error) {
            writeLine(output, `[FAILED] Command interpreter failed: ${(error as Error).message}`);
            writeLine(output, "Try an exact slash command like /review, or a direct hash command like #상태 보여줘.");
            continue;
          }
        }
        if (intent.type === "needs_input") {
          writeLine(output, formatNeedsInput(intent.commandId, intent.missing, intent.hint));
          continue;
        }
        if (intent.type === "ambiguous") {
          writeLine(output, formatAmbiguousCommand(intent.candidates, intent.hint));
          continue;
        }
        if (intent.type === "no_match") {
          writeLine(output, "[BLOCKED] Natural command not recognized.");
          writeLine(output, "Try #상태 보여줘, #show status, #리뷰 보여줘, or type /help.");
          continue;
        }
        if (intent.commandId === "pending.apply") {
          if (!pendingCommand) {
            writeLine(output, "[BLOCKED] 적용할 대기 작업이 없습니다.");
            continue;
          }
          if (isPendingExpired(pendingCommand, now)) {
            pendingCommand = undefined;
            writeLine(output, "[EXPIRED] Pending command expired after 5 minutes. Please run the command again to refresh the preview.");
            continue;
          }
          try {
            writeLine(output, await withSessionLock(options.workspaceRoot, session.id, {
              owner: "cli:chat"
            }, async () => applyPendingCommand(pendingCommand!, commandContext)));
          } catch (error) {
            writeLine(output, `[FAILED] ${(error as Error).message}`);
          }
          pendingCommand = undefined;
          continue;
        }
        if (intent.commandId === "pending.cancel") {
          if (pendingCommand) {
            try {
              writeLine(output, await cancelPendingCommand(pendingCommand, commandContext));
            } catch (error) {
              writeLine(output, `[FAILED] ${(error as Error).message}`);
            }
          } else {
            writeLine(output, "[SUCCESS] Pending command cancelled.");
          }
          pendingCommand = undefined;
          continue;
        }
        if (intent.commandId === "pending.show") {
          if (!pendingCommand) {
            writeLine(output, "[BLOCKED] 적용할 대기 작업이 없습니다.");
            continue;
          }
          if (isPendingExpired(pendingCommand, now)) {
            pendingCommand = undefined;
            writeLine(output, "[EXPIRED] Pending command expired after 5 minutes. Please run the command again to refresh the preview.");
            continue;
          }
          writeLine(output, formatPendingCommand(pendingCommand, now));
          continue;
        }
        const readOnlyOutput = await executeReadOnlyCommand(intent, commandContext);
        if (readOnlyOutput !== undefined) {
          writeLine(output, readOnlyOutput);
          continue;
        }
        const preview = await previewMutationCommand(intent, commandContext);
        if (preview) {
          pendingCommand = preview.pending;
          writeLine(output, preview.output);
          continue;
        }
        writeLine(output, "[BLOCKED] This natural command is recognized but not executable yet.");
        writeLine(output, "Use the equivalent slash or CLI command shown in /help.");
        continue;
      }

      let shouldRefreshMemory = false;
      let pendingCodexAmendment: PendingCommand | undefined;
      const content = await withSessionLock(options.workspaceRoot, session.id, {
        owner: "cli:chat"
      }, async () => runSession(options.workspaceRoot, {
          sessionId: session.id,
          prompt,
          agentId: agent.id,
          sourceChannel: "repl",
          providerId,
          providerTimeoutMs: options.providerTimeoutMs,
          approveOverwriteFiles: options.approveOverwriteFiles,
          requireTools: options.requireTools,
          promptStaticBlocks: staticBlocks,
          manualSkillIds: [...manualSkills],
          stopAfterCodexAmendmentRequired: true,
          onCodexAmendmentRequired: async (request) => {
            pendingCodexAmendment = await createCodexAmendmentPendingCommand({
              path: request.path,
              content: request.content,
              reason: "Model requested a protected Codex law change through write_file.",
              workspaceRoot: options.workspaceRoot,
              now,
              ctx: {
                workspaceRoot: options.workspaceRoot,
                session,
                agent,
                providerId,
                policy,
                sessions,
                memory,
                skills,
                reviewInbox,
                now,
                previewScope: { sessionId: session.id }
              }
            });
            return pendingCodexAmendment.preview;
          },
          refreshReferenceMemory: false,
          refreshReferenceMemoryAfterRun: false,
          onMemoryReview: (summary) => {
            shouldRefreshMemory = summary.autoPromoted > 0;
          },
          onEvent: (message) => writeLine(errorOutput, `[cosia] ${message}`)
        }));
      if (pendingCodexAmendment) {
        pendingCommand = pendingCodexAmendment;
        writeLine(output, pendingCodexAmendment.preview);
        continue;
      }
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

type ToolGrowthReplResult = {
  handled?: boolean;
  output: string;
  routine?: ToolGrowthRoutine;
};

async function handleToolGrowthSlashCommand(input: {
  prompt: string;
  workspaceRoot: string;
  providerId: string;
  executingAgentId: string;
  currentRoutineId?: string;
}): Promise<ToolGrowthReplResult> {
  const rest = input.prompt.slice("/tool grow".length).trim();
  const growth = new ToolGrowthManager(input.workspaceRoot);
  const acquisition = new ToolAcquisitionManager(input.workspaceRoot);
  if (!rest) {
    return {
      output: [
        "Usage:",
        "  /tool grow <request>",
        "  /tool grow show [routine-id]",
        "  /tool grow test [routine-id] --yes",
        "  /tool grow activate [routine-id] --agent <agent-id> --yes",
        "  /tool grow reject [routine-id] --reason \"<reason>\"",
        "  /tool grow retry [routine-id]",
        "  /tool grow cancel [routine-id] --reason \"<reason>\""
      ].join("\n")
    };
  }

  const tokens = parseCommandLineArgs(rest);
  const action = tokens[0];
  if (!["review", "show", "test", "activate", "reject", "retry", "cancel"].includes(action)) {
    const result = await growth.start({
      request: rest,
      agentId: input.executingAgentId,
      providerId: input.providerId
    });
    return { output: formatToolGrowthStart(result), routine: result.routine };
  }

  const args = tokens.slice(1);
  const flags = parseFlagArgs(args);
  if (action === "review") {
    return { output: formatToolGrowthReview(growth.list({ all: flags.all === "true" })) };
  }
  const routineId = resolveToolGrowthRoutineId(args, input.currentRoutineId);
  if (!routineId) {
    return { output: "[BLOCKED] Tool growth routine id is required. Use /tool grow review or /tool grow show <routine-id>." };
  }
  if (action === "show") {
    const routine = growth.get(routineId);
    const candidate = routine.selectedCandidateId ? acquisition.getCandidate(routine.selectedCandidateId) : undefined;
    return { output: formatToolGrowthRoutine(routine, candidate), routine };
  }
  if (action === "test") {
    const result = await growth.test(routineId, { yes: flags.yes === "true" });
    return { output: formatToolGrowthTest(result), routine: result.routine };
  }
  if (action === "activate") {
    const result = await growth.activate(routineId, {
      agentId: flags.agent ?? input.executingAgentId,
      yes: flags.yes === "true"
    });
    return { output: formatToolGrowthActivation(result), routine: result.routine };
  }
  if (action === "reject") {
    if (!flags.reason) {
      throw new Error("Usage: /tool grow reject [routine-id] --reason \"<reason>\"");
    }
    const routine = growth.reject(routineId, flags.reason);
    return { output: formatToolGrowthRejected(routine), routine };
  }
  if (action === "retry") {
    const result = await growth.retry(routineId, { providerId: input.providerId });
    return { output: formatToolGrowthStart(result), routine: result.routine };
  }
  if (action === "cancel") {
    if (!flags.reason) {
      throw new Error("Usage: /tool grow cancel [routine-id] --reason \"<reason>\"");
    }
    const routine = growth.cancel(routineId, flags.reason);
    return { output: formatToolGrowthCancelled(routine), routine };
  }
  return { output: "[BLOCKED] Unknown /tool grow command." };
}

async function handleToolGrowthHashCommand(input: {
  prompt: string;
  workspaceRoot: string;
  providerId: string;
  executingAgentId: string;
  currentRoutineId?: string;
}): Promise<ToolGrowthReplResult> {
  const body = input.prompt.trim().replace(/^#/, "").trim();
  const growth = new ToolGrowthManager(input.workspaceRoot);
  try {
    const growthRequest = body.match(/^도구\s*성장\s+(.+)$/);
    if (growthRequest) {
      const result = await growth.start({
        request: growthRequest[1].trim(),
        agentId: input.executingAgentId,
        providerId: input.providerId
      });
      return { handled: true, output: formatToolGrowthStart(result), routine: result.routine };
    }
    if (/^이\s*도구\s*테스트해$/.test(body)) {
      const routineId = requireCurrentToolGrowthRoutineId(input.currentRoutineId);
      const result = await growth.test(routineId, { yes: true });
      return { handled: true, output: formatToolGrowthTest(result), routine: result.routine };
    }
    if (/^이\s*도구\s*활성화해$/.test(body)) {
      const routineId = requireCurrentToolGrowthRoutineId(input.currentRoutineId);
      const result = await growth.activate(routineId, {
        agentId: input.executingAgentId,
        yes: true
      });
      return { handled: true, output: formatToolGrowthActivation(result), routine: result.routine };
    }
    const reject = body.match(/^이건\s*내가\s*원한\s*기능이\s*아니야(?:\s*(?:이유는|사유는)\s*(.+))?$/);
    if (reject) {
      const routineId = requireCurrentToolGrowthRoutineId(input.currentRoutineId);
      const reason = reject[1]?.trim();
      if (!reason) {
        return { handled: true, output: "[BLOCKED] Reject reason is required. 예: #이건 내가 원한 기능이 아니야 이유는 원하는 동작이 아님" };
      }
      const routine = growth.reject(routineId, reason);
      return { handled: true, output: formatToolGrowthRejected(routine), routine };
    }
    if (/^다른\s*도구\s*후보\s*만들어줘$/.test(body)) {
      const routineId = requireCurrentToolGrowthRoutineId(input.currentRoutineId);
      const result = await growth.retry(routineId, { providerId: input.providerId });
      return { handled: true, output: formatToolGrowthStart(result), routine: result.routine };
    }
    if (/^도구\s*생성\s*취소$/.test(body)) {
      const routineId = requireCurrentToolGrowthRoutineId(input.currentRoutineId);
      const routine = growth.cancel(routineId, "user cancelled tool growth routine");
      return { handled: true, output: formatToolGrowthCancelled(routine), routine };
    }
  } catch (error) {
    return { handled: true, output: `[FAILED] ${(error as Error).message}` };
  }
  return { handled: false, output: "" };
}

function updateCurrentToolGrowthRoutineId(current: string | undefined, routine: ToolGrowthRoutine | undefined): string | undefined {
  if (!routine) {
    return current;
  }
  return ["activated", "cancelled"].includes(routine.status) ? undefined : routine.id;
}

function requireCurrentToolGrowthRoutineId(current: string | undefined): string {
  if (!current) {
    throw new Error("Tool growth routine id is required. Start one with #도구 성장 <request> or use /tool grow show <routine-id>.");
  }
  return current;
}

function resolveToolGrowthRoutineId(tokens: string[], current: string | undefined): string | undefined {
  const positional = positionalArgs(tokens);
  return positional[0] ?? current;
}

function positionalArgs(tokens: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith("--")) {
      const next = tokens[index + 1];
      if (next && !next.startsWith("--")) {
        index += 1;
      }
      continue;
    }
    result.push(token);
  }
  return result;
}

async function handleReviewCommand(prompt: string, reviewInbox: ReviewInboxService, output: Writable): Promise<void> {
  if (prompt === "/review" || prompt === "/review memory" || prompt === "/review skill") {
    const filter: ReviewFilter = prompt === "/review memory" ? "memory" : prompt === "/review skill" ? "skill" : "all";
    writeLine(output, formatReviewInbox(await reviewInbox.list(filter)));
    return;
  }
  if (prompt === "/review next") {
    const inbox = await reviewInbox.list("all");
    writeLine(output, formatReviewNext(inbox.items[0]));
    return;
  }
  if (prompt === "/review stats") {
    writeLine(output, formatReviewStats(await reviewInbox.stats()));
    return;
  }
  if (prompt === "/review cleanup") {
    writeLine(output, formatReviewCleanup(await reviewInbox.cleanup({ yes: false })));
    return;
  }
  if (prompt.startsWith("/review show ")) {
    const ref = prompt.slice("/review show ".length).trim();
    writeLine(output, await reviewInbox.formatItemDetail(ref));
    return;
  }
  if (prompt.startsWith("/review conflicts ")) {
    const ref = prompt.slice("/review conflicts ".length).trim();
    writeLine(output, await reviewInbox.formatConflicts(ref));
    return;
  }
  if (prompt.startsWith("/review promote ")) {
    const tokens = parseCommandLineArgs(prompt.slice("/review promote ".length));
    const ref = tokens.find((token) => !token.startsWith("--"));
    if (!ref) {
      throw new Error("Usage: /review promote <index|id> [--yes] [--force] [--replace <memory-id>] [--merge <memory-id>] [--content \"<content>\"] [--prefer-for <agent-id>] [--confirm-high-risk \"<phrase>\"]");
    }
    const flags = parseFlagArgs(tokens);
    const options: ReviewPromoteOptions = {
      yes: flags.yes === "true",
      force: flags.force === "true",
      replaceMemoryId: flags.replace,
      mergeMemoryId: flags.merge,
      mergeContent: flags.content,
      preferFor: flags["prefer-for"],
      confirmHighRisk: flags["confirm-high-risk"]
    };
    const result = await reviewInbox.promote(ref, options);
    writeLine(output, result.output);
    writeLine(output, formatReviewUpdate(result.inbox));
    return;
  }
  if (prompt.startsWith("/review discard-conflicts")) {
    const tokens = parseCommandLineArgs(prompt.slice("/review discard-conflicts".length));
    const flags = parseFlagArgs(tokens);
    if (!flags.reason) {
      throw new Error("Usage: /review discard-conflicts --reason \"<reason>\" [--yes]");
    }
    const result = await reviewInbox.discardConflictingMemoryCandidates(flags.reason, {
      yes: flags.yes === "true"
    });
    writeLine(output, formatReviewBatchDiscard(result));
    if (result.applied) {
      writeLine(output, formatReviewUpdate(result.inbox));
    }
    return;
  }
  if (prompt.startsWith("/review discard ")) {
    const tokens = parseCommandLineArgs(prompt.slice("/review discard ".length));
    const ref = tokens.find((token) => !token.startsWith("--"));
    if (!ref) {
      throw new Error("Usage: /review discard <index|id> --reason \"<reason>\"");
    }
    const flags = parseFlagArgs(tokens);
    if (!flags.reason) {
      throw new Error("Usage: /review discard <index|id> --reason \"<reason>\"");
    }
    const result = await reviewInbox.discard(ref, flags.reason);
    writeLine(output, result.output);
    writeLine(output, formatReviewUpdate(result.inbox));
    return;
  }
  throw new Error(`Unknown review command. Try /review or /help: ${prompt}`);
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
