# COSIA v0.1

**Codex-Oriented Self-Improving Agent Runtime**.

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
cosia memory add --scope project --content "COSIA uses Codex / Agent / Session layers."
cosia run --session <session-id> --prompt "현재 세션 목표와 관련 메모리를 요약해줘."
```

For runtime-only verification without Codex login:

```powershell
cosia run --session <session-id> --prompt "Smoke test" --provider mock
```

## CLI Commands

```text
cosia init
cosia agent create <agent-id> --template architect
cosia session create --agent <agent-id> --goal "<goal>"
cosia run --session <session-id> --prompt "<prompt>"
cosia memory add --scope <scope> --content "<content>"
cosia memory search --query "<query>"
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
