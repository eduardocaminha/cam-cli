# ADR 0021: Gate container-scoped Renovate automerge on a path-filtered ci-container required check

## Context

Renovate automerge (ADR 0010) is gated on the required 'ci' status check, but 'ci' runs on macos-latest with no Docker daemon and never builds or runs the worker container (the CAM-178 trap). So a container-only bump (dockerfile base image, asdf/.tool-versions nodejs) auto-merges to main once the macOS CI is green, even though nothing validated the container. CAM-178/186/201 shipped container support but left container regression protection on-demand-only (macOS CI has no Docker). Alternatives considered: (a) disable automerge for the container-scoped managers entirely (simple, but loses the automation and the container is still never CI-validated); (b) run the full container suite on every PR (continuous parity, but ~doubles CI time for the frequently-shipping autonomous loop with no signal for non-container changes).

## Decision

Add a separate ci-container job on ubuntu-latest (which has Docker) that always runs but neutral-passes fast unless a container-scoped path (.devcontainer/**, .tool-versions) changed, in which case it builds the image and runs test-in-container.ts. Make ci-container a branch-protection required status check. Renovate's existing automerge gating then waits on ci-container for the container-scoped bumps automatically, so renovate.json is left unchanged. The macOS 'ci' job stays as-is for host parity.

## Consequences

Container-scoped bumps can no longer auto-merge without real in-container validation; non-container PRs neutral-pass ci-container quickly and merge as before. Cost: container PRs pay a multi-minute image build + full in-container suite. This intentionally does NOT provide always-on host/container parity (a broader concern). A .bun-version bump still touches the container image unvalidated, accepted because bun is validated on the host.
