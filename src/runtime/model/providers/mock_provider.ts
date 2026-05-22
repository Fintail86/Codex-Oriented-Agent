import { parseModelOutput } from "../model_provider.js";
import type { AuthStatus, ModelInput, ModelOutput, ModelProvider } from "../../types.js";
import { modelExposedToolIds } from "../../tool_catalog.js";

const finalAfterToolResultPattern = new RegExp(
  `Tool: (${modelExposedToolIds.filter((tool) => tool !== "write_file").map(escapeRegex).join("|")})`
);

export class MockProvider implements ModelProvider {
  readonly id = "mock";

  async checkAuth(): Promise<AuthStatus> {
    return { ok: true, message: "Mock provider does not require authentication." };
  }

  async complete(input: ModelInput): Promise<ModelOutput> {
    const normalizedPrompt = input.prompt.toLowerCase();
    if (normalizedPrompt.includes("call read_file on a relevant path before returning final") && !input.prompt.includes("Tool: read_file")) {
      return parseModelOutput(JSON.stringify({
        type: "tool_call",
        tool: "read_file",
        args: { path: "codex/RULES.md" }
      }));
    }

    if (finalAfterToolResultPattern.test(input.prompt)) {
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mockToolArgs(tool: string, value: string): Record<string, unknown> {
  if (tool === "search_files") {
    return { query: value };
  }
  if (tool === "git_log") {
    return value ? { maxCount: Number.parseInt(value, 10) } : {};
  }
  if (tool === "git_diff") {
    return value ? { path: value } : {};
  }
  if (tool === "git_status" || tool === "npm_test" || tool === "npm_typecheck") {
    return {};
  }
  return { path: value };
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
