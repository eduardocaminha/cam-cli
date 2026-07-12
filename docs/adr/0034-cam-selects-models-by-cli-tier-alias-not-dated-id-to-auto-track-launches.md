# ADR 0034: cam selects models by CLI tier alias, not dated id, to auto-track launches

## Context

cam is subscription-only via the claude CLI and has no Anthropic API key, so the GET /v1/models discovery endpoint is unavailable and the CLI exposes no headless model-list. cam previously hardcoded dated model ids (claude-opus-4-8, claude-sonnet-5) across four sites (MODEL_OPTIONS, DEFAULTS, template frontmatter, project.toml) that go stale on every Anthropic release and drift out of sync.

## Decision

Select models by the CLI's tier aliases (opus/sonnet/haiku/default/...) as first-class options, with a free-text passthrough for pinning a dated snapshot or entering a preview id. cam forwards --model to the CLI, which resolves the alias to the current model, so new launches are picked up automatically with no detection code or API-key path.

## Consequences

New Anthropic models become available with zero maintenance and the multi-site dated-id drift dissolves. Cost: alias selection is not reproducible (the effective model changes as Anthropic ships new tiers, and 'default' varies by subscription); users who need a pinned, reproducible model must use the free-text dated id. Alternatives rejected: polling GET /v1/models (needs an API key subscription users lack), and continuing to hardcode dated ids (perpetual manual maintenance + drift).
