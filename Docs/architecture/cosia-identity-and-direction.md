# COSIA Identity And Direction

## Purpose

This document defines the product identity and architecture direction of COSIA.
It is the high-level reference for maintainers and advisors when deciding whether future work belongs in the core runtime.

COSIA has grown through implementation experiments around memory, policy, providers, gateways, tools, prompts, approvals, and self-improvement. Those experiments remain valuable, but this document keeps the product shape separate from implementation history.

Implementation-specific refactor notes live in `Docs/architecture/cosia-refactor-direction-notes.md`.
Project-wide cleanup backlog items live in `Docs/architecture/project-refactoring-legacy-removal.md`.
Detailed staged refactor plans live in `Docs/refactors/`.

## One Sentence

COSIA is a lightweight, provider-neutral agentic runtime guided by a user-amendable Codex, with workspace-owned memory, approval-gated local capability, and evidence-preserving self-improvement.

## Problem Statement

When AI is used on long-running projects, the user's context, rules, memory, connector state, approval history, tool history, and learned working patterns should remain owned by the workspace rather than being locked inside one provider or chat product.

This problem statement should filter future core work. A change belongs in the core runtime only if it improves at least one of these properties:

- workspace-owned continuity
- Codex-law governance
- provider portability
- memory quality
- connector reliability
- approval-gated local capability
- evidence-preserving self-improvement

## Expanded Definition

COSIA stands for:

```text
Codex-Oriented Self-Improving Agent Runtime
```

`Codex-Oriented` does not mean provider-locked to the OpenAI Codex product or Codex CLI.

It means COSIA is oriented around a user-amendable Codex: the workspace-owned law and operating constitution stored under `codex/`.

The Codex consists of files such as:

- `codex/SECURITY.md`
- `codex/POLICY.md`
- `codex/RULES.md`
- `codex/SOUL.md`
- `codex/USER.md`

These files are not decorative prompt text. They express policy intent, user authority, agent style, security boundaries, and amendment rules that the runtime should reflect through deterministic enforcement.

## Codex Law And Enforcement

Codex law is normative, but it is not sufficient by itself as a security boundary.

COSIA must not rely on LLM obedience to Markdown files as the only enforcement layer.

The intended relationship is:

```text
Codex law
  -> human-readable operating constitution
  -> prompt guidance
  -> repair/check source material
  -> policy intent

Deterministic runtime enforcement
  -> PolicyEngine
  -> approval gates
  -> connector authorization
  -> active tool visibility filters
  -> filesystem/path boundaries
  -> audit/evidence records
```

In short:

```text
Codex law defines what should be true.
Runtime policy code enforces what must be true.
LLM prompt obedience is not a security boundary.
```

Future refactors should strengthen the connection between Codex law and deterministic enforcement without blurring the distinction between them.

## Permission Philosophy

COSIA should not treat every risky capability as permanently unavailable.

The default model is approval-gated delegation:

- low-risk actions may be allowed by default within the active workspace policy
- high-risk actions require explicit user approval before execution
- delegated high-risk permissions must be revocable and evidence-recorded
- Codex-risk changes require the approved Codex amendment flow
- hard-deny actions remain disallowed even when an ordinary approval exists

Hard-deny actions include policy-engine bypass, tool-registry bypass, secret persistence outside approved private secret storage, secret promotion into memory or skills, unapproved external send, and protected Codex modification outside the amendment flow.

This keeps COSIA capable without making it silently autonomous. The user remains the authority that grants, withholds, narrows, or revokes delegated power.

## What COSIA Is

COSIA is:

- a lightweight local agentic CLI/runtime
- a user-owned workspace continuity layer
- a provider-neutral brain adapter layer
- a local memory and session continuity system
- a policy and approval gate around local actions
- a connector host for external surfaces
- a Codex-law-driven agent environment
- a place where repeated, approved work can become local capability

COSIA may be inspired by the workflow style of Codex CLI, Hermes-style skill learning, and local-first MCP memory systems, but it should be governed by the user's local Codex law and should not be locked to one provider or one chat surface.

## What COSIA Is Not

COSIA is not:

- a provider-locked chatbot
- an OpenAI Codex CLI clone
- a general shell wrapper
- a fully autonomous OS agent
- a system that silently creates and activates executable tools
- a replacement for strong frontier models
- a place where every internal state machine should leak into normal UX

COSIA should not try to make every action automatic. It should make useful actions recoverable, reviewable, repeatable, and governed.

## Core Thesis

Models will change.

Provider APIs will change.

Chat products will change.

The user's workspace, memory, rules, preferences, approvals, and operational history should not disappear when the model changes.

COSIA should own continuity:

- the Codex law
- the memory graph
- the session history
- the connector state
- the tool evidence
- the approval trail
- the local capability history
- the learned local working patterns

The model is a replaceable brain. COSIA is the user-owned body, memory, law, connectors, and evidence around that brain.

## Design Pillars

### 1. User-Amendable Codex Law

COSIA should be governed by files the user can inspect and amend.

The Codex law should be visible, repairable, and reflected in runtime behavior. If a policy, security rule, agent style, or user preference matters, it should eventually have a durable representation rather than living only in transient chat context.

Protected Codex amendment must remain separate from ordinary file writing. The user may approve, reject, pause, reverse, or request changes to Codex amendments.

### 2. Provider-Neutral Brain

COSIA should support multiple provider profiles.

Provider switching should not discard sessions, memory, connector state, approval evidence, or Codex law.

Provider-neutral does not mean every provider is equally capable. Different providers may vary in structured output reliability, tool-call adherence, context handling, Korean conversational quality, coding quality, latency, and safety behavior.

COSIA should treat provider differences as runtime facts. Provider adapters may include validation, parsing, retry, and fallback behavior so that a weaker or less compatible model does not corrupt COSIA state.

### 3. Workspace-Owned Memory

COSIA memory should belong to the workspace, not to a provider.

Session context, session summaries, long-term memory, and debug records should remain distinct concepts:

- session context: recent working memory
- session summary: compact continuity
- long-term memory: durable facts, preferences, decisions, and learned context
- debug records: observability for prompt/model behavior

Local-first memory should support candidate-first promotion. Durable memory should not silently absorb secrets, raw private outputs, or unresolved conflicts.

### 4. Approval-Gated Local Capability

COSIA should be useful on the local machine, but local power must pass through explicit policy and approval gates.

Repeated approved work may become local capability, but executable activation must be reviewed. Candidate generation can be assisted; activation and high-risk execution require approval.

Broad shell access should not be the long-term model-facing interface. Repeated local actions should move toward governed tools with typed arguments, previews, evidence, and revocation.

### 5. Evidence-Preserving Self-Improvement

COSIA may improve itself by learning from repeated successful patterns, but self-improvement must leave evidence.

Skill growth should be candidate-first: the runtime may propose procedural knowledge or reusable local capabilities, but activation should be governed by Codex law, policy gates, tests where applicable, and user review.

Rejected candidates, failed attempts, approvals, activations, and deactivations should not disappear silently. Evidence should preserve rationale, ids, timestamps, hashes, redacted summaries, and decision records rather than raw secrets or sensitive outputs.

### 6. Lightweight Surface

Normal use should feel much lighter than the internal architecture.

The user should not need to manually think about every internal layer. Day-to-day flows should focus on starting or continuing work, asking the agent, inspecting memory, approving risky changes, connecting providers or gateways, and turning repeated work into governed capability.

Advanced internals should remain available for debugging and governance, but they should not dominate the normal UX.

## Runtime Boundary

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
  -> external surfaces under authorization

Tool Runtime
  -> approved executable capabilities, evidence, activation state

Self-Improvement Runtime
  -> candidate-first skills and local capability growth behind explicit gates
```

These boundaries should guide future module splits, CLI simplification, and documentation.

## Relationship To Codex CLI

COSIA can be described as "lightweight Codex-CLI-like" only in workflow shape, not in provider ownership.

More precise wording:

```text
COSIA is a lightweight, provider-neutral agentic runtime guided by a user-amendable Codex,
with workspace-owned memory, approval-gated local capability, and evidence-preserving self-improvement.
```

COSIA may use Codex CLI as one provider profile.

COSIA should not assume Codex CLI is always present, should not hardcode Codex OAuth as a special default path, and should not compete by becoming a full clone of that experience.

## Direction Summary

COSIA should continue as the current project, not restart from a new repository.

The current codebase contains valuable runtime experiments and tested components. The problem is not that the project is fundamentally wrong. The product identity and user-facing surface need to be tightened around the user-amendable Codex runtime identity.

The recommended path is:

```text
Keep the existing repo.
Refactor around the user-amendable Codex runtime identity.
Slim the user-facing surface.
Keep advanced capability growth behind explicit gates.
Strengthen provider-neutral memory and connector behavior.
Preserve evidence without preserving secrets.
```

