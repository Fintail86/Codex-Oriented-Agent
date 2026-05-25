import { parseModelOutput } from "../model_provider.js";
import { ProviderError } from "../provider_errors.js";
import type { AuthStatus, ModelInput, ModelOutput, ModelProvider } from "../../types.js";

const toolResultPattern = /^Tool: ([a-zA-Z0-9_.-]+)/gm;

export class MockProvider implements ModelProvider {
  readonly id = "mock";

  async checkAuth(): Promise<AuthStatus> {
    return { ok: true, message: "Mock provider does not require authentication." };
  }

  async complete(input: ModelInput): Promise<ModelOutput> {
    const normalizedPrompt = input.prompt.toLowerCase();
    if (input.prompt.includes("[MOCK_SLOW_FINAL]")) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (input.prompt.includes("# BEGIN PENDING TOOL GROWTH REQUEST")) {
      return parseModelOutput(JSON.stringify({
        type: "final",
        content: "좋아. 방금 제안한 도구 생성 루틴을 시작할게.",
        memoryCandidates: [],
        skillCandidates: [],
        toolGrowthRequest: null,
        toolGrowthDecision: {
          action: "start",
          reason: "Mock provider interpreted the user reply as approval to start the pending tool-growth routine."
        }
      }));
    }
    if (input.prompt.includes("TOOL_DRAFT_REQUEST")) {
      return parseModelOutput(JSON.stringify({
        type: "final",
        content: JSON.stringify({
          targetToolId: "local.project_check.mock",
          capabilityFamily: "project_check",
          permission: "project_check",
          exposure: "model",
          executorKind: "command_adapter",
          executorPlan: {
            executable: "node",
            args: ["--version"],
            cwdPolicy: "workspace_root",
            timeoutMs: 30000,
            outputCapBytes: 12000,
            redaction: false
          },
          inputSchemaDraft: {
            type: "object",
            properties: {}
          },
          safetyRationale: "Mock project check draft.",
          testPlan: "Run the fixed command once with output cap.",
          rollbackPlan: "Deactivate the active tool and remove it from agent allowedTools.",
          groundingReferences: []
        }),
        memoryCandidates: [],
        skillCandidates: []
      }));
    }
    if (input.prompt.includes("[MOCK_TOOL_GROWTH_REQUEST]")) {
      return parseModelOutput(JSON.stringify({
        type: "final",
        content: "To answer this, COSIA needs a read-only memory promotion queue inspector. It would list pending memory candidates and next actions without mutating anything. Should I start the tool creation routine?",
        memoryCandidates: [],
        skillCandidates: [],
        toolGrowthRequest: {
          request: "read-only memory promotion queue inspector",
          capabilityName: "memory_promotion_queue_read",
          summary: "Inspect pending memory candidates, risk, conflicts, and next actions without mutating files, approvals, memory, tools, policy, or connectors.",
          readOnly: true
        }
      }));
    }
    if (input.prompt.includes("[MOCK_FINAL_TIMEOUT_AFTER_REVIEW_TOOL]") && input.prompt.includes("Tool: review_inbox_read")) {
      throw new ProviderError("timeout", "Mock provider timed out after review_inbox_read.");
    }
    if (input.prompt.includes("[MOCK_FINAL_TIMEOUT_AFTER_REVIEW_TOOL]") && !input.prompt.includes("Tool: review_inbox_read")) {
      return parseModelOutput(JSON.stringify({
        type: "tool_call",
        tool: "review_inbox_read",
        args: { filter: "memory" }
      }));
    }
    if (normalizedPrompt.includes("call read_file on a relevant path before returning final") && !input.prompt.includes("Tool: read_file")) {
      return parseModelOutput(JSON.stringify({
        type: "tool_call",
        tool: "read_file",
        args: { path: "codex/RULES.md" }
      }));
    }

    if (hasNonWriteToolResult(input.prompt)) {
      return parseModelOutput(JSON.stringify({
        type: "final",
        content: `Mock response for ${input.sessionId}.`,
        memoryCandidates: mockMemoryCandidates(input.prompt)
          ?? (input.prompt.includes("[MOCK_CANDIDATE]")
          ? [{
              scope: "project",
              kind: "note",
              content: "Mock candidate memory",
              importance: 3,
              confidence: 0.8
            }]
          : []),
        skillCandidates: mockSkillCandidates(input.prompt)
      }));
    }

    if (input.prompt.includes("# TOOL RESULTS") && !input.prompt.includes("Runtime rejection")) {
      return parseModelOutput(JSON.stringify({
        type: "final",
        content: `Mock response for ${input.sessionId}.`,
        memoryCandidates: mockMemoryCandidates(input.prompt)
          ?? (input.prompt.includes("[MOCK_CANDIDATE]")
          ? [{
              scope: "project",
              kind: "note",
              content: "Mock candidate memory",
              importance: 3,
              confidence: 0.8
            }]
          : []),
        skillCandidates: mockSkillCandidates(input.prompt)
      }));
    }

    const writeOnly = input.prompt.match(/\[MOCK_WRITE_ONLY:([^\]]+)\]/);
    if (writeOnly && !input.prompt.includes("Runtime rejection")) {
      return parseModelOutput(JSON.stringify({
        type: "tool_call",
        tool: "write_file",
        args: { path: writeOnly[1], content: "mock write" }
      }));
    }

    const match = input.prompt.match(/\[MOCK_TOOL_CALL:([a-z_]+)(?::([^\]]+))?\]/);
    if (match && !input.prompt.includes("# TOOL RESULTS")) {
      const tool = match[1];
      const value = match[2] ?? "";
      const raw = JSON.stringify({
        type: "tool_call",
        tool,
        args: mockToolArgs(tool, value)
      });
      return parseModelOutput(raw);
    }

    if (input.prompt.includes("require-tools mode") || input.prompt.includes("Runtime rejection")) {
      return parseModelOutput(JSON.stringify({
        type: "tool_call",
        tool: "search_files",
        args: { query: "COSIA" }
      }));
    }

    return parseModelOutput(JSON.stringify({
      type: "final",
      content: `Mock response for ${input.sessionId}.`,
      memoryCandidates: mockMemoryCandidates(input.prompt)
        ?? (input.prompt.includes("[MOCK_CANDIDATE]")
        ? [{
            scope: "project",
            kind: "note",
            content: "Mock candidate memory",
            importance: 3,
            confidence: 0.8
          }]
        : []),
      skillCandidates: mockSkillCandidates(input.prompt)
    }));
  }
}

function mockToolArgs(tool: string, value: string): Record<string, unknown> {
  if (tool === "search_files") {
    return { query: value };
  }
  if (tool === "shell_request") {
    return {
      command: value || "echo COSIA shell preview",
      reason: "Mock shell preview request."
    };
  }
  return { path: value };
}

function hasNonWriteToolResult(prompt: string): boolean {
  toolResultPattern.lastIndex = 0;
  return [...prompt.matchAll(toolResultPattern)].some((match) => match[1] !== "write_file");
}

function mockMemoryCandidates(prompt: string) {
  if (prompt.includes("[MOCK_SESSION_CANDIDATE]")) {
    return [{
      tier: "session",
      kind: "note",
      content: "Mock session candidate memory",
      importance: 3,
      confidence: 0.8
    }];
  }
  if (prompt.includes("[MOCK_AGENT_CANDIDATE]")) {
    return [{
      tier: "agent",
      kind: "note",
      content: "Mock agent candidate memory",
      importance: 3,
      confidence: 0.8
    }];
  }
  if (prompt.includes("[MOCK_CORE_CANDIDATE]")) {
    return [{
      tier: "core",
      kind: "note",
      content: "Mock core candidate memory",
      importance: 3,
      confidence: 0.8
    }];
  }
  return undefined;
}

function mockSkillCandidates(prompt: string) {
  if (prompt.includes("[MOCK_SKILL_CANDIDATE_SECRET]")) {
    return [{
      agentId: "architect-agent",
      skillName: "Secret Handling Skill",
      reason: "Mock secret candidate.",
      content: "Use token = \"sk-testsecret1234567890\" when testing.",
      triggers: ["secret handling"],
      riskLevel: "low"
    }];
  }
  if (prompt.includes("[MOCK_SKILL_CANDIDATE_NO_TRIGGERS]")) {
    return [{
      agentId: "architect-agent",
      skillName: "Manual Only Skill",
      reason: "Mock manual skill candidate.",
      content: "Use this skill only when explicitly selected.",
      triggers: [],
      riskLevel: "low"
    }];
  }
  if (prompt.includes("[MOCK_SKILL_CANDIDATE]")) {
    return [{
      agentId: "architect-agent",
      skillName: "Git Commit Convention",
      reason: "Mock skill candidate.",
      content: "When asked about git commits, inspect git status and write concise commit messages.",
      triggers: ["git", "commit"],
      riskLevel: "low"
    }];
  }
  return [];
}
