import { join } from "node:path";
import { readText } from "./fs_utils.js";
import type { AgentManifest, SessionMetadata } from "./types.js";

type PromptInput = {
  workspaceRoot: string;
  agent: AgentManifest;
  session: SessionMetadata;
  userPrompt: string;
  toolResults?: string[];
  requireTools?: boolean;
  hasObservationTool?: boolean;
  requiresFileRead?: boolean;
  hasReadFile?: boolean;
  remainingToolCalls?: number;
  forceFinal?: boolean;
};

const codexFiles = ["SECURITY.md", "POLICY.md", "RULES.md", "SOUL.md", "USER.md"] as const;

export async function buildPrompt(input: PromptInput): Promise<string> {
  const blocks: Array<{ title: string; content: string }> = [];
  for (const fileName of codexFiles) {
    blocks.push({
      title: `codex/${fileName}`,
      content: await readText(join(input.workspaceRoot, "codex", fileName))
    });
  }
  for (const fileName of ["AGENT.md", "LOCAL_RULES.md"] as const) {
    blocks.push({
      title: `agents/${input.agent.id}/${fileName}`,
      content: await readText(join(input.workspaceRoot, "agents", input.agent.id, fileName))
    });
  }
  for (const fileName of ["SESSION_RULES.md", "REF_MEMORY.md", "CONTEXT_MEMORY.md"] as const) {
    blocks.push({
      title: `sessions/${input.session.id}/${fileName}`,
      content: await readText(join(input.workspaceRoot, "sessions", input.session.id, fileName))
    });
  }

  const toolText = input.toolResults?.length
    ? `\n\n# TOOL RESULTS\n\n${input.toolResults.map((result, index) => `## Result ${index + 1}\n\n${result}`).join("\n\n")}`
    : "";
  const requireToolsText = input.requireTools
    ? `\n\n# REQUIRE-TOOLS MODE\n\nThis run is in require-tools mode. Before returning a final answer, you must call at least one observation tool: read_file or search_files. write_file does not satisfy this requirement.${
        input.hasObservationTool
          ? "\n\nThe observation requirement is already satisfied. Use the tool results you have. Prefer returning final now unless the last tool result failed and one more targeted observation is essential."
          : ""
      }`
    : "";
  const fileReadRequirementText = input.requiresFileRead
    ? `\n\n# FILE-READ REQUIREMENT\n\nThe current request asks to inspect actual files. search_files is only for finding candidate paths. Before final, you must call read_file on at least one relevant file path.${
        input.hasReadFile ? "\n\nThis requirement is already satisfied." : ""
      }`
    : "";
  const loopControlText = `\n\n# TOOL LOOP CONTROL\n\nRemaining executable tool calls: ${
    input.remainingToolCalls ?? 5
  }.${
    input.forceFinal
      ? "\n\nTool call budget is exhausted. You must return a final answer now using the available tool results. Do not return a tool_call."
      : ""
  }`;

  return `${blocks.map((block) => `# BEGIN ${block.title}\n${block.content.trim()}\n# END ${block.title}`).join("\n\n")}

# RUNTIME OUTPUT CONTRACT

Return only one valid JSON object. Do not wrap it in Markdown.

When the request asks about implementation, files, CLI commands, package metadata, or current project state, inspect actual files before final. A good pattern is search_files first, then read_file on the most relevant path matches such as package.json, README.md, src/cli.ts, src/index.ts, or bin entrypoints.

For a tool call:
{"type":"tool_call","tool":"read_file","args":{"path":"README.md","content":"","query":"","directory":""},"content":"","memoryCandidates":[]}

For a search tool call:
{"type":"tool_call","tool":"search_files","args":{"path":"","content":"","query":"cosia","directory":""},"content":"","memoryCandidates":[]}

For a final answer:
{"type":"final","tool":"read_file","args":{"path":"","content":"","query":"","directory":""},"content":"...","memoryCandidates":[]}

Allowed tools for this agent: ${input.agent.allowedTools.join(", ")}
Maximum tool loop depth: 5
${requireToolsText}
${fileReadRequirementText}
${loopControlText}
${toolText}

# CURRENT USER REQUEST

${input.userPrompt}
`;
}
