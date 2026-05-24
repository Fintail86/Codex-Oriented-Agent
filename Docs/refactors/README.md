# COSIA Refactor Phase Plans

This directory contains implementation-ready refactor phase plans for the post-v0.39 COSIA direction.

These plans are not feature requests by themselves. They translate the product identity in `Docs/architecture/cosia-identity-and-direction.md` and the implementation direction in `Docs/architecture/cosia-refactor-direction-notes.md` into staged refactoring work.

## Guiding Principle

COSIA should be refactored into a lightweight, provider-neutral agentic runtime guided by a user-amendable Codex.

The next refactor sequence prioritizes:

- identity and surface alignment before new features
- normal UX over internal state exposure
- provider profiles as replaceable brain setup
- Codex law as user-owned governance
- workspace-owned memory and debug observability
- connector safety, especially for Telegram and group chat
- tool growth behind guided and explicit approval gates

## Phase Index

| Phase | Document | Focus |
| --- | --- | --- |
| v0.40 | [Identity Surface Refactor](v0.40-identity-surface-refactor.md) | README, CLI wording, docs, and normal/advanced/debug surface language. |
| v0.41 | [CLI Surface And Module Split](v0.41-cli-surface-and-module-split.md) | Split CLI command wiring without changing command behavior. |
| v0.42 | [Provider Onboarding And OAuth](v0.42-provider-onboarding-and-oauth.md) | Guided provider setup, provider onboarding registry, and COSIA-owned OAuth boundary. |
| v0.43 | [Codex Law Amendment Flow](v0.43-codex-law-amendment-flow.md) | Treat `codex/*.md` changes as governed amendments, not ordinary file writes. |
| v0.44 | [Memory Session Debug UX](v0.44-memory-session-debug-ux.md) | Clarify session context, summaries, long-term memory, and debug records. |
| v0.45 | [Connector Gateway Safety](v0.45-connector-gateway-safety.md) | Telegram/future connector safety, group chat authorization, and gateway recovery. |
| v0.46 | [Tool Growth Surface Slimming](v0.46-tool-growth-surface-slimming.md) | Keep tool-growth internals but expose them through a lighter guided UX. |
| v0.47-v0.50 | Product Flow Compression | Compress the normal product surface around setup, chat/run, status, continuity, connector setup, and explicit pending approvals. Advanced governance remains available but is not the first-run path. |

## Normal / Advanced / Debug UX

Normal UX should focus on daily use:

- `init`
- provider setup/use/check
- `start`, `chat`, `run`
- session list/use/new
- memory inspect/review
- `pending`, `apply`, and `cancel` for durable pending approvals
- gateway connector enable/set/check/start
- status/doctor/config check

Advanced UX should remain available, but should not dominate normal flows:

- capability scan/proposal internals
- ToolDraft / ToolCandidate internals
- active tool registry details
- learned blueprint management
- policy repair internals

Debug UX should be explicit:

- prompt manifests
- last prompt/user message debug files
- runtime command catalogs/triggers
- audit/evidence inspection

## Documentation Boundary

- `Docs/architecture/cosia-identity-and-direction.md` defines what COSIA is.
- `Docs/architecture/cosia-refactor-direction-notes.md` explains implementation direction and boundaries.
- `Docs/architecture/project-refactoring-legacy-removal.md` is the cleanup backlog.
- `Docs/refactors/` contains staged execution plans.

## Non-Goals Across All Phases

- Do not enable `ts_module` execution.
- Do not add broad arbitrary shell automation.
- Do not silently auto-register active executable tools.
- Do not let Telegram or any gateway own provider selection.
- Do not reintroduce hardcoded provider defaults.
- Do not commit private runtime state.
- Do not collapse memory, debug logs, and session context into one concept.
