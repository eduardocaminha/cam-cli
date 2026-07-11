# ADR 0024: cam-loop.local.md is the single-owner cycle signal; phase is the resume discriminator

## Context

cam-loop.local.md had three uncoordinated writers: phase setters, clearActive (which rewrote the file omitting phase, collapsing it to idle via renderStateFile's active-derived default), and the orchestrator-pane exit wrapper (which rm -f'd the file on orch exit, deleting a live cycle signal under a still-running sidecar during a self-handoff recycle). The intersection of a dropped/deleted phase and the absence of any re-arm path produced an absorbing wedge (CAM-118, 2026-07-06): an in-flight PRD stuck idle with only manual cam next recovery. CAM-191 had worked around one facet (lost phase:shipping) by reordering writes, but left the phase-drop mechanism live.

## Decision

Treat cam-loop.local.md as a single-owner cycle signal with a preserve-by-default lifecycle. renderStateFile becomes read-modify-write: an absent phase preserves the current file's phase rather than deriving a default from active; explicit phase wins; only a nonexistent file defaults to idle. The orchestrator-pane exit wrapper never deletes the file (cam stop and end-of-cycle clearActive are the only deliberate clears). phase:idle is defined as the parked (no-auto-resume) state, and an in-flight PRD with phase==implementing under an inactive loop is a wedge the sidecar re-arms. The idle=parked / implementing=resumable discriminator is only trustworthy because phase is now preserved and the file is never deleted out from under the sidecar.

## Consequences

The re-arm path (CAM-118 recovery) can rely on phase being an honest record of operator intent. The CAM-191 reorder workaround is retired without regressing ship-phase survival. Rejected alternatives: fixing each write call-site to pass phase explicitly (fragile: the next call-site re-introduces the drop, which is how CAM-191 arose) and a conditional rm in the wrapper (adds read+condition logic in tmux-argv bash to preserve a delete-on-exit behavior that has no real value). A future explicit paused-with-intent-to-resume state is out of scope.
