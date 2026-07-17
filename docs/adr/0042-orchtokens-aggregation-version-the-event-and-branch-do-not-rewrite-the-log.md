# ADR 0042: orchTokens aggregation: version the event and branch, do not rewrite the log

## Context

orchTokens is written as a cumulative orchestrator session snapshot re-emitted into every cycle-tokens event, and aggregateTokensPerIssue summed those per-cycle totals, inflating per-issue totals roughly quadratically in cycle count and producing absurd ~30M-token split-advisory projections for jobSize=1 buckets (reproduced 3 consecutive cycles). A forward-only write-side fix (emit deltas) leaves already-logged cumulative events wrong; a one-shot rewrite of the append-only .jsonl log destroys the original audit history.

## Decision

Do both fixes with an explicit event mode marker. Write-side: recordCycleTokens emits orchTokens as a per-cycle delta tagged orchTokensMode='delta' (or a bumped cycle-tokens event schemaVersion). Read-side: aggregateTokensPerIssue branches on the marker: delta-mode events are summed directly, legacy cumulative events (no marker) are collapsed per orchestrator session rather than summed; workerTokens continue summing per-cycle. The append-only log is never rewritten.

## Consequences

Aggregation carries dual-path logic for as long as legacy cumulative logs exist; the cycle-tokens event schema gains a mode marker whose absence must mean legacy cumulative (back-compat); the historical event log stays intact and auditable. The split-advisory heuristic math is untouched.
