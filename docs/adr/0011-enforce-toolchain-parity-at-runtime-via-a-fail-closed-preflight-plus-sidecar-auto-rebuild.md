# ADR 0011: Enforce toolchain parity at runtime via a fail-closed preflight plus sidecar auto-rebuild

## Context

Build-time pinning still relies on someone remembering to rebuild the worker image after a bump (CAM-180 was a manual operator ceremony; CAM-192 is image staleness). A stale image silently reintroduces the divergence. The operator required a fully automatic update path with no manual step.

## Decision

Extend the container preflight to assert the running image bun == .bun-version and Node == target, fail-closed. On mismatch the sidecar auto-rebuilds the worker image (docker build with BUN_VERSION and HOST_UID/HOST_GID build-args), re-asserts, and only then dispatches; a rebuild failure fails closed and escalates. The rebuild is the sidecar's job, never an operator ceremony.

## Consequences

Parity becomes a runtime invariant, not a convention: the loop cannot dispatch on a stale-toolchain image. The initial rollout and every future bump self-apply with zero operator action, closing CAM-180 and CAM-192. Cost: a docker build (minutes) on the first tick after a bump, bounded by rebuilding only on mismatch and Docker layer caching.
