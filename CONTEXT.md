# Context

## Language

**toolchain parity**:
The invariant that the bun and Node versions used by the containerized worker gates equal the versions used by CI and the pinned source of truth, so an in-loop gate result matches CI by construction.

**version-skip masking**:
A failure mode where a test is skipped based on the runtime toolchain version (e.g. skipIf(bun<1.3)), so a container running an older toolchain skips a test that CI runs, hiding a real failure from the in-loop gates while the host CI goes red.

**bun-version single source of truth**:
A single repo-root file (.bun-version, with .tool-versions for Node) pinning the exact toolchain versions that both CI (setup-bun bun-version-file) and the container Dockerfile (build-arg) read, so the two cannot diverge.

**container preflight fail-closed assert**:
A preflight check that refuses to dispatch a containerized worker when the running image toolchain does not equal the pinned source of truth, escalating instead of running blind.

**sidecar auto-rebuild**:
The sidecar behavior of rebuilding the worker container image on a preflight toolchain mismatch against the pinned source of truth, so toolchain updates roll out with no operator rebuild ceremony.
