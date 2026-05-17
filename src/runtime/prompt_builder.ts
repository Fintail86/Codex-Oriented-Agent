import { join } from "node:path";
import { readText } from "./fs_utils.js";
import type { AgentManifest, SessionMetadata } from "./types.js";

type PromptInput = {
  workspaceRoot: string;
  agent: AgentManifest;
  session: SessionMetadata;
  userPrompt: string;
  toolResults?: string[];
};

const codexFiles = ["SECURITY.md", "RULES.md", "SOUL.md", "USER.md"] as const;

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

  return `${blocks.map((block) => `# BEGIN ${block.title}\n${block.content.trim()}\n# END ${block.title}`).join("\n\n")}

# RUNTIME OUTPUT CONTRACT

Return only one valid JSON object. Do not wrap it in Markdown.

For a tool call:
{"type":"tool_call","tool":"read_file","args":{"path":"README.md"}}

For a final answer:
{"type":"final","content":"...","memoryCandidates":[]}

Allowed tools for this agent: ${input.agent.allowedTools.join(", ")}
Maximum tool loop depth: 5
${toolText}

# CURRENT USER REQUEST

${input.userPrompt}
`;
}
