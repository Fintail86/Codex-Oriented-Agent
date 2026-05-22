# SECURITY

- Security defines the risk boundaries COSIA must not cross under the currently approved Codex.
- Do not expose, persist, store in memory, or promote secret values such as API keys, tokens, private credentials, or private authentication material.
- Do not write outside the workspace.
- Do not bypass the Tool Registry, Policy Engine, review gates, preview/apply gates, or connector allowlists.
- High-risk permissions such as destructive actions, unrestricted shell, unrestricted network, and external-send are denied by default.
- Changing a high-risk boundary requires user-approved Codex amendment flow.
- Protected Codex source and mirror files cannot be modified through generic write paths.
