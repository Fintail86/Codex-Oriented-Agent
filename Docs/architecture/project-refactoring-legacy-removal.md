# COSIA Project-Wide Refactoring And Legacy Removal

This document is a maintenance backlog for project-wide refactoring and legacy removal.
It is not an implementation plan for a single feature version.

The goal is to make future cleanup work explicit: what should be refactored, what should be removed, what must remain private, and how each cleanup item should be verified.

## Goals

- Identify project-wide refactoring targets across runtime code, CLI, tests, docs, config, policy, and generated artifacts.
- Separate behavior-preserving refactors from legacy removals.
- Treat legacy compatibility as a removal queue with conditions, tests, and failure messages, not as permanent architecture.
- Keep private runtime state and user-specific configuration out of tracked files.

## Tags

- `refactor`: structure improvement without intended behavior change.
- `legacy-remove`: compatibility path or deprecated interface to remove after conditions are met.
- `docs-fix`: documentation or guide consistency cleanup.
- `test-split`: test organization cleanup.
- `artifact-boundary`: tracked vs private/generated artifact cleanup.

## Completed Cleanup Slices

- `18e87f5` `Centralize provider default helpers`
  - Centralized provider id -> provider type fallback in runtime config helpers.
  - Reused the shared provider default helper from provider profiles, policy normalization, and provider registry.
  - Removed duplicated provider template/type fallback code from provider profile handling.
- `a2b9bed` `Extract provider profile CLI commands`
  - Moved `cosia provider profile add/use/list/show/check/remove` command registration out of `src/cli.ts`.
  - Kept provider profile command behavior and output stable.
  - Established `src/cli_commands/` as the CLI command module extraction target.

## Remaining Refactor Queue

1. Extract gateway/Telegram CLI commands from `src/cli.ts`.
   - Keep command names, aliases, token handling, and output stable.
   - Move connector command registration into `src/cli_commands/`.
2. Extract tool growth and tool acquisition CLI commands.
   - Keep active registration approval behavior unchanged.
   - Do not change command_adapter runtime semantics.
3. Extract memory/session CLI commands.
   - Keep deprecated `--scope` behavior until the alias removal item is executed.
   - Do not remove memory legacy compatibility during command extraction.
4. Split `tests/runtime.test.ts` into feature-focused files.
   - Start with provider/config and gateway/Telegram tests because their CLI boundaries are actively changing.
5. Clean documentation drift.
   - Archive or add the v0.39 plan.
   - Update stale provider/default provider guidance.
   - Mark historical plan sections as superseded where needed.
6. Split large runtime domains.
   - Start with capability/tool acquisition only after CLI and tests are easier to review.
   - Treat memory manager split as a separate high-risk refactor.
7. Remove legacy compatibility paths one group at a time.
   - Only after repair/warning behavior and tests are in place.

## Item Format

Each cleanup item should follow this format:

```text
### <item title>

Type: refactor | legacy-remove | docs-fix | test-split | artifact-boundary
Priority: P0 | P1 | P2 | P3
Risk: low | medium | high

Current state:
- ...

Goal:
- ...

Removal/refactor steps:
- ...

Verification:
- ...

Do not:
- ...
```

## P0 Items

### Private Runtime Artifact Boundary

Type: artifact-boundary
Priority: P0
Risk: medium

Current state:
- Factory defaults and private runtime state now have separate intended paths.
- User-specific runtime files and generated state exist in the workspace during development.
- These files must remain ignored and must not become tracked defaults.

Goal:
- Keep tracked files limited to factory defaults, docs, source, tests, and policy.
- Make private config, secrets, runtime memory, sessions, gateway state, installed skills, and build outputs explicitly non-committable.

Removal/refactor steps:
- Keep `.gitignore` coverage for private and generated artifacts.
- Document the tracked default vs private runtime boundary in README and maintenance docs.
- During cleanup commits, verify that only intended source/docs/default files are staged.

Verification:
- `git status --short --ignored` shows private files as ignored.
- No tracked file contains user provider secrets, Telegram bot tokens, private chat ids, session logs, memory DBs, or gateway state.

Do not:
- Do not commit `config/runtime.private.json`.
- Do not commit `config/secrets.private.json`.
- Do not commit `config/runtime.local.json`.
- Do not commit `memory/`, `sessions/`, `agents/`, `skills/`, `.cosia-gateway/`, `.cosia-reset-backups/`, `dist/`, or `node_modules/`.

### Provider Profile Boundary And Default Provider Removal

Type: legacy-remove
Priority: P0
Risk: high

Current state:
- Provider profiles are the intended provider selection path.
- Legacy `model.defaultProvider` may still be read for warning/repair compatibility.
- Some docs and tests still mention `codex-cli` as an MVP or historical provider baseline.
- Provider template/type fallback helpers are centralized, but legacy provider fallback and stale docs remain.

Goal:
- Make explicit provider profiles the only normal provider selection path.
- Keep `codex-cli` supported only as a user-created OAuth provider profile.
- Remove hardcoded/default provider assumptions after warning and migration paths are stable.

Removal/refactor steps:
- Keep centralized provider template/type helper logic as the single source of truth.
- Keep legacy `model.defaultProvider` as warning/repair-only until removal criteria are satisfied.
- Replace outdated docs that imply a hardcoded default provider.
- Remove legacy fallback behavior only after tests prove missing active provider fails with profile setup guidance.

Verification:
- Fresh init has no active provider profile.
- Gateway and runner fail clearly when no active provider profile is configured.
- `config check` reports legacy `model.defaultProvider`.
- `config check --repair` does not silently choose a provider.
- Provider profile list/show/check never prints secret values.

Do not:
- Do not reintroduce a default provider.
- Do not use example profile names that imply a private/default profile.
- Do not let Telegram or another connector own model provider selection.

### Stale Documentation Detection

Type: docs-fix
Priority: P0
Risk: low

Current state:
- Versioned plans exist through v0.38 in `Docs/plans`.
- v0.39 provider profile and connector contract behavior may not yet be archived as a plan document.
- Older docs mention default provider assumptions, MVP `codex-cli` acceptance wording, or legacy runtime paths.

Goal:
- Align README, MVP acceptance, policy docs, and plan archive with the current provider profile model.
- Mark old plan sections as historical when they conflict with current architecture.

Removal/refactor steps:
- Add or archive the v0.39 provider profile and connector CLI plan if it is still missing.
- Search docs for hardcoded provider/default provider wording.
- Replace stale guidance with provider profile setup flow.
- Keep older plan files as snapshots, but add supersession notes where needed.

Verification:
- README setup examples use provider profiles.
- Telegram setup examples do not mention provider ownership.
- `Docs/approved-plans.md` includes all approved plan snapshots that should be retained.

Do not:
- Do not edit private config while fixing docs.
- Do not rewrite historical plans to pretend old decisions never existed; annotate supersession instead.

## P1 Items

### CLI Command Module Split

Type: refactor
Priority: P1
Risk: medium

Current state:
- `src/cli.ts` contains many unrelated command groups.
- Provider profile, gateway connector, tool growth, memory, session, and policy commands are mixed in one large entrypoint.
- Provider profile commands have been extracted to `src/cli_commands/provider_profiles.ts`.

Goal:
- Keep the CLI command surface unchanged while moving command group wiring into focused modules.
- Keep `src/cli.ts` as an assembler for top-level command groups.

Removal/refactor steps:
- Extract gateway connector commands next.
- Extract tool growth and tool acquisition commands.
- Extract memory/session commands.
- Extract policy/config commands after gateway/tool/memory command groups are stable.

Verification:
- Existing CLI tests continue to pass.
- Command help text remains stable unless a change is explicitly planned.
- Deprecated aliases still behave as documented until their removal item is executed.

Do not:
- Do not remove deprecated aliases during the split.
- Do not change command names or output shape in the structural refactor commit.

### Deprecated CLI Alias Removal Queue

Type: legacy-remove
Priority: P1
Risk: medium

Current state:
- Deprecated aliases remain for compatibility.
- Known candidates include `--model-provider`, `--scope`, `agent-runtime`, and older provider/provider-id wording.

Goal:
- Remove deprecated aliases through a staged process.

Removal/refactor steps:
- Confirm each alias emits a deprecation warning or has a documented replacement.
- Add tests for replacement commands.
- Remove one alias group at a time in separate commits.
- Replace stale docs before removal.

Verification:
- Replacement command path is tested.
- Removed alias fails with a clear migration message if appropriate.
- README no longer teaches removed aliases.

Do not:
- Do not remove aliases in the same commit as CLI modularization.
- Do not leave users with a generic unknown option error when a migration hint is available.

### Test Suite Split

Type: test-split
Priority: P1
Risk: medium

Current state:
- `tests/runtime.test.ts` is a single large test file covering most runtime behavior.

Goal:
- Split tests by feature area so refactors and legacy removals can be reviewed in smaller units.

Removal/refactor steps:
- Create focused test files for provider/config, Telegram/gateway, capability/tool growth, active tools/blueprints, memory/session, and policy/config repair.
- Extract shared fixture helpers only when duplication becomes meaningful.
- Keep assertions behavior-equivalent during the split.

Verification:
- `npm test` passes before and after each split.
- Test count remains stable unless removed tests are intentionally replaced.
- Feature-specific failures are easier to localize.

Do not:
- Do not rewrite behavior while moving tests.
- Do not create broad shared helper layers before test boundaries are clear.

## P2 Items

### Runtime Domain Module Split

Type: refactor
Priority: P2
Risk: high

Current state:
- Several runtime modules have grown into multi-responsibility files.
- Key examples include capability planning, tool acquisition, memory management, gateway runtime, and REPL coordination.

Goal:
- Split large runtime modules along domain boundaries without changing behavior.

Removal/refactor steps:
- Split capability scan, fact storage, proposal planning, and normalization.
- Split tool draft, candidate, activation, execution, and blueprint concerns.
- Split memory storage, ownership normalization, promotion, and legacy migration.
- Split gateway supervisor, gateway runtime, connector config, and connector command helpers.

Verification:
- Typecheck and tests pass after each small split.
- Public exports remain stable or are migrated through an explicit index.
- No behavior-changing legacy removal is included in module split commits.

Do not:
- Do not combine broad file moves with provider/config behavior changes.
- Do not change command_adapter execution semantics while splitting modules.
- Do not enable `ts_module` execution as part of cleanup.

### Legacy Data Compatibility Removal Queue

Type: legacy-remove
Priority: P2
Risk: high

Current state:
- Several compatibility shims preserve older data shapes.
- Known candidates include legacy scan id compatibility, session `agentId`, memory `scope`, legacy memory candidate lines, legacy Telegram process locks, and v0.29/v0.30 compatibility paths.

Goal:
- Remove old data compatibility in a controlled sequence after repair paths and tests exist.

Removal/refactor steps:
- For each legacy path, document current reader, repair path, tests, and user-facing failure mode.
- Add repair or migration command if one does not exist.
- Add tests for repaired data shape.
- Remove one compatibility path at a time.

Verification:
- Old data either repairs cleanly before removal or fails with a clear migration message after removal.
- No silent data loss occurs.
- Tests cover both pre-removal repair and post-removal rejection.

Do not:
- Do not delete compatibility code just because current test fixtures do not use it.
- Do not remove multiple legacy data paths in one commit.

## P3 Items

### Plan Archive And Historical Docs Cleanup

Type: docs-fix
Priority: P3
Risk: low

Current state:
- Historical plans are useful snapshots but may contain superseded architecture statements.

Goal:
- Keep plan history useful without confusing it with current behavior.

Removal/refactor steps:
- Add supersession notes to older plans only where current behavior would otherwise be misleading.
- Keep the approved plan index complete.
- Avoid rewriting old plans as if they were always current.

Verification:
- A reader can distinguish current setup docs from historical plan snapshots.

Do not:
- Do not delete historical plans unless a separate archive policy is approved.

### Future Enhancements Kept Out Of Cleanup

Type: refactor
Priority: P3
Risk: medium

Current state:
- Several future ideas are adjacent to cleanup but are not cleanup work.

Goal:
- Keep feature expansion separate from refactoring and legacy removal.

Removal/refactor steps:
- Track these separately from cleanup:
  - `ts_module` sandbox/security roadmap.
  - command_adapter input slots.
  - blueprint export/import.
  - active tool usage metrics.
  - unused active tool cleanup suggestions.

Verification:
- Cleanup commits do not introduce new feature behavior unless explicitly scoped.

Do not:
- Do not hide new product behavior inside a cleanup PR.

## Safety Rules

- Do not mix behavior-preserving refactors and legacy removals in one commit.
- Do not promote private runtime config into tracked defaults.
- Do not rewrite provider config, CLI, and policy repair in one large pass.
- Do not change command_adapter runtime semantics during structural cleanup.
- Do not activate `ts_module` execution during cleanup.
- Do not delete compatibility paths before their removal criteria are documented and tested.

## Suggested Execution Order

1. Extract gateway/Telegram CLI commands.
2. Extract tool growth and tool acquisition CLI commands.
3. Extract memory/session CLI commands.
4. Split tests by feature area.
5. Fix docs/archive drift and provider setup wording.
6. Split large runtime modules by domain.
7. Remove deprecated CLI aliases one group at a time.
8. Remove legacy data compatibility paths one group at a time.

## Verification Checklist For Cleanup Work

- `git status --short --ignored`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/src/bin.js config check`
- `node dist/src/bin.js policy check`

Use the full checklist for code changes. For docs-only cleanup, `git status --short --ignored` is usually enough.
