# POLICY

This file mirrors `codex/POLICY.json`. The JSON file is the Codex law source of truth. Runtime settings live in `config/runtime.defaults.json` and optional `config/runtime.local.json`.

## Version

- Policy version: `0.38.0`

## Agents

- Default agent: `cosia-agent`

## Core Runtime Tools

- `read_file`: enabled, permission `read_only`, workspace `inside_only`
- `write_file`: enabled, permission `write_local`, workspace `inside_only`
- `search_files`: enabled, permission `read_only`, workspace `inside_only`
- `shell_request`: enabled, permission `shell_request`, workspace `inside_only`

## Disabled Permissions

- `destructive`
- `network`
- `external_send`
- `shell`

## Writes

- Existing file overwrite requires approval: `true`

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
- Promotion paths: session->agent `manual_or_low_risk`, session->core `manual_only`, agent->core `manual_only`, core->skill `manual_only`, core->codex `deferred`
- Auto promotion mode: `conservative`
- Auto promotion risk levels: `low`
- Auto promotion tiers: `session`
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
- Provider details, gateway connector settings, prompt budgets, bundled tool enablement, and review retention live in `config/runtime.defaults.json` and optional ignored `config/runtime.local.json`.
- Runtime config cannot relax disabled permissions, dangerous command blocks, protected Codex path rules, or Codex amendment approval requirements.
