# ADR 0033: Reviewer SUGGESTIONs go to an append-only pen, not auto-filed issues

## Context

The CAM-189 terminal-verdict hook auto-filed every reviewer SUGGESTION as a stage:idea issue after a terminal (CLEAN/MAX_ROUNDS_DEBT) review. Each cosmetic finding then demanded a /cam-spec grill to become plannable, and every shipped PR spawned 1-3 such follow-ups, so the plannable-looking backlog never converged toward zero.

## Decision

Redirect the hook to append SUGGESTIONs to an append-only scripts/cam/suggestions.jsonl holding pen, deduped by the existing suggestion-fingerprint, and add a cam suggestions CLI (list/promote/dismiss) for batch triage. A suggestion is promoted to a real issue only when judged worthy; real defects discovered outside the reviewer still become issues directly.

## Consequences

SUGGESTIONs no longer inflate the backlog or force per-finding grills; a batch triage step and an explicit promote action are introduced; the pen is a durable on-main artifact (like journal.md/patterns.md) that cam init must seed, since the on-main append writers do not bootstrap a missing file. Alternatives considered and rejected: keep auto-filing issues (the status quo treadmill), raise the auto-file severity bar to WARNING+ (loses SUGGESTIONs entirely at terminal-CLEAN, where only SUGGESTIONs exist), or disable auto-capture (drops the findings).
