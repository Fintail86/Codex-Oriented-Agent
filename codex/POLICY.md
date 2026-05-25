# POLICY

This file mirrors `codex/POLICY.json`. The JSON file is the Codex law source of truth. Runtime settings live in `config/runtime.defaults.json`, legacy `config/runtime.local.json`, and optional ignored `config/runtime.private.json`.

## Version

- Policy version: `0.53.0`

## Agents

- Default agent: `cosia-agent`

## Core Runtime Tools

- `read_file`: enabled, permission `read_only`, workspace `inside_only`
- `write_file`: enabled, permission `write_local`, workspace `inside_only`
- `search_files`: enabled, permission `read_only`, workspace `inside_only`
- `review_inbox_read`: enabled, permission `read_only`, workspace `inside_only`
- `shell_request`: enabled, permission `shell_request`, workspace `inside_only`

## Disabled Permissions

- `destructive`
- `network`
- `external_send`
- `shell`

## Writes

- Workspace-local writes: `delegated_with_evidence`
- Agent behavior writes: `delegated_with_evidence`
- Codex law writes: `codex_amendment_required`
- System boundary writes: `final_user_approval_required`
- Outside-workspace writes: `denied`
- Legacy overwrite approval switch: `false`

## Approval Boundary

- Final user approval required for: `codex_self_amendment`, `system_level_boundary_change`
- Delegated under active Policy: `workspace_local_file_write`, `agent_behavior_update`, `session_context_maintenance`, `low_risk_memory_promotion`, `tool_growth_candidate_work`, `bounded_command_adapter_execution`

## Require Tools

- Observation tools: `read_file`, `search_files`
- `write_file` satisfies observation: `false`

## File Inspection

- Requires `read_file` for explicit file-inspection requests: `true`

## Codex Boundary

- Protected source paths: `codex/SECURITY.md`, `codex/RULES.md`, `codex/SOUL.md`, `codex/USER.md`, `codex/POLICY.json`
- Protected generated mirrors: `codex/POLICY.md`
- COSIA may propose Codex amendments: `true`
- User review and approval required: `true`
- Only approved amendment apply flow may modify protected Codex paths: `true`

## Memory

- Long-term memory write policy: `candidate_promote_only`
- Candidate tiers: `core`, `agent`, `session`
- Candidate scopes: `global`, `user`, `codex`, `agent`, `project`, `session`, `task`, `tool`
- Promotion conflict policy: `block_until_resolved`
- Archive policy: `explicit_cli_only`
- Promotion paths: session->agent `manual_or_low_risk`, session->core `manual_or_low_risk`, agent->core `manual_or_low_risk`, core->skill `manual_or_low_risk`, core->codex `deferred`
- Auto promotion mode: `balanced`
- Auto promotion risk levels: `low`
- Auto promotion tiers: `session`, `agent`
- Auto promotion requires no conflict: `true`

## Self Improvement

- Skill auto promotion enabled: `true`
- Skill auto promotion risk levels: `low`
- Skill auto promotion requires triggers: `true`
- Skill auto promotion denies secret-like content: `true`
- Skill auto promotion max content chars: `6000`
- Skill auto promotion prefers for agent automatically: `false`

## Runtime Config

- Operational settings are not Codex law.
- Provider profiles, gateway connector settings, prompt budgets, bundled tool enablement, and review retention live in runtime config. User-specific values should live in ignored private config and secret files.
- Runtime config cannot relax disabled permissions, dangerous command blocks, protected Codex path rules, or Codex amendment approval requirements.
