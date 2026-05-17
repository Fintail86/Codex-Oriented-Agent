# Codex-Oriented Agent Runtime v0.1

A TypeScript CLI MVP for a Codex / Agent / Session runtime with scoped SQLite memory, policy-gated tools, and a Codex CLI model provider.

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
node dist/src/cli.js --help
```

## Quick Start

```powershell
npm run dev -- init
npm run dev -- agent create architect-agent --template architect
$session = npm run dev -- session create --agent architect-agent --goal "Design the runtime MVP"
npm run dev -- memory add --scope project --content "This runtime uses Codex / Agent / Session layers."
npm run dev -- run --session <session-id> --prompt "현재 세션 목표와 관련 메모리를 요약해줘."
```

For runtime-only verification without Codex login:

```powershell
npm run dev -- run --session <session-id> --prompt "Smoke test" --provider mock
```

## CLI Commands

```text
agent-runtime init
agent-runtime agent create <agent-id> --template architect
agent-runtime session create --agent <agent-id> --goal "<goal>"
agent-runtime run --session <session-id> --prompt "<prompt>"
agent-runtime memory add --scope <scope> --content "<content>"
agent-runtime memory search --query "<query>"
```

## Runtime Rules

- `read_file` and `search_files` are read-only workspace tools.
- `write_file` can only write inside the workspace.
- Existing file overwrite requires explicit approval.
- Destructive, network, external-send, and shell tools are not registered in v0.1.
- Codex authentication is delegated to the Codex CLI. This runtime does not read or store Codex tokens.

## Test

```powershell
npm test
```
