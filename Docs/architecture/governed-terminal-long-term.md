# Governed Terminal Long-Term Direction

Approved Shell Bridge is a temporary bridge for local development. It lets COSIA create a user-reviewable, one-shot shell approval and execute the exact command only after approval.

## Current Limits

- Shell commands are broad and hard to classify perfectly.
- Risk detection is best-effort heuristic, not a complete shell parser.
- A shell command can run tools that COSIA has not learned as governed tools yet.
- Shell output may contain sensitive data, so raw stdout/stderr must not become memory or evidence.
- Gateway and Telegram shell execution stays blocked by default.

## Long-Term Goal

Governed Terminal should become an internal execution substrate, not a general model-facing shell.

Target properties:

- Use `spawn` or `execFile` style execution with shell wrappers disabled.
- Separate executable and arguments structurally.
- Disallow pipes, redirection, command substitution, glob expansion, and arbitrary shell strings by default.
- Classify command purpose before execution.
- Keep model-facing requests separate from the internal terminal substrate.
- Require preview, approval, test, and revert plans before turning repeated commands into tools.

## Future Flow

1. Environment discovery gathers generic workspace facts.
2. Capability Proposal Planner identifies an abstract capability need.
3. A probe checks whether an environment capability exists.
4. A tool candidate proposes a fixed command adapter or executor.
5. The user reviews the preview, permission, arguments, expected effects, and rollback plan.
6. Tests or dry-run probes verify the candidate.
7. Only approved candidates become active tools.

## Principle

Shell bridge is practical, but it is not the final governance model. Repeated approved shell commands should become evidence for future tool candidates, not a reason to keep using broad shell forever.
