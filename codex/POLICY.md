# POLICY

This file mirrors `codex/POLICY.json`. The JSON file is the runtime source of truth.

## Version

- Policy version: `0.6.1`

## Tools

- `read_file`: enabled, permission `read_only`, workspace `inside_only`
- `write_file`: enabled, permission `write_local`, workspace `inside_only`
- `search_files`: enabled, permission `read_only`, workspace `inside_only`

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

## Memory

- Long-term memory write policy: `candidate_promote_only`
- Candidate scopes: `global`, `user`, `codex`, `agent`, `project`, `session`, `task`, `tool`
- Promotion conflict policy: `block_until_resolved`
- Archive policy: `explicit_cli_only`
- Auto promotion mode: `conservative`
- Auto promotion risk levels: `low`
- Auto promotion requires no conflict: `true`

## Prompt Budget

- Max prompt chars: `60000`
- Reference memory max items: `8`
- Context tail chars: `6000`
- Tool results max chars: `12000`
- Overflow policy: `truncate_low_priority`

## Model Providers

- Default provider: `codex-cli`
- Configured providers: `codex-cli`(enabled), `openai-compatible`(disabled)
