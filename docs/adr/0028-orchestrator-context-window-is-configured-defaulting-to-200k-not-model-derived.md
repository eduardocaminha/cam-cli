# ADR 0028: Orchestrator context window is configured, defaulting to 200k, not model-derived

## Context

orchestratorContextWindow() derived 1M from the model prefix (opus-4-8). But the 1M window is an API/Bedrock/GCP/Foundry feature; the Claude Code flat subscription without API credit runs the 200k standard window (confirmed by the Anthropic context-windows doc). The backstop computing 0.80 of a wrong 1M (800k) never fired before the real ~200k overflow.

## Decision

Read the usable window from a [loop] orch_context_window project.toml key, defaulting to 200000 when absent, and override to 1000000 only when API credit is present. Stop deriving the window from the model prefix.

## Consequences

The backstop now fires against the real ceiling. The value must be maintained by the operator when the runtime channel changes (subscription vs API). A wrong-high value silently disables the backstop, so 200k is the safe default.
