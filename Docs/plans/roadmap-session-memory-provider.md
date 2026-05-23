# COSIA Revised Roadmap: Session Assignment -> Memory Ownership -> Provider Hardening

## Summary

After v0.11, the roadmap order changes because Agent/Session/Memory responsibilities were clarified.

New priority:

1. Finish v0.11 agent identity/default/bootstrap.
2. v0.12 separates sessions from agent ownership.
3. v0.13 moves memory to `tier + kind`.
4. v0.14 splits memory promotion policy by path.
5. Provider/context/Codex amendment work follows.

Core principles:

- Skill is a global toolbox.
- Session is a global work instance.
- Agent selects skills and handles sessions; it does not own them.
- Memory lifecycle is controlled by `core`, `agent`, and `session` tiers.
- Old scope meanings become `kind` or metadata.

## v0.12 - Session Assignment & Run Lineage

Public model direction:

```ts
type SessionMetadata = {
  id: string;
  goal: string;
  status: "active" | "archived";
  assignedAgentId: string | null;
  createdAt: string;
  updatedAt: string;
};
```

Key changes:

- Legacy `session.agentId` is read and repaired to `assignedAgentId`.
- New session ids stop depending on agent id.
- `session create --agent` sets `assignedAgentId`.
- `run/chat --agent` acts as executing-agent override for that run.
- Run/audit/prompt manifest/context records include actual executing `agentId`.

Planned CLI:

```text
cosia session assign <session-id> --agent <agent-id>
cosia session unassign <session-id>
cosia session list --agent <agent-id>
cosia agent sessions <agent-id>
```

Policies:

- Deleting an agent does not delete sessions.
- Sessions pointing to missing agents are visible as orphaned.
- Orphan sessions are repaired through `session assign`.

## v0.13 - Memory Ownership & Lifecycle

New model direction:

```ts
type MemoryTier = "core" | "agent" | "session";

type MemoryRecord = {
  tier: MemoryTier;
  ownerId?: string;
  kind: string;
  content: string;
};
```

Meanings:

- `session`: current work context; tied to session lifecycle.
- `agent`: operating memory for one agent; tied to agent lifecycle.
- `core`: COSIA-level durable memory; can feed skill/Codex candidates.

Compatibility:

- Existing `scope` is legacy.
- Migration is deterministic.
- Existing `kind` remains for search, display, and risk.
- `Core Memory != Codex law`.

## v0.14 - Memory Promotion Policy v2

Promotion paths:

```text
Session Memory -> Agent Memory
Session Memory -> Core Memory
Agent Memory -> Core Memory
Core Memory -> Skill Candidate / Codex Amendment Candidate
```

Policy:

- `session -> agent`: low-risk/no-conflict may auto-promote under conservative policy.
- `session -> core`: manual review by default.
- `agent -> core`: manual review by default.
- `core -> codex amendment`: always diff-based manual approval.
- `core -> skill candidate`: candidate creation only.

## Later Versions

### v0.15 - Provider Hardening

- Improve Codex CLI timeout/retry/JSON recovery.
- Add provider-specific prompt limits.
- Prepare or minimally implement `openai-compatible`.
- Clean up provider status/smoke output.

### v0.16 - Context Maintenance

- Strengthen summary/archive workflow.
- Connect session archive with session memory archive.
- Keep automatic summary opt-in or explicit at first.

### v1.0+ - Codex Amendment Gate

- Manage amendment candidates for Codex law files.
- Require diff-based manual approval.
- Core Memory may justify amendments but cannot directly mutate law.

## Test Plan Direction

v0.12:

- Existing sessions repair from `agentId` to `assignedAgentId`.
- Agent deletion preserves sessions and marks orphaned references.
- Same-session runs with different agents record actual executing agent.

v0.13:

- Existing memory migrates from scope to tier/kind.
- Session memory follows session lifecycle.
- Agent memory follows agent lifecycle.
- Core memory survives normal session/agent deletion.

v0.14:

- Promotion paths have distinct policy behavior.
- Conflict/high-risk memory is not auto-promoted to core.
- Existing candidate review/promote/discard/revert flows continue.

Common validation:

```text
npm run typecheck
npm test
npm run build
cosia policy check --repair
```

## Assumptions

- Session and Memory refactors are separate versions.
- Use field name `assignedAgentId`.
- Agent manifest does not store session lists.
- Delete defaults to archive-first; purge requires explicit option.
- Provider hardening and context maintenance happen after structural cleanup.
