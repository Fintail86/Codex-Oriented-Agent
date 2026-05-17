# COSIA v0.5

**Codex-Oriented Self-Improving Agent Runtime**.

A TypeScript CLI MVP for a Codex / Agent / Session runtime with scored SQLite memory, executable policy core, policy-gated tools, memory conflict review, governed auto-promotion, revertable memory promotion logs, require-tools execution discipline, and a Codex CLI model provider.

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
cosia run --session <session-id> --prompt "<prompt>"
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
cosia policy show
cosia policy check
cosia policy sync
cosia policy audit --session <session-id> --limit <n>
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
- Per-session policy decisions are written to `sessions/<session-id>/POLICY_AUDIT.jsonl`.
- Destructive, network, external-send, and shell tools are not registered in v0.5.
- Codex authentication is delegated to the Codex CLI. This runtime does not read or store Codex tokens.
- `--require-tools` rejects final answers until `read_file` or `search_files` has run at least once.
- `write_file` does not satisfy `--require-tools`; it is not an observation tool.
- Codex provider calls have a default per-call timeout of 120000ms.
- Memory candidates are written to `memory/memory_candidates.jsonl` and must be explicitly promoted.
- Memory search is scored with deterministic keyword, importance, confidence, and recency signals.
- Memory candidate promotion blocks on duplicate or overlapping active memories unless a resolution mode is specified.
- Low-risk, no-conflict memory candidates can be auto-promoted by runtime policy.
- Auto-promotions are recorded in `memory/auto_promotions.jsonl` and can be reverted.
- Secret-like candidates are high-risk and remain pending with redacted summaries.
- Long-term memory archive is explicit CLI-only soft deletion.
- CLI commands discover the nearest parent COSIA workspace. Outside a workspace, run `cosia init` first.

## Policy

```powershell
cosia policy show
cosia policy check
cosia policy sync
cosia policy audit --session <session-id> --limit 20
cosia policy audit --session <session-id> --latest-run
cosia policy audit --session <session-id> --latest-run --json
```

`policy check` validates `codex/POLICY.json` and its Markdown mirror. `policy sync` regenerates `codex/POLICY.md` from the JSON source.
Policy audit logs are append-only per session. Each new `run` writes a `runId`, so `--latest-run` or `--run-id <id>` can focus the output. The default audit output is a readable summary; use `--json` for raw events. Clear/archive commands are intentionally deferred to a later maintenance pass.

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
cosia memory promotion list
cosia memory promotion revert <promotion-id> --reason "Not durable enough"
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

## Roadmap

- v0.6: Skill candidate loop with manual promotion.
- v0.7: Codex amendment gate for constitutional changes.
- Later policy maintenance: audit clear/archive commands after run-scoped audit review has settled.
