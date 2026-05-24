# COSIA Refactor Direction Notes

## Purpose

This document preserves implementation-specific direction that was split out of `Docs/architecture/cosia-identity-and-direction.md`.

The identity document should stay focused on what COSIA is. This document may mention current subsystems, historical experiments, and refactor guidance that are useful to maintainers but too specific for the top-level product identity.

This is not a replacement for `Docs/architecture/project-refactoring-legacy-removal.md`. The legacy-removal document remains the project-wide cleanup backlog. This file is the direction note that explains how implementation details should be shaped by the identity document.

Detailed staged refactor plans live in `Docs/refactors/`. Those phase documents translate this direction into implementation-ready work packages.

## Normal And Advanced UX Boundary

Normal use should include only the concepts needed for day-to-day work.

Normal UX:

| Area | Should Be Normal UX? | Notes |
| --- | --- | --- |
| `init` | yes | Start a workspace. |
| provider profile setup/use/check | yes | Connect a replaceable brain. |
| `start`, `chat`, `run` | yes | Main interaction paths. |
| session list/use/new | yes | Basic continuity. |
| memory inspect/review | yes | Workspace-owned memory should be visible. |
| approval/cancel for pending mutations | yes | Safety-critical and user-facing. |
| gateway connector enable/set/check/start | yes | External body setup. |
| status/doctor/config check | yes | Basic health and recovery. |

Advanced UX:

| Area | Should Be Advanced UX? | Notes |
| --- | --- | --- |
| capability scan/proposal internals | advanced | Useful for zero-base reasoning, but too detailed for normal use. |
| ToolDraft / ToolCandidate internals | advanced | Governance/debug layer behind guided flows. |
| active tool registry details | advanced | Show through focused inspection commands, not normal chat. |
| learned blueprint management | advanced | Useful later, not default surface. |
| prompt manifests and debug prompt files | advanced/debug | Essential for diagnosis, not normal UX. |
| policy repair internals | advanced | Normal users should see checks and recovery commands. |
| command interpreter catalogs/triggers | advanced/debug | Runtime implementation details. |

Guided UX may bridge the two.

For example, a guided tool-growth command can orchestrate capability proposal, draft, candidate, test, and activation state while presenting the normal user with one coherent review flow.

## Connector And Gateway Notes

Connectors such as Telegram are COSIA's external body.

They should follow consistent configuration patterns:

```text
enable
disable
set
unset
list
check
```

Connector configuration must not own model provider selection.

Connectors should be safe by default, especially in shared spaces such as group chats. Group support requires explicit attention to chat-level and user-level authorization.

For group chats, chat allowlisting alone is not enough for mutation-capable operation.

Future group-safe connector behavior should distinguish:

- chat allowlist: which chat can reach COSIA
- user allowlist: which users can ask COSIA to act
- admin-only mutation: who can approve writes, shell approvals, tool activation, and config changes
- read-only group default: whether groups can only inspect status unless explicitly upgraded
- mention/reply routing: when the bot should listen in a busy group

Until user-level authorization exists, group usage should be treated as higher risk than one-to-one chat.

## Tool Growth Internals

COSIA should not expose every internal state machine through normal UX, but the internal governance states remain useful.

The implementation may retain concepts such as:

- capability scan
- proposal
- draft
- candidate
- test
- approval
- activation
- deactivation
- archive

These concepts should support evidence-preserving self-improvement without forcing the user to manually manage every stage.

The normal UX should say what the agent wants to do, why it is useful, what risk it carries, what will change, and what approval is needed.

## Executable Capability Gates

Automatic candidate generation can be useful.

Automatic executable activation is dangerous.

COSIA should maintain a strong boundary:

- candidate generation may be assisted
- testing requires explicit approval when execution is involved
- active executable registration requires explicit user approval
- delegated high-risk permissions should be revocable and evidence-recorded
- shell and command adapters must remain policy-gated
- `ts_module` execution remains out of scope until a separate security design exists

High-risk capability should be described as approval-required and delegable, unless the action is a hard-deny such as policy bypass, secret persistence outside approved private secret storage, or protected Codex modification outside amendment flow.

## Governed Terminal Direction

Approved Shell Bridge is a temporary bridge for local development. The long-term direction should move repeated shell actions toward governed tools.

Target properties:

- use structured executable and argument handling where possible
- classify command purpose before execution
- separate model-facing requests from the internal terminal substrate
- require preview, approval, tests or dry-run probes, and rollback notes before turning repeated commands into active tools
- prevent raw stdout/stderr from becoming memory or evidence without redaction

Shell bridge is practical, but it is not the final governance model.

## Runtime Direction

The runtime should be organized around these boundaries:

```text
Codex Law
  -> policy, style, security, user preferences

Provider Profiles
  -> replaceable model brain

Session Runtime
  -> context, summary, debug prompt, current work

Memory Runtime
  -> durable workspace-owned facts and decisions

Connector Runtime
  -> external surfaces such as Telegram and future gateways

Tool Runtime
  -> approved executable capabilities, evidence, activation state

Advanced Growth
  -> proposal/draft/candidate/blueprint flows behind explicit gates
```

These boundaries should guide future module splits and CLI simplification.

## Next Refactor Priorities

The next major refactoring should not start by adding more features.

It should first clarify the product shape:

1. Update README and docs to define COSIA as a user-amendable Codex based runtime.
2. Separate core user flows from advanced/experimental flows.
3. Keep provider profiles as the only normal provider selection path.
4. Make Codex law amendment/check/repair a first-class concept.
5. Keep memory concepts visible but simpler.
6. Keep gateway connector setup simple and connector-owned.
7. Preserve tool growth internals, but reduce how often they leak into normal UX.
8. Keep debug observability for prompts, manifests, evidence, and connector state.

## Open Questions

These remain design questions, not settled implementation requirements:

- How much natural-language runtime command interpretation should gateways allow?
- Should Telegram group chat support be read-only by default?
- Should group mutations require per-user allowlists in addition to chat allowlists?
- How much of tool growth should be visible in normal UX?
- Which memories should be promoted automatically, and which should require review?
- How should provider A/B comparison be exposed?
- How should user-amendable Codex law changes be proposed, reviewed, and applied?
- Which advanced commands should be hidden from default help?

## Non-Goals For The Next Refactor

The next refactor should not:

- activate `ts_module` execution
- add broad arbitrary shell automation
- silently auto-register active executable tools
- make Telegram or any gateway own provider selection
- reintroduce hardcoded provider defaults
- commit private runtime state
- collapse memory, debug logs, and session context into one concept

## Verification Notes

When this direction is implemented, verify that:

- the identity document reads as a product and architecture identity, not a backlog
- implementation-specific terms such as Telegram, ToolDraft, ToolCandidate, prompt manifests, and `ts_module` live here or in the project-wide refactoring backlog rather than dominating the identity document
- high-risk capabilities are described as approval-required and delegable by the user, while true hard-deny actions remain explicitly disallowed
- no public API, CLI command, config schema, policy JSON, or runtime behavior changes are implied by this documentation split alone

