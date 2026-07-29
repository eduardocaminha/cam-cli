# Decision: email the operator on every issue completion and next-issue start

Date: 2026-07-29. Source: operator instruction given live during the CAM-458
cycle (2026-07-28/29), recorded in the orchestrator self-handoff for that cycle
and persisted here on the next clean tree. Owner: operator. Status: adopted,
cheaply reversible (routed to memory/, not docs/adr/, because it is a
communication convention, not an architectural decision).

## Context

The operator is not watching the loop while it runs. The orchestrator is the
only actor that knows when an issue finishes and what starts next, so it owns
the notification. The transport is Resend, already configured in
`scripts/cam/project.toml` under `[notify]`:

- `resend_recipient = "caminhae@gmail.com"`
- `resend_from = "cam <cam@reporter.radiologic.io>"`

## Rule: two emails per issue, both short

Send an email at exactly two moments:

1. **Issue completion**, when an issue ships (or otherwise reaches a terminal
   state that ends its cycle).
2. **Next-issue start**, when the following issue begins.

Both emails carry the same four facts and nothing else:

- Which issue (id and a short title).
- Whether there was a review, and if so how many rounds.
- How long the WHOLE issue took, wall clock, start of the cycle to ship.
- What runs next.

## Rule: do not explain

The operator asked explicitly for short messages. No narrative, no rationale,
no summary of the implementation, no lessons. Four facts, then stop. Anything
worth explaining belongs in the journal entry, not in the email.

## Notes

Wall time is per-issue, not per-story and not per-session: it spans planning
through merge, including every review round and any operator ceremony in the
middle. Report the total, not a breakdown.
