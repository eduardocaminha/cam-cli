# ADR 0032: Re-spec is demote-then-reinterview, not a stage-aware overwrite

## Context

A stage:specified issue with a defective spec had no sanctioned fix path: /cam-spec and specifyIssueOnMain Guard 4 both hard-refuse a non-idea issue, leaving only fragile workarounds (hand-edit the JSON stage, or abandon+refile). Two fix directions existed: a cam spec --respec that lets specifyIssueOnMain overwrite a specified spec, or a cam issue --demote that moves specified->idea and reuses the existing interview.

## Decision

Add cam issue --demote (specified->idea only) and keep specifyIssueOnMain idea-only. Re-specing then flows through the unchanged /cam-spec interview. Rejected the stage-aware overwrite because it would relax Guard 4 and create a second spec-writing entry with ambiguous partial-overwrite semantics.

## Consequences

One spec-writing path (the interview) and one stage-move primitive, mirroring close/abandon. A demoted issue leaves the plannable set until re-specified, which is correct for a defective spec. The old spec stays on the issue as reference until the next persist overwrites it. Demote is refused for planned/shipped issues to avoid stranding an in-flight PRD.
