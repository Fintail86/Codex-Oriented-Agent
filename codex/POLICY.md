# POLICY

This file mirrors `codex/POLICY.json`. The JSON file is the runtime source of truth.

## Version

- Policy version: `0.16.0`

## Agents

- Default agent: `cosia-agent`

## Tools

- `read_file`: enabled, permission `read_only`, workspace `inside_only`
- `write_file`: enabled, permission `write_local`, workspace `inside_only`
- `search_files`: enabled, permission `read_only`, workspace `inside_only`
- `git_status`: enabled, permission `read_only`, workspace `inside_only`
- `git_diff`: enabled, permission `read_only`, workspace `inside_only`
- `git_log`: enabled, permission `read_only`, workspace `inside_only`
- `npm_test`: enabled, permission `read_only`, workspace `inside_only`
- `npm_typecheck`: enabled, permission `read_only`, workspace `inside_only`

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
- Candidate tiers: `core`, `agent`, `session`
- Candidate scopes: `global`, `user`, `codex`, `agent`, `project`, `session`, `task`, `tool`
- Promotion conflict policy: `block_until_resolved`
- Archive policy: `explicit_cli_only`
- Promotion paths: session->agent `manual_or_low_risk`, session->core `manual_only`, agent->core `manual_only`, core->skill `manual_only`, core->codex `deferred`
- Auto promotion mode: `conservative`
- Auto promotion risk levels: `low`
- Auto promotion tiers: `session`
- Auto promotion requires no conflict: `true`

## Prompt Budget

- Max prompt chars: `60000`
- Reference memory max items: `8`
- Context tail chars: `6000`
- Context warning chars: `30000`
- Context critical chars: `60000`
- Tool results max chars: `12000`
- Skill max items: `5`
- Skill max chars: `8000`
- Skill item max chars: `2000`
- Overflow policy: `truncate_low_priority`

## Model Providers

- Default provider: `codex-cli`
- Configured providers:
  - `codex-cli`: type `codex-cli`, enabled, timeout `120000`, retry `1`, max prompt chars `60000`, model `unset`, baseUrl `unset`, responseFormat `none`
  - `openai-compatible`: type `openai-compatible`, disabled, timeout `120000`, retry `1`, max prompt chars `60000`, model `unset`, baseUrl `unset`, responseFormat `none`
  - `openrouter`: type `openai-compatible`, enabled, timeout `120000`, retry `1`, max prompt chars `60000`, model `google/gemini-3.5-flash`, baseUrl `set`, responseFormat `json_object`
