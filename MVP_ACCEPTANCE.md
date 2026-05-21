# COSIA MVP Acceptance

This checklist defines when COSIA's MVP is considered usable. Passing `mock` tests is necessary for regression safety, but it is not enough for MVP readiness. MVP acceptance requires the `codex-cli` provider through Codex OAuth.

## Provider Standard

- `mock`: regression and deterministic integration tests only.
- `codex-cli`: required MVP acceptance provider.
- `openrouter` / `openai-compatible`: optional provider acceptance.

## 1. Environment and Build

Purpose: verify the machine can build and run COSIA.

Command:

```powershell
node --version
npm --version
npm install
npm run build
```

Expected Outcome:

- Node.js is `24.x` or newer.
- Dependencies install successfully.
- Build completes without TypeScript errors.

Failure Hint:

- If Node is below 24, upgrade Node before testing SQLite-backed memory.

## 2. Policy and Codex OAuth Provider

Purpose: verify policy mirrors and required provider readiness.

Command:

```powershell
cosia policy check --repair
cosia provider check codex-cli
```

Expected Outcome:

- `POLICY.json: ok`
- `POLICY.md: ok`
- `Provider: codex-cli`
- `Status: ok`

Failure Hint:

- If provider auth fails, run `codex login` and retry `codex login status`.

## 3. Fresh Workspace Bootstrap

Purpose: verify COSIA can initialize a usable runtime workspace.

Command:

```powershell
cosia init
cosia agent list
cosia session create --goal "MVP acceptance session"
cosia session list
```

Expected Outcome:

- `cosia-agent` exists.
- A new active session is created.
- The session is assigned to the default agent.

Failure Hint:

- If no default agent exists, run `cosia agent bootstrap`.

## 3A. UX Foundation Home and Doctor

Purpose: verify COSIA can explain current workspace health and safe next actions.

Command:

```powershell
cosia status
cosia status --compact
cosia doctor
cosia doctor repair
cosia start --no-chat
```

Expected Outcome:

- `status` prints grouped workspace/provider/session/review health.
- `doctor` prints findings without changing files.
- `doctor repair` completes safely and can be run repeatedly.
- `start --no-chat` recommends or selects a usable next session command.
- `start` without `--no-chat` enters the same REPL command set as `cosia chat`, including `/help`, `/status`, `/context`, `/summary`, and `/skills`.

Failure Hint:

- If `doctor` reports critical issues, follow the printed action hints before continuing.

## 4. Runtime Smoke with Codex CLI

Purpose: verify the real model provider can produce a final answer.

Command:

```powershell
cosia run --session <session-id> --provider codex-cli --prompt "현재 세션 목표를 요약해줘."
```

Expected Outcome:

- A normal final answer is printed.
- No `Provider failed` message appears.
- `CONTEXT_MEMORY.md` receives a new run entry.

Failure Hint:

- If the provider times out, retry with `--provider-timeout-ms 60000` or a larger value.

## 5. Observation Discipline

Purpose: verify file-inspection requests require observation tools.

Command:

```powershell
cosia run --session <session-id> --provider codex-cli --require-tools --prompt "현재 구현 상태를 실제 파일을 보고 요약해줘."
cosia policy audit --session <session-id> --latest-run --limit 10
```

Expected Outcome:

- The run completes after at least one observation tool call.
- Audit output records `tool_decision` events.
- If a final answer is rejected before observation, the audit explains the policy rule.

Failure Hint:

- If Codex repeatedly avoids file reads, inspect audit output and retry with a more explicit file-inspection prompt.

## 6. Memory Workflow

Purpose: verify durable memory can be written, searched, and reviewed.

Command:

```powershell
cosia memory add --tier core --kind decision --content "COSIA MVP acceptance uses codex-cli as required provider." --importance 5 --confidence 0.9
cosia memory search --query "required provider" --show-score
cosia memory candidate list
```

Expected Outcome:

- The added core memory appears in search results.
- Search output includes score information when `--show-score` is used.
- Candidate list remains readable even when empty.

Failure Hint:

- If memory commands fail, check that Node.js is 24+ and `memory/longterm.sqlite` can be created locally.

## 7. Skill Workflow

Purpose: verify global skill selection is available and explainable.

Command:

```powershell
cosia skill list
cosia skill select --agent cosia-agent --prompt "git commit 규칙을 참고해줘" --explain
```

Expected Outcome:

- Global skills can be listed.
- Skill selection explanation prints a compact score table.
- Blocked skills are shown as blocked if applicable.

Failure Hint:

- If no skills exist, this step may still pass as a readable empty list; skill candidate promotion can be tested separately.

## 8. Context Maintenance

Purpose: verify long sessions can be summarized and compacted explicitly.

Command:

```powershell
cosia session summarize <session-id> --from-context --provider codex-cli
cosia session context status <session-id>
cosia session context compact <session-id> --keep-last 3 --reason "MVP context maintenance test"
```

Expected Outcome:

- `SESSION SUMMARY PREVIEW` is printed.
- Without `--yes`, `SESSION_SUMMARY.md` is not modified.
- Context status reports run count, archived count, and summary placeholder state.
- Compact preview reports kept and archived run counts.

Failure Hint:

- If compact is blocked, write a summary first or intentionally pass `--allow-empty-summary`.

## 9. Regression Checks

Purpose: verify implementation safety.

Command:

```powershell
npm run typecheck
npm test
npm run build
cosia policy check --repair
```

Expected Outcome:

- All commands complete successfully.
- `npm test` may use `mock`; this proves regression safety, not production readiness.

Failure Hint:

- Fix failing regression tests before treating the MVP as accepted.

## 10. Optional Provider Acceptance

Purpose: verify optional API providers when configured.

Command:

```powershell
cosia provider check openrouter
```

Expected Outcome:

- If OpenRouter is enabled and `OPENROUTER_API_KEY` is set, status is `ok`.
- If disabled or missing an API key, the failure reason and hint are clear.

Failure Hint:

- Optional provider failure does not block MVP acceptance unless the user's deployment requires that provider.
