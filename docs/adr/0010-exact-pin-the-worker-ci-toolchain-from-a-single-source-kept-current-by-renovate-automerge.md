# ADR 0010: Exact-pin the worker/CI toolchain from a single source, kept current by Renovate automerge

## Context

The container was pinned to oven/bun:1.2-slim (bun 1.2.23) while CI used setup-bun@v2 with no bun-version, floating to latest (1.3.x). Because both in-loop gates (implementer and reviewer) run containerized, any test gated on toolchain version was skipped in-loop but ran on host/CI, letting a worker mask a failing test. Alternatives considered: minor-float pins (still drift by patch), Dependabot (cannot manage a .bun-version single source), and manual bumps (hand-editing, the thing that caused the drift).

## Decision

Pin bun and Node to exact versions in single-source files (.bun-version, .tool-versions) read by both CI (bun-version-file) and the Dockerfile (build-arg). Adopt Renovate (GitHub App) to open update PRs for those files, the Docker base image, and the Actions, with automerge enabled for patch, minor, and major gated on the required check:all CI status. Reject minor-float, Dependabot, and manual bumps.

## Consequences

Container, CI, and the pin are identical by construction; the version-skip drift class is structurally closed. Updates arrive as CI-validated PRs that auto-merge on green with zero hand-editing. Residual: a major that breaks in a way no test/gate covers could auto-merge, the same trust model cam already applies to its own auto-merged PRs. Renovate requires a one-time app install (free, public repo).
