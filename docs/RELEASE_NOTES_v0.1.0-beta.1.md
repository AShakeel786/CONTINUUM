# CONTINUUM v0.1.0-beta.1 — Release Notes

CONTINUUM is provider-neutral AI development continuity and token-efficiency
infrastructure: run Claude Code, DeepSeek, Codex, or any OpenAI/Anthropic-compatible
API from one interface, preserve memory and task state, switch agents without starting
over, keep prompts shorter, and reduce unnecessary token usage.

This first public beta ships:

- bundled providers (Claude Code, DeepSeek, Codex) plus user-defined compatible
  CLI/API providers via secret-free manifests;
- a generic API-agent runtime for API-only providers;
- durable session state with cross-provider handoff and native CLI session continuity;
- a provider-independent MCP tool server with idempotent auto-connect;
- a `doctor` health/recovery command;
- four fail-closed token-efficiency mechanisms: repo intelligence, tool-output
  optimization, deterministic tool-result caching, and reversible context pruning.

Measured on a representative CONTINUUM coding task: 6,167 → 4,734 estimated model input
tokens (−23.2%), tool executions 16 → 10, no measured fidelity regression. That is a
measured representative benchmark, not a universal savings guarantee.

CONTINUUM benefited from ideas explored throughout the open-source AI tooling ecosystem.
The implementation is CONTINUUM's unified architecture; the projects whose concepts
influenced it are credited in the README ("Projects we learned from") and in
`docs/THIRD_PARTY_PROVENANCE_AUDIT.md`. See `docs/RELEASE_READINESS.md` for known
limitations.

**Beta caveats:** macOS is the most-tested platform; API-agent responses are non-streaming;
the optional Tencent memory stack is a separate component; this is a clone-and-build beta
(no npm registry distribution, no UI).

License: MIT.
