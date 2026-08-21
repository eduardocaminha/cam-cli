# Changelog

Gateship is in external beta. This file records the current public baseline and
notable changes after it; older implementation detail remains available in
[Git history](https://github.com/gateship-dev/gateship/commits/main) and
[GitHub Releases](https://github.com/gateship-dev/gateship/releases).

## Unreleased

- Curated the published repository around the current web-first product and
  removed superseded pre-beta archives from the checkout.

## v0.310.0 beta baseline — 2026-08-21

Gateship is a local, web-first software-delivery runtime for one operator. Its
current beta baseline provides:

- one Bun service and one SQLite store for the React operator UI, durable run
  state, events, settings, and provider-neutral conversation;
- subscription-backed Claude Code and Codex adapters with credential-blind
  authentication and explicit child-environment allowlists;
- human-approved task contracts, fresh `origin/main` worktrees, deterministic
  verification, independent read-only review, and squash-merge shipping;
- bounded recovery for provider holds, process restarts, failed shipping, and
  native self-updates while preserving work that is dirty or uncertain;
- advisory diagnostics, revision-cohort observations, proposals, notifications,
  and complete `en-US` and `pt-BR` product catalogs without automatic policy or
  approval changes; and
- native release binaries and a single container image containing the service,
  provider CLIs, Git, and GitHub CLI.
