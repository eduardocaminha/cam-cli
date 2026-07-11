# ADR 0026: The cam-worker container is torn down at session exit; a firewall or sidecar death surfaces durably and respawns bounded, never hot-loops

## Context

In container mode the sidecar runs the firewall init (dnsmasq on port 53) at boot. A prior session's cam-worker container was left running at exit (stop.ts cleaned only tmux/markers; ensure-container reuses a running container), so a subsequent boot inherited its stale dnsmasq, the port-53 bind failed, and the sidecar aborted to stderr-only with no durable marker, no respawn, and a cam plan/next/ship liveness gate that checks the orchestrator pane (not the sidecar pid) - so a signal was written and silently never consumed. Recovery required a full operator ceremony (cam stop + docker rm -f cam-worker + cam run).

## Decision

Tear the cam-worker container down at session exit (docker rm -f in stop.ts) so no stale running container is inherited, and defend the collision in init-firewall.sh by reaping whatever dnsmasq holds port 53 plus one retry, fail-closed. Make sidecar death observable and recoverable: a single durable .cam-sidecar-stalled.json marker surfaced at orchestrator boot, a sidecar-liveness watcher that respawns a dead sidecar a bounded number of times and then escalates via the marker instead of hot-looping, and cam plan/next/ship gates that check sidecarAlive() and refuse rather than orphaning a signal.

## Consequences

The specific port-53 wedge is eliminated at its root (no stale container) with a script-level backstop for crash-without-stop. Any silent sidecar death now surfaces and self-heals for transient crashes while escalating persistent ones. Cost: the next session restarts the container (fast) or rebuilds only if the image is stale, via the existing absent->build path. Rejected alternatives: reap-only in the script (leaves orphaned containers accumulating as the root cause), and unbounded respawn (hot-loops on a deterministic firewall failure). This whole path is container-only and validated here by tests, not a live run, since the repo runs host mode (live validation is CAM-175).
