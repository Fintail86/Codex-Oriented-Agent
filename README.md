# COSIA v0.40.0

**Codex-Oriented Self-Improving Agent Runtime**.

COSIA is a lightweight, provider-neutral agentic runtime guided by a user-amendable Codex.

`Codex-Oriented` means COSIA is oriented around the workspace-owned `codex/` law and operating constitution. It does not mean COSIA is locked to the OpenAI Codex product or any single model provider. The model is a replaceable brain; COSIA owns the local runtime, memory, policy gates, connector state, approval evidence, and capability history.

v0.40.0 aligns the public surface with that identity. It keeps the existing runtime behavior intact while making the normal setup path lighter and moving capability/tool-growth internals into advanced sections.

## Requirements

- Node.js 24+
- npm for local development/install workflows
- Git for repository development workflows
- ripgrep (`rg`)

Check the local environment:

```powershell
node --version
npm --version
git --version
rg --version
```

If you choose the `codex-cli` provider profile, check that provider separately:

```powershell
codex login
codex login status
codex exec --json "Say only: codex-ready"
```

## Install

```powershell
npm install
npm run build
```

During development, run the CLI through `tsx`:

```powershell
npm run dev -- init
```

After build, the binary entry is:

```powershell
node dist/src/bin.js --help
```

After linking, use the short project command:

```powershell
npm link
cosia --help
```

The legacy `agent-runtime` alias is also kept for compatibility.

## Quick Start

Normal setup starts with a workspace, an explicit provider profile, and a session:

```powershell
cosia init

cosia provider profile add codex --provider codex-cli --oauth
cosia provider profile use codex
cosia provider profile check codex

cosia agent create architect-agent --template architect
cosia session create --agent architect-agent --goal "Design the COSIA runtime"
cosia run --session <session-id> --prompt "현재 세션 목표와 관련 메모리를 요약해줘."
cosia chat --session <session-id>
cosia status
cosia doctor
cosia start --no-chat
```

For another replaceable brain, create and select another provider profile:

```powershell
cosia provider profile add openrouter --provider openrouter --api-key --model <openrouter-model-id>
cosia provider profile use openrouter
cosia provider profile check openrouter
```

Gateway connectors are optional external surfaces. They do not own provider selection:

```powershell
cosia gateway telegram enable
cosia gateway telegram set chat-id <chat-id>
cosia gateway telegram set token
cosia gateway telegram check
cosia gateway start
```

Use `mock` only for deterministic runtime regression checks:

```powershell
cosia run --session <session-id> --prompt "Smoke test" --provider mock
```

Advanced capability and tool-growth flows are available when you want COSIA to turn repeated work into reviewable local tooling:

```powershell
cosia capability scan --request "변경 상태 확인"
cosia capability plan --request "변경 상태 확인"
cosia shell preview --from-capability <proposal-id> --command "<exact command>"
cosia tool draft --from-capability <proposal-id> --provider mock
cosia tool grow --request "테스트 돌려봐" --provider mock
cosia tool grow test <routine-id> --yes
cosia tool grow activate <routine-id> --agent <agent-id> --yes
cosia tool active list
```

## UX Foundation

Use `status` as the normal home screen:

```powershell
cosia status
cosia status --compact
cosia status --json
```

Use `doctor` for workspace health:

```powershell
cosia doctor
cosia doctor repair
cosia doctor reset --state
cosia doctor reset --factory
```

Reset commands are preview-only unless `--yes` and the exact confirmation phrase are provided. Reset uses a two-phase backup flow under `.cosia-reset-backups/` and does not touch source code, package files, README, or git history.

Use `start` for guided session entry:

```powershell
cosia start
cosia start --no-chat
cosia start --new-session --goal "Plan the next task"
```

`agent create` still creates only an agent. `start` is responsible for session creation/selection when beginning work.
When chat is launched through `start`, it supports the same `/help`, `/context`, `/summary`, `/skills`, and `/memory refresh` commands as `cosia chat`.

To force COSIA to inspect files before answering:

```powershell
cosia run --session <session-id> --prompt "현재 구현 상태를 파일을 보고 요약해줘." --require-tools
```

If a Codex provider call takes too long, lower the per-call timeout:

```powershell
cosia run --session <session-id> --prompt "현재 구현 상태를 파일을 보고 요약해줘." --require-tools --provider-timeout-ms 60000
```

Provider setup:

- Fresh init has no active provider profile.
- `codex-cli` is supported only through an explicit provider profile and uses the user's existing Codex CLI login.
- COSIA never reads or stores Codex token files.
- `mock` is for deterministic regression tests only.
- `openai-compatible` and `openrouter` are available through provider profiles.
- API keys are entered with hidden input into `config/secrets.private.json`, or read from an explicitly configured env var.
- Use `cosia provider profile list` and `cosia provider profile check <name>` to inspect provider status.
- Common failure reasons include `disabled`, `missing_config`, `missing_api_key`, `auth_failed`, `timeout`, `rate_limited`, `network_error`, `http_error`, `malformed_response`, and `malformed_agent_step`.

Provider profile setup:

```powershell
cosia provider profile add codex --provider codex-cli --oauth
cosia provider profile use codex
cosia provider profile check codex

cosia provider profile add openrouter --provider openrouter --api-key --model <openrouter-model-id>
cosia provider profile use openrouter
cosia run --session <session-id> --prompt "간단히 응답해줘"
```

Environment-variable API key profiles are also supported:

```powershell
cosia provider profile add openrouter-env --provider openrouter --api-key-env OPENROUTER_API_KEY --model <openrouter-model-id>
```

If a selected model rejects `response_format`, set `"responseFormat": null`. COSIA keeps `Authorization` and `Content-Type` under runtime control even when provider `extraHeaders` are configured.

## CLI Commands

```text
cosia init
cosia agent create <agent-id> --template cosia
cosia agent create <agent-id> --template architect
cosia agent list
cosia agent show <agent-id>
cosia agent default show
cosia agent default set <agent-id>
cosia agent bootstrap
cosia agent bootstrap --id <agent-id> --name "<name>" --role "<role>" --voice "<voice>"
cosia agent delete <agent-id> --yes --force --allow-empty
cosia agent recommend --prompt "<prompt>" --explain
cosia agent sessions <agent-id>
cosia session create --goal "<goal>"
cosia session create --agent <agent-id> --goal "<goal>"
cosia session assign <session-id> --agent <agent-id>
cosia session unassign <session-id>
cosia session archive <session-id> --reason "<reason>"
cosia session list --agent <agent-id>
cosia session summarize <session-id> --content "<summary>"
cosia session summarize <session-id> --from-context --provider <provider-profile>
cosia session prompt <session-id> --latest
cosia session context status <session-id>
cosia session context compact <session-id> --keep-last <n> --reason "<reason>" --yes
cosia session context undo-last <session-id> --reason "<reason>"
cosia run --session <session-id> --prompt "<prompt>" --agent <agent-id>
cosia run --session <session-id> --prompt "<prompt>" --skill <skill-id>
cosia chat --session <session-id> --agent <agent-id>
cosia chat --session <session-id> --skill <skill-id>
cosia provider profile add codex --provider codex-cli --oauth
cosia provider profile add openrouter --provider openrouter --api-key --model <model-id>
cosia provider profile use <name>
cosia provider profile list
cosia provider profile check [name]
cosia config show
cosia config check
cosia config migrate --from-policy
cosia mvp checklist
cosia memory add --tier <tier> --owner-id <owner-id> --content "<content>"
cosia memory add --scope <scope> --content "<content>"
cosia memory search --query "<query>" --tier <tier> --owner-id <owner-id> --show-score
cosia memory list --tier <tier> --owner-id <owner-id> --limit <n> --all
cosia memory show <memory-id>
cosia memory update <memory-id> --content "<content>"
cosia memory archive <memory-id> --reason "<reason>"
cosia memory candidate list
cosia memory candidate review --latest
cosia memory candidate review --pending
cosia memory candidate show <candidate-id>
cosia memory candidate conflicts <candidate-id>
cosia memory candidate promote <candidate-id> --force
cosia memory candidate promote <candidate-id> --replace <memory-id>
cosia memory candidate promote <candidate-id> --merge <memory-id> --content "<merged content>"
cosia memory candidate promote --all-low-risk --yes
cosia memory candidate discard <candidate-id> --reason "<reason>"
cosia memory candidate discard --all-low-risk --reason "<reason>" --yes
cosia memory promotion list
cosia memory promotion show <promotion-id>
cosia memory promotion revert <promotion-id> --reason "<reason>"
cosia skill candidate list
cosia skill candidate show <candidate-id>
cosia skill candidate promote <candidate-id>
cosia skill candidate promote <candidate-id> --yes
cosia skill candidate promote <candidate-id> --yes --prefer-for <agent-id>
cosia skill candidate discard <candidate-id> --reason "<reason>"
cosia skill candidate export --jsonl
cosia skill list
cosia skill list --agent <agent-id>
cosia skill show <skill-id>
cosia skill prefer <skill-id> --agent <agent-id> --weight <0-5>
cosia skill unprefer <skill-id> --agent <agent-id>
cosia skill block <skill-id> --agent <agent-id>
cosia skill unblock <skill-id> --agent <agent-id>
cosia skill select --agent <agent-id> --prompt "<prompt>" --explain
cosia skill check
cosia skill check --agent <agent-id> --repair
cosia skill sync
cosia skill migrate --agent <agent-id>
cosia policy show
cosia policy check
cosia policy check --repair
cosia policy sync
cosia policy audit --session <session-id> --limit <n>
cosia tool list
cosia tool run <tool-id> --args "{...}"
cosia capability scan --request "<request>"
cosia capability plan --request "<request>"
cosia capability review
cosia shell preview --command "<command>" --reason "<reason>"
cosia shell apply <approval-id>
cosia status
cosia session list
cosia session show <session-id>
```

## Runtime Rules

- `read_file` and `search_files` are read-only workspace tools.
- `write_file` can only write inside the workspace.
- Existing file overwrite requires explicit approval.
- `codex/POLICY.json` is the Codex law source of truth.
- `codex/POLICY.md` mirrors the JSON law for humans.
- Runtime settings live in `config/runtime.defaults.json`, legacy `config/runtime.local.json`, and ignored `config/runtime.private.json`.
- Secret values live in ignored `config/secrets.private.json` or explicitly configured env vars.
- `config show`, `config check`, and `config migrate --from-policy` manage runtime configuration.
- `cosia policy check --repair` regenerates stale `POLICY.md`; `run` and `chat` also auto-sync stale policy mirrors before prompt assembly.
- Per-session policy decisions are written to `sessions/<session-id>/POLICY_AUDIT.jsonl`.
- Per-session prompt manifests are written to `sessions/<session-id>/PROMPT_MANIFEST.jsonl`.
- Destructive, network, external-send, and unrestricted shell permissions are disabled by policy. `shell_request` only creates a one-shot approval preview.
- For `codex-cli` OAuth profiles, authentication is delegated to the Codex CLI. This runtime does not read or store Codex tokens.
- Provider config is profile-backed; no provider is active until `cosia provider profile use <name>`.
- `mock` provider success proves regression safety only; validate at least one real provider profile when checking provider behavior.
- Provider failures are reported with reason codes and short next-action hints.
- Invalid AgentStep JSON triggers a bounded structured retry that includes the parse error and a short malformed-output preview.
- `--require-tools` rejects final answers until `read_file` or `search_files` has run at least once.
- `write_file` does not satisfy `--require-tools`; it is not an observation tool.
- Codex provider calls have a default per-call timeout of 120000ms.
- Prompt assembly uses character budgets. Required blocks are `SECURITY.md`, `POLICY.md`, and the current request.
- `REF_MEMORY.md` is capped by scored top-N items, `CONTEXT_MEMORY.md` is included by tail, and tool results are capped with explicit truncation markers.
- Memory candidates and auto-promotions are stored in `memory/longterm.sqlite`.
- Existing JSONL queue files are imported once, then moved to `.bak` files with a migration report.
- Memory search is scored with deterministic keyword, importance, confidence, and recency signals.
- Memory ownership is tiered: `core` memory survives agent/session lifecycle, `agent` memory follows an agent, and `session` memory follows a session.
- Deprecated memory `scope` values are still accepted as aliases. New commands should use `--tier`.
- `REF_MEMORY.md` is built from core memory plus the current session's session memory and the executing agent's agent memory.
- Memory candidate promotion blocks on duplicate or overlapping active memories unless a resolution mode is specified.
- Memory tier promotion supports `session -> agent`, `session -> core`, and `agent -> core`; source memories are archived after successful promotion.
- Core memory can create pending skill candidates, but Codex amendment remains deferred to a later diff-based gate.
- Low-risk, no-conflict memory candidates can be auto-promoted by runtime policy.
- Auto-promotions and tier promotions can be listed and reverted.
- Secret-like candidates are high-risk and remain pending with redacted summaries.
- Long-term memory archive is explicit CLI-only soft deletion.
- `session archive` soft-archives session-tier memory. Deleting an agent soft-archives that agent's agent-tier memory.
- CLI commands discover the nearest parent COSIA workspace. Outside a workspace, run `cosia init` first.
- Concrete project tools are not assumed from filenames or workspace shape. They become available only through configured or activated runtime paths and remain gated by Tool Registry, agent allowlists, and Policy Engine boundaries.
- Long tool output is capped with an explicit truncation marker.
- Session context size warnings appear in status/session/chat output; context summary and compaction are explicit CLI/REPL actions.
- Skill candidates are stored in SQLite and remain pending until explicit promotion.
- Promoted skills live in the global toolbox: `skills/<skill-id>.md` plus `skills/<skill-id>.json`.
- `skills/SKILLS.md` is a generated global mirror; agent `SKILLS.md` files are generated preference views.
- Agents do not own skills. They use `preferredSkills`, `blockedSkills`, and `skillWeights` to bias global skill selection.
- `cosia skill check --repair` regenerates stale global `SKILLS.md`; `--agent <agent-id>` checks an agent preference view.
- PromptBuilder loads selected global skill files with XML-style boundaries and prompt budget limits.
- Skill selection is deterministic: blocked filter, trigger score, preference/weight bonuses, then stable tie-breakers.
- Triggerless skills are manual-only and must be selected with `--skill` or `/skills use`.
- Agents are replaceable identity/work-style units. `cosia-agent` is only the initial default.
- `POLICY.json` stores `agents.defaultAgentId`; `cosia agent default set <agent-id>` changes it.
- Agent identity comes from `manifest.json`; `AGENT.md`, `STYLE.md`, and `LOCAL_RULES.md` remain prompt/human supplements.
- Agent recommendation is deterministic and does not change existing sessions automatically.
- If no usable default agent exists, run `cosia agent bootstrap`.
- Sessions are global work instances and store `assignedAgentId`; agents do not own sessions.
- `run --agent` and `chat --agent` override the executing agent for that run/chat without changing the session assignment.
- Policy audit, prompt manifests, context entries, and generated candidates record the actual executing agent.
- Sessions assigned to missing agents are treated as orphaned and can be repaired with `cosia session assign`.

## Policy

```powershell
cosia policy show
cosia policy check
cosia policy check --repair
cosia policy sync
cosia policy audit --session <session-id> --limit 20
cosia policy audit --session <session-id> --latest-run
cosia policy audit --session <session-id> --latest-run --json
```

`policy check` validates `codex/POLICY.json` and its Markdown mirror. `policy sync` regenerates `codex/POLICY.md` from the JSON source. Use `policy check --repair` to regenerate a stale or missing Markdown mirror without changing the JSON source.
Policy audit logs are append-only per session. Each new `run` writes a `runId`, so `--latest-run` or `--run-id <id>` can focus the output. The default audit output is a readable summary; use `--json` for raw events. Clear/archive commands are intentionally deferred to a later maintenance pass.

## Historical Manual Acceptance

```powershell
cosia mvp checklist
```

The `mvp` checklist is kept as a historical/manual regression aid while the public product surface moves toward provider-neutral setup. Detailed manual acceptance steps live in [MVP_ACCEPTANCE.md](MVP_ACCEPTANCE.md). The short version is:

- `mock` is allowed for unit/integration regression only.
- Real provider behavior should be validated through an explicit provider profile.
- `codex-cli`, OpenRouter, and OpenAI-compatible providers are selectable profile paths.
- Every acceptance step has a command, expected outcome, and failure hint.

## Agent Lifecycle

```powershell
cosia agent list
cosia agent show cosia-agent
cosia agent recommend --prompt "세션 상태를 정리해줘" --explain
cosia agent default show
cosia agent bootstrap --id helper-agent --name "Helper Agent" --role "General COSIA helper" --voice "Friendly and brief"
cosia agent default set helper-agent
cosia agent delete cosia-agent
cosia agent sessions architect-agent
```

`agent delete` previews by default. Use `--yes` to delete, `--force` for session-referenced agents, and `--allow-empty` only when deliberately leaving the workspace without a default or last agent. Deleting an agent does not delete sessions; affected sessions become orphaned until reassigned. Active agent-tier memories for the deleted agent are soft-archived.

## Prompt Budget and Chat

```powershell
cosia chat --session <session-id> --provider mock
cosia session summarize <session-id> --content "Short compact summary of the session so far."
cosia session summarize <session-id> --from-context --provider openrouter
cosia session context status <session-id>
cosia session context compact <session-id> --keep-last 5 --reason "Summary captured older turns" --yes
```

`chat` starts the shared COSIA REPL over the existing session runtime. `cosia start` enters this same REPL after selecting or creating a session. Use `--agent <agent-id>` to run the chat with a different executing agent without changing the session assignment. Type `/help` inside the REPL to see supported commands:

```text
/help
/status
/context status
/context compact --keep-last <n> --reason "<reason>"
/context compact --keep-last <n> --reason "<reason>" --yes
/summary show
/summary update <summary>
/memory refresh
/skills list
/skills use <skill-id>
/skills drop <skill-id>
/skills clear
#상태 보여줘
#리뷰 보여줘
#리뷰 3번 디스카드해 이유는 중복
#컨플릭트 메모리 전부 디스카드해 이유는 중복
#적용
#취소
\#해시로 시작하는 일반 대화
/exit
```

`/` commands are exact REPL commands. `#` commands are deterministic natural runtime commands: read-only commands execute immediately, while mutating commands create a five-minute `[PREVIEW]` pending action that must be applied with `#적용` or cancelled with `#취소`. Ordinary text without `#` is sent to the configured model provider. Prefix `\#` when a model prompt should literally start with `#`.

Chat history is durable through `CONTEXT_MEMORY.md`; the in-process REPL history is only a display/cache aid. `REF_MEMORY.md` is generated once when chat starts, then refreshed by `/memory refresh` or after memory auto-promotion. `SESSION_SUMMARY.md` is included in prompt assembly and can be updated manually or by explicit `--from-context` summary preview/apply.

`context compact` is preview-first. It splits `CONTEXT_MEMORY.md` only on `## Run ...` headings, keeps the newest run blocks, and moves older whole run blocks into `CONTEXT_ARCHIVE.md`. Use `--yes` to apply. By default, compaction is blocked while `SESSION_SUMMARY.md` is still the placeholder; pass `--allow-empty-summary` only when intentionally archiving without a summary.

Manual skills selected with `--skill` or `/skills use` are included even when they have no triggers. Trigger-matched skills are selected automatically from the global skill toolbox, then biased by the current agent's preferences and capped by the prompt budget.

## Review Inbox

Pending memory and skill candidates can be reviewed from the shared chat REPL:

```text
/review
/review memory
/review skill
/review show <id-prefix>
/review conflicts <id-prefix>
/review promote <id-prefix> --replace 1
/review promote <id-prefix> --yes
/review discard <id-prefix> --reason "Not useful"
/review discard-conflicts --reason "Duplicate mock candidates" --yes
/review next
/review stats
/review cleanup
```

The inbox shows temporary numeric indexes and stable id prefixes. Prefer id prefixes in commands because indexes can shift after a promote or discard. For memory conflicts, `/review conflicts <id-prefix>` numbers the target memories so a follow-up can use `--replace 1` or `--merge 1 --content "<merged content>"` instead of typing a full target memory id.

`cosia review`, `cosia review --memory`, and `cosia review --skill` print the same pending queue as read-only CLI summaries. `cosia review stats` reports pending, discarded, and cleanup-eligible items. `cosia review cleanup` is preview-first and only removes discarded candidates after the configured retention window when re-run with `--yes`; pending candidates are never auto-deleted.

The chat REPL also accepts hash natural commands for the common review flow:

```text
#리뷰 보여줘
#컨플릭트 메모리 전부 디스카드해 이유는 중복
#적용
```

Hash mutation previews expire after five minutes, so re-run the hash command if `[EXPIRED]` appears.

## Self-Improvement Governor

The Governor evaluates memory, skill, and tool improvement candidates without widening Codex authority. After a normal run it only processes candidates created by that run. Backlog work is handled explicitly:

```powershell
cosia improve status
cosia improve preview
cosia improve apply --yes
cosia improve review
cosia improve show <id>
cosia improve revert <id> --reason "Rollback test"
cosia improve discard <id> --reason "Not useful"
```

`preview` prints an `evaluationHash`, but it is not an apply token. `apply --yes` always re-evaluates the current backlog before changing anything. Memory auto-promotion is limited to low-risk, no-conflict session candidates. Skill auto-promotion is stricter: low risk, no secret-like content, safe id, valid metadata, trigger present, and content within budget. Tool improvement creates recommendation evidence only.

Every automatic apply, block, failure, and recommendation is recorded in `memory/longterm.sqlite`. Skill rollback across files and SQLite is best-effort compensation; failures are recorded as evidence instead of being hidden.

## Gateway / Telegram Remote Console

Telegram is an optional Gateway connector. It does not add new model, tool, or policy permissions; it routes allowed Telegram chat messages into the existing COSIA runtime.

Setup:

```powershell
cosia init
cosia provider profile add codex --provider codex-cli --oauth
cosia provider profile use codex

cosia gateway telegram enable
cosia gateway telegram set chat-id <chat-id>
cosia gateway telegram set token
cosia policy check --repair
cosia gateway telegram check
cosia gateway start
```

Normal operation uses the top-level Gateway supervisor:

```powershell
cosia gateway start
cosia gateway status
cosia gateway stop
cosia gateway restart
```

`cosia gateway telegram ...` commands remain available for connector-specific checks and debugging, but users should usually start and stop the Gateway through the top-level commands.

Connector settings are managed through the CLI:

```powershell
cosia gateway telegram enable
cosia gateway telegram set chat-id <chat-id>
cosia gateway telegram set token
cosia gateway telegram list
cosia gateway telegram check
```

Useful Telegram commands:

```text
/status
/sessions
/use <session-id>
/new <goal>
/review
/apply
#상태 보여줘
#리뷰 보여줘
```

Telegram review messages may include compact shortcut buttons such as refresh, show, conflicts, and preview actions. Buttons only create or refresh previews; actual mutation still requires `/apply` or `#적용`, and stale previews are rejected if the target or conflict state changed.

The gateway stores local process, offset, heartbeat, lock, and chat state under `.cosia-gateway/`, which is ignored by git. Telegram mutations still use preview plus `/apply` or `#적용`; dangerous commands are blocked in the connector by default. Use `cosia gateway status --json` for structured gateway state and `cosia gateway unlock --stale-only` to remove stale top-level process locks.

## Command Trigger Packs

Hash natural commands are backed by the command catalog and Korean trigger metadata. The canonical command metadata stays in source, while local override files can live under `config/`.

```powershell
cosia command triggers check
cosia command triggers sync --locale ko
```

Trigger checks warn about short automatic triggers and duplicate triggers. User override trigger packs are intended to take precedence over built-in locale metadata as this surface grows.

## Skill Candidate Review

```powershell
cosia run --session <session-id> --provider mock --prompt "[MOCK_SKILL_CANDIDATE]"
cosia skill candidate list
cosia skill candidate show <candidate-id>
cosia skill candidate promote <candidate-id>
cosia skill candidate promote <candidate-id> --yes
cosia skill candidate promote <candidate-id> --yes --prefer-for architect-agent
cosia skill check
cosia skill check --agent architect-agent --repair
cosia skill select --agent architect-agent --prompt "git diff를 요약해줘." --explain
cosia skill list --agent architect-agent
cosia run --session <session-id> --prompt "git diff를 요약해줘."
cosia run --session <session-id> --prompt "수동 스킬 적용 테스트" --skill <skill-id>
```

Skill promotion preview does not mutate files. `--yes` writes `skills/<skill-id>.md`, `skills/<skill-id>.json`, and regenerates `skills/SKILLS.md`. Use `--prefer-for <agent-id>` when the promoted skill should become preferred by one agent. High-risk skill candidates require the explicit confirmation phrase shown in the preview.

## Repo Hygiene

Live runtime state is local-only and ignored by git:

```text
memory/*
sessions/*
```

Already-tracked runtime state must be removed from the git index once without deleting local files:

```powershell
git ls-files sessions memory
git rm --cached -- <tracked-runtime-files>
git commit -m "chore: stop tracking runtime state"
```

Source, policy, agent definitions, global skill files, tests, and docs remain project files. Runtime files such as `CONTEXT_MEMORY.md`, `REF_MEMORY.md`, `POLICY_AUDIT.jsonl`, `PROMPT_MANIFEST.jsonl`, SQLite databases, migration reports, and `.bak` queue files should not be committed.

Prompt manifests record block sizes and truncation metadata without storing full prompt text:

```text
sessions/<session-id>/PROMPT_MANIFEST.jsonl
```

Readable prompt budget summaries and safe context undo are available through:

```powershell
cosia session prompt <session-id> --latest
cosia session prompt <session-id> --limit 2
cosia session context status <session-id>
cosia session summarize <session-id> --from-context --provider openrouter --yes
cosia session context compact <session-id> --keep-last 5 --reason "Summary captured older turns" --yes
cosia session context undo-last <session-id> --reason "Mistyped chat command"
```

`undo-last` archives only the latest `CONTEXT_MEMORY.md` run entry into `CONTEXT_ARCHIVE.md`; it does not delete the entry without a trace. `compact` archives older whole run blocks in batches after a summary has captured their useful context.

## Memory Candidate Review

```powershell
cosia memory search --query "memory ranking" --show-score
cosia memory add --tier session --owner-id <session-id> --content "Session-local context"
cosia memory add --tier agent --owner-id <agent-id> --content "Agent operating preference"
cosia memory add --tier core --content "System-wide durable fact"
cosia memory show <memory-id>
cosia memory update <memory-id> --tier core --importance 5 --confidence 0.9
cosia memory archive <memory-id> --reason "Superseded by newer decision"
cosia memory promote <memory-id> --to-tier agent --owner-id <agent-id> --reason "Agent should inherit this"
cosia memory promote <memory-id> --to-tier core --reason "Project-wide durable fact"
cosia memory promote <core-memory-id> --to-skill-candidate --skill-name "Memory Review" --reason "Turn core rule into skill"
cosia memory candidate list
cosia memory candidate review --latest
cosia memory candidate show <candidate-id>
cosia memory candidate conflicts <candidate-id>
cosia memory candidate promote <candidate-id> --replace <memory-id>
cosia memory candidate discard <candidate-id> --reason "Not durable enough"
cosia memory candidate export --jsonl
cosia memory promotion list
cosia memory promotion list --type tier
cosia memory promotion revert <promotion-id> --reason "Not durable enough"
cosia memory promotion export --jsonl
```

Candidate ids accept unique prefixes:

```powershell
cosia memory candidate show d1ec6de4
cosia memory candidate conflicts d1ec6de4
cosia memory candidate promote d1ec6de4 --force
```

Reference memory is written with source hints so model answers can cite durable context:

```md
- [mem:abcd1234 score:8.42 core/decision] COSIA v0.14 promotes memory across lifecycle tiers.
```

## Test

```powershell
npm test
```

## Controlled Tools And Shell Bridge

```powershell
cosia tool list
cosia capability scan --request "테스트 돌려봐"
cosia capability plan --request "테스트 돌려봐"
cosia capability facts --latest
cosia capability review
cosia shell preview --from-capability <proposal-id> --command "<exact command>"
cosia shell run --from-capability <proposal-id> --command "<exact command>" --yes
cosia shell preview --command "echo ready" --reason "one-shot local shell check"
cosia shell apply <approval-id>
cosia tool draft --from-capability <proposal-id> --provider mock
cosia tool candidate review
cosia tool candidate show <candidate-id>
cosia tool candidate test <candidate-id>
cosia tool candidate approve <candidate-id>
cosia tool activate <candidate-id> --agent <agent-id> --yes
cosia tool active list
cosia tool deactivate <tool-id> --reason "<reason>"
```

`cosia tool list` shows active catalog tools. The initial model-facing surface is intentionally small: `read_file`, `write_file`, `search_files`, and `shell_request`.

Git, NPM, Python, Bun, and similar concrete tools are not default active tools or default blueprints. Workspace entries and structured files are generic facts first. Capability planning turns user requests plus facts into proposals before any shell command is suggested.

`cosia capability scan` creates a scan snapshot with stable fact-kind summaries such as `Hidden entries`, `Manifest-like files`, `Script-like keys`, and `Warnings`. It does not run shell probes, does not infer concrete runners, and does not emit wording like “Found Git repository” or “Found NPM project”.

`cosia capability plan --request "<request>"` reads the latest valid scan and creates a deterministic abstract proposal. It does not create shell approvals, commands, tool candidates, or active tool registrations. Requests such as “git status 봐줘”, “npm test 해줘”, or “python 테스트 돌려봐” are normalized into capability families such as `change_tracking` or `project_check`, not concrete runner assumptions.

`cosia shell preview --from-capability <proposal-id> --command "<exact command>"` converts an eligible `shell_preview` proposal into a linked one-shot shell approval. It never extracts a command from the proposal and never creates a new approval if the proposal already has a linked approval. `cosia shell run --from-capability ... --yes` only runs when it creates a new approval; existing linked approvals must be executed through `cosia shell apply <approval-id>`.

`shell_request` does not execute commands. It creates a one-shot shell approval preview for local CLI/REPL review. An approval stores the exact command and cwd hash, expires, and can be executed only once. Gateway/Telegram shell execution is blocked by default.

`cosia tool draft --from-capability <proposal-id>` asks the configured model for an untrusted ToolDraft package. The runtime stores the draft first, then normalizes it into a ToolCandidate only if all required allowlist gates pass. Candidate text and evidence may reference capabilities and shell approvals, but draft generation cannot create shell approvals, active tools, policy changes, config edits, or agent `allowedTools` changes.

`cosia tool grow --request "<request>"` orchestrates the zero-base capability flow without adding new authority. It runs a fresh capability scan, creates a capability proposal, asks for an untrusted ToolDraft, normalizes a ToolCandidate, and records a Tool Growth Routine. It does not create shell approvals, run commands, or register active tools. Testing still requires `cosia tool grow test <routine-id> --yes`, and activation still requires `cosia tool grow activate <routine-id> --agent <agent-id> --yes`.

Inside chat, `/tool grow <request>` and `#도구 성장 <request>` start the same routine. Short follow-up commands such as `#이 도구 테스트해`, `#이 도구 활성화해`, `#이건 내가 원한 기능이 아니야 이유는 ...`, `#다른 도구 후보 만들어줘`, and `#도구 생성 취소` operate only on the current unambiguous routine.

`command_adapter` candidates are fixed executable + fixed args plans with `cwdPolicy=workspace_root`, output caps, timeouts, audit, and redaction forced on. They do not accept model-provided argument interpolation. A candidate can be approved before testing, but activation requires the latest passed candidate test hash to match the current candidate content hash.

Active tools are workspace-local records, not static catalog entries. A model sees an active tool only when the active record is `active`, exposure is `model`, the target agent allows the tool id, and policy permits the tool permission. Deactivation removes the active tool from the target agent allowlist and from effective prompt/provider visibility.

Learned local blueprints are evidence artifacts, not built-in knowledge packs. `cosia tool blueprint create-from-active <tool-id> --yes` can capture a repeatedly successful fixed `command_adapter` plan as future drafting context, but it never activates a tool automatically.

Approved Shell Bridge is temporary. The long-term direction is documented in `Docs/architecture/governed-terminal-long-term.md`: a Governed Terminal substrate with command classification, probes, candidate tests, and tool acquisition.

## Roadmap

- v0.40.0: Identity surface refactor for the user-amendable Codex runtime direction.
- v0.38.0: Tool Growth Routine orchestration from request to candidate, explicit test, and explicit activation.
- v0.37.0: Learned local blueprint records from successful active command_adapter tools.
- v0.36.0: Governor tool candidate recommendation evidence from repeated shell approval patterns.
- v0.35.0: command_adapter runtime hardening with fixed args, env allowlist, and execution evidence.
- v0.34.0: Active tool activation hardening, preview, deactivation, and effective visibility checks.
- v0.33.0: LLM ToolDraft, ToolCandidate, and command_adapter active tool MVP.
- v0.32.0: Capability-linked shell approval previews.
- v0.31.0: Deterministic capability proposal planner.
- v0.30.0: Generic workspace fact scan snapshots.
- v0.29.0: Zero-base capability planner and approved shell bridge.
- Next decision checkpoint: keep polishing `status/start/chat/Telegram/improve` if they are enough, or plan `cosia tui` if review comparison and repeated operations remain painful.
- v1.0+: Codex amendment gate.
- Later policy maintenance: audit clear/archive commands after run-scoped audit review has settled.
- Later context maintenance: optional automatic summary/archive after explicit workflows are validated.
