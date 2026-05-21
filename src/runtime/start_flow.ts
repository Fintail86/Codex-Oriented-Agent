import type { AgentManifest, SessionMetadata } from "./types.js";

export type SessionRecommendation = {
  session?: SessionMetadata;
  reason: string;
};

export function recommendStartSession(sessions: SessionMetadata[], agents: AgentManifest[]): SessionRecommendation {
  const agentIds = new Set(agents.map((agent) => agent.id));
  const candidates = sessions
    .filter((session) => session.status === "active")
    .filter((session) => Boolean(session.assignedAgentId) && agentIds.has(session.assignedAgentId!))
    .sort((left, right) => {
      const updated = right.updatedAt.localeCompare(left.updatedAt);
      return updated !== 0 ? updated : left.id.localeCompare(right.id);
    });
  if (!candidates.length) {
    return { reason: "no active non-orphan session" };
  }
  return {
    session: candidates[0],
    reason: "most recently updated"
  };
}

export function formatStartOverview(input: {
  agents: AgentManifest[];
  sessions: SessionMetadata[];
  defaultAgentId: string | null;
  providerId: string;
  issues: Array<{ severity: string; title: string; action?: string }>;
  recommendation: SessionRecommendation;
}): string {
  const activeSessions = input.sessions.filter((session) => session.status === "active");
  const lines = [
    "COSIA Start",
    "",
    `Provider: ${input.providerId}`,
    `Default agent: ${input.defaultAgentId ?? "none"}`,
    `Agents: ${input.agents.length}`,
    `Active sessions: ${activeSessions.length}`,
    ""
  ];
  if (input.issues.length) {
    lines.push("Attention:");
    for (const issue of input.issues.slice(0, 5)) {
      lines.push(`- [${issue.severity}] ${issue.title}${issue.action ? ` -> ${issue.action}` : ""}`);
    }
    lines.push("");
  }
  if (input.recommendation.session) {
    lines.push(`Recommended: ${input.recommendation.session.id} (${input.recommendation.reason})`);
  } else {
    lines.push("Recommended: create a new session");
  }
  return lines.join("\n");
}

export function formatSessionChoices(sessions: SessionMetadata[], recommended?: SessionMetadata): string {
  const active = sessions.filter((session) => session.status === "active");
  const lines = ["Active sessions:"];
  if (!active.length) {
    lines.push("  none");
  } else {
    active.forEach((session, index) => {
      const marker = recommended?.id === session.id ? " *" : "";
      lines.push(`${index + 1}. ${session.id}${marker}  ${session.assignedAgentId ?? "unassigned"}  ${session.updatedAt}  ${session.goal}`);
    });
  }
  lines.push("");
  lines.push("Choose a session number, press Enter for recommended, type n for a new session, or q to quit.");
  return lines.join("\n");
}

export function sessionFromChoice(choice: string, sessions: SessionMetadata[], recommended?: SessionMetadata): SessionMetadata | "new" | "quit" | undefined {
  const trimmed = choice.trim().toLowerCase();
  if (!trimmed) {
    return recommended ?? "new";
  }
  if (trimmed === "n") {
    return "new";
  }
  if (trimmed === "q") {
    return "quit";
  }
  const index = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(index) || index < 1) {
    return undefined;
  }
  const active = sessions.filter((session) => session.status === "active");
  return active[index - 1];
}
