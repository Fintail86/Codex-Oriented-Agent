# COSIA v0.10.1

**Codex-Oriented Self-Improving Agent Runtime**.

A TypeScript CLI MVP for a Codex / Agent / Session runtime with scored SQLite memory, executable policy core, policy-gated tools, governed memory promotion, prompt budgeting, session chat, controlled Git/NPM tools, a global skill toolbox, and a Codex CLI model provider.

v0.10.1 is a structural cleanup release: the global skill toolbox behavior is unchanged, while the internal skill subsystem is split behind the existing `SkillManager` facade.

## Requirements

- Node.js 24+
- npm
- Git
- ripgrep (`rg`)
- Codex CLI logged in with `codex login`

Check the local environment:

```powershell
node --version
npm --version
git --version
rg --version
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

```powershell
cosia init
cosia agent create architect-agent --template architect
cosia session create --agent architect-agent --goal "Design the COSIA runtime MVP"
cosia memory add --scope project --content "COSIA uses Codex / Agent / Session layers." --importance 5 --confidence 0.9
cosia run --session <session-id> --prompt "현재 세션 목표와 관련 메모리를 요약해줘."
cosia chat --session <session-id>
cosia tool git-status
```

For runtime-only verification without Codex login:

```powershell
cosia run --session <session-id> --prompt "Smoke test" --provider mock
```

To force COSIA to inspect files before answering:

```powershell
cosia run --session <session-id> --prompt "현재 구현 상태를 파일을 보고 요약해줘." --require-tools
```

If a Codex provider call takes too long, lower the per-call timeout:

```powershell
cosia run --session <session-id> --prompt "현재 구현 상태를 파일을 보고 요약해줘." --require-tools --provider-timeout-ms 60000
```

## CLI Commands

```text
cosia init
cosia agent create <agent-id> --template architect
cosia session create --agent <agent-id> --goal "<goal>"
cosia session summarize <session-id> --content "<summary>"
cosia session prompt <session-id> --latest
cosia session context undo-last <session-id> --reason "<reason>"
cosia run --session <session-id> --prompt "<prompt>"
cosia run --session <session-id> --prompt "<prompt>" --skill <skill-id>
cosia chat --session <session-id>
cosia chat --session <session-id> --skill <skill-id>
cosia memory add --scope <scope> --content "<content>"
cosia memory search --query "<query>" --show-score
cosia memory list --limit <n> --all
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
cosia tool git-status
cosia tool git-diff --path <path>
cosia tool git-log --max-count <n>
cosia tool npm-test
cosia tool npm-typecheck
cosia status
cosia session list
cosia session show <session-id>
```

## Runtime Rules

- `read_file` and `search_files` are read-only workspace tools.
- `write_file` can only write inside the workspace.
- Existing file overwrite requires explicit approval.
- `codex/POLICY.json` is the runtime policy source of truth.
- `codex/POLICY.md` mirrors the JSON policy for humans.
- `cosia policy check --repair` regenerates stale `POLICY.md`; `run` and `chat` also auto-sync stale policy mirrors before prompt assembly.
- Per-session policy decisions are written to `sessions/<session-id>/POLICY_AUDIT.jsonl`.
- Per-session prompt manifests are written to `sessions/<session-id>/PROMPT_MANIFEST.jsonl`.
- Destructive, network, external-send, and shell tools are not registered in v0.10.1.
- Codex authentication is delegated to the Codex CLI. This runtime does not read or store Codex tokens.
- Provider config is policy-backed; `codex-cli` remains the default provider.
- `--require-tools` rejects final answers until `read_file` or `search_files` has run at least once.
- `write_file` does not satisfy `--require-tools`; it is not an observation tool.
- Codex provider calls have a default per-call timeout of 120000ms.
- Prompt assembly uses character budgets. Required blocks are `SECURITY.md`, `POLICY.md`, and the current request.
- `REF_MEMORY.md` is capped by scored top-N items, `CONTEXT_MEMORY.md` is included by tail, and tool results are capped with explicit truncation markers.
- Memory candidates and auto-promotions are stored in `memory/longterm.sqlite`.
- Existing JSONL queue files are imported once, then moved to `.bak` files with a migration report.
- Memory search is scored with deterministic keyword, importance, confidence, and recency signals.
- Memory candidate promotion blocks on duplicate or overlapping active memories unless a resolution mode is specified.
- Low-risk, no-conflict memory candidates can be auto-promoted by runtime policy.
- Auto-promotions can be listed, exported, and reverted.
- Secret-like candidates are high-risk and remain pending with redacted summaries.
- Long-term memory archive is explicit CLI-only soft deletion.
- CLI commands discover the nearest parent COSIA workspace. Outside a workspace, run `cosia init` first.
- Controlled Git/NPM tools are individual read-only tools, not generic shell access.
- Long tool output is capped with an explicit truncation marker.
- Session context size warnings appear in status/session/chat output; automatic context summary/archive is deferred.
- Skill candidates are stored in SQLite and remain pending until explicit promotion.
- Promoted skills live in the global toolbox: `skills/<skill-id>.md` plus `skills/<skill-id>.json`.
- `skills/SKILLS.md` is a generated global mirror; agent `SKILLS.md` files are generated preference views.
- Agents do not own skills. They use `preferredSkills`, `blockedSkills`, and `skillWeights` to bias global skill selection.
- `cosia skill check --repair` regenerates stale global `SKILLS.md`; `--agent <agent-id>` checks an agent preference view.
- PromptBuilder loads selected global skill files with XML-style boundaries and prompt budget limits.
- Skill selection is deterministic: blocked filter, trigger score, preference/weight bonuses, then stable tie-breakers.
- Triggerless skills are manual-only and must be selected with `--skill` or `/skills use`.

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

## Prompt Budget and Chat

```powershell
cosia chat --session <session-id> --provider mock
cosia session summarize <session-id> --content "Short compact summary of the session so far."
```

`chat` starts a simple REPL over the existing session runtime. Supported commands:

```text
/status
/memory refresh
/skills list
/skills use <skill-id>
/skills drop <skill-id>
/skills clear
/exit
```

Chat history is durable through `CONTEXT_MEMORY.md`; the in-process REPL history is only a display/cache aid. `REF_MEMORY.md` is generated once when chat starts, then refreshed by `/memory refresh` or after memory auto-promotion. `SESSION_SUMMARY.md` is included in prompt assembly but is manually updated in v0.6.

Manual skills selected with `--skill` or `/skills use` are included even when they have no triggers. Trigger-matched skills are selected automatically from the global skill toolbox, then biased by the current agent's preferences and capped by the prompt budget.

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
cosia session context undo-last <session-id> --reason "Mistyped chat command"
```

`undo-last` archives the last `CONTEXT_MEMORY.md` run entry into `CONTEXT_ARCHIVE.md`; it does not delete the entry without a trace.

## Memory Candidate Review

```powershell
cosia memory search --query "memory ranking" --show-score
cosia memory show <memory-id>
cosia memory update <memory-id> --importance 5 --confidence 0.9
cosia memory archive <memory-id> --reason "Superseded by newer decision"
cosia memory candidate list
cosia memory candidate review --latest
cosia memory candidate show <candidate-id>
cosia memory candidate conflicts <candidate-id>
cosia memory candidate promote <candidate-id> --replace <memory-id>
cosia memory candidate discard <candidate-id> --reason "Not durable enough"
cosia memory candidate export --jsonl
cosia memory promotion list
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
- [mem:abcd1234 score:8.42 project/decision] COSIA v0.4 improves memory ranking.
```

## Test

```powershell
npm test
```

## Controlled Tools

```powershell
cosia tool git-status
cosia tool git-diff --path src/runtime/tool_registry.ts
cosia tool git-log --max-count 20
cosia tool npm-test
cosia tool npm-typecheck
```

These commands execute through the same Tool Registry and Policy Engine used by model tool calls. `git_diff --path` is restricted to workspace paths, `git_log` is capped at 50 commits, and npm tools only run the fixed `test` or `typecheck` package scripts.

## Roadmap

- v0.11: Agent identity and selection.
- v0.12: Provider hardening and `openai-compatible` provider.
- v0.13: Context maintenance workflow.
- v1.0+: Codex amendment gate.
- Later policy maintenance: audit clear/archive commands after run-scoped audit review has settled.
- Later context maintenance: automatic session summary/archive after warning thresholds are validated.
