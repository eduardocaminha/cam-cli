# ADR 0041: Operator-decision gates use a generic file-based pause primitive, not phase-embedded state

## Context

The plan-runner, and later the ship-runner (CAM-149) and unattended drainer (CAM-139), need to pause for a human decision at points the sidecar cannot auto-decide: PRD approval in operator mode, an in-progress-work conflict, ship confirmation, a drainer kill-switch. The sidecar is a background process detached from the orchestrator pane. The loop file .claude/cam-loop.local.md frontmatter carries only flat scalars and cannot hold a structured { gate, options[], context } object. phase:awaiting-operator already existed in the LoopPhase enum but was a passive dead-end (active derives false, the sidecar idles, nothing consumes a decision).

## Decision

Represent an active operator-decision gate as a dedicated durable file .claude/.cam-gate.json carrying { gate, options[], context, decision? }, alongside phase:awaiting-operator as the coarse loop state. The human's answer is written back into the SAME file (single source of truth, no split-brain) by a new `cam decide <decision>` thin-proxy that validates the decision against the active gate's options[]. The sidecar polls the file, re-validates, executes the gate's resolution path, deletes the file, and flips phase. The gate shape is generic (discriminator + options[] + context) so CAM-149 ship-pauses and CAM-139 the drainer kill-switch reuse it unchanged. `cam decide` is a distinct verb from the pre-existing `cam resume` interrupt-recovery command.

## Consequences

A new file-based contract joins the existing durable-marker family (.cam-plan-escalated.json, .cam-ship-stalled.json, .cam-implement-blocked.json), consumed-on-resolution with stale copies cleared at gate-write time. The loop file's flat scalar contract is preserved. Two separate verbs (`cam resume` for recovery, `cam decide` for gate answering) must be kept semantically distinct. Reversing this to embed the gate inside loop-file frontmatter would require a loop-file schema change and break marker-family consistency; the file-based shape is therefore a deliberate, hard-to-reverse contract that downstream gate consumers depend on.
