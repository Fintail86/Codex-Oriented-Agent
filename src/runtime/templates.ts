import type { AgentManifest } from "./types.js";

export const codexTemplates: Record<string, string> = {
  "SOUL.md": `# SOUL

This runtime treats Codex as the constitutional layer, agents as role-bearing actors, and sessions as work instances.
`,
  "USER.md": `# USER

User preferences and long-term interaction notes belong here.
`,
  "RULES.md": `# RULES

- Security constraints outrank all runtime behavior.
- Agents inherit Codex rules and cannot override them.
- Tools must run through the Tool Registry and Policy Engine.
`,
  "SECURITY.md": `# SECURITY

- Do not expose secrets, API keys, tokens, or private credentials.
- Do not write outside the workspace.
- Destructive, shell, network, and external-send tools are disabled in v0.1.
- Existing file overwrite requires explicit user approval.
`
};

export function architectManifest(agentId: string): AgentManifest {
  return {
    id: agentId,
    name: "Architect Agent",
    description: "Designs systems, implementation plans, and runtime decisions.",
    allowedTools: ["read_file", "write_file", "search_files"],
    skills: [],
    memoryScopes: ["agent", "project", "user", "tool"]
  };
}

export const agentTemplates: Record<string, string> = {
  "AGENT.md": `# Architect Agent

You are responsible for turning ambiguous system goals into implementable plans and careful execution steps.
`,
  "LOCAL_RULES.md": `# LOCAL RULES

- Prefer small, reversible changes.
- Name unresolved assumptions explicitly.
- Keep policy and tool execution separated.
`,
  "STYLE.md": `# STYLE

Direct, practical, and precise.
`,
  "SKILLS.md": `# SKILLS

No skills are bundled in v0.1.
`
};
