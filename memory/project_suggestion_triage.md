# Decision: suggestion-pen triage policy (demand-driven + composition-by-fix-site)

Date: 2026-07-20. Source: orchestrator journal DRAIN-CAM376-2026-07-20 (decision 4)
and DRAIN-CAM378 follow-up. Owner: operator. Status: adopted, cheaply reversible
(routed to memory/, not docs/adr/, because it is a triage heuristic, not an
architectural decision: nothing about it is hard to reverse).

## Context

The terminal-verdict hook (CAM-189) appends every reviewer SUGGESTION finding to
`scripts/cam/suggestions.jsonl` (the pen) after a CLEAN/terminal review, instead
of auto-filing it as a backlog issue. The orchestrator triages the pen with
`cam suggestions list`, `cam suggestions promote <fingerprint>`, and
`cam suggestions dismiss <fingerprint>`. Two rules govern how the orchestrator
should use those commands.

## Rule 1: demand-driven promotion

Promote a penned suggestion only when a cycle is about to touch the surface it
names, not eagerly at the end of every cycle. The pen is durable and committed,
so nothing is lost by leaving an entry unpromoted; there is no cost to letting
low-priority suggestions age in the pen until a cycle's own work makes them
relevant.

This replaced eager promotion. It was adopted on evidence, not intuition: a
measurement across the pen's history found 43 promotions against 35
dismissals, with 26 of 41 promoted issues already shipped, meaning the
promotion filter is well calibrated and tightening it further would drop real
defects. The backlog growth problem is a throughput property (about 2.9 issues
filed per cycle against about 1.4 shipped), not a filter-quality property, so
the fix is picking demand-driven over eager, not promoting less.

## Rule 2: composition-by-fix-site

When multiple penned suggestions share the same file, the same rule, or one
coherent edit, promote them together as ONE composite issue rather than one
issue per suggestion. Shared fate is the test for whether suggestions compose:
if fixing one naturally fixes or touches the same code the others name, they
belong in one issue. A shared theme alone is not enough: suggestions that
share a topic but have independent fix sites (different files, different code
paths, no shared edit) stay separate issues.

The fix site is the practical proxy for shared fate: two suggestions that will
be resolved by editing the same lines, or by one commit, are the same issue.
Two suggestions that happen to describe the same kind of problem but live in
unrelated files are two issues.

This rule exists because the CLI's promote path was historically
single-fingerprint only, so composing suggestions required hand-splitting them
into separate issues even when they shared a fix site, which regressed review
dedup (CAM-378 made `cam suggestions promote` accept multiple fingerprints in
one atomic on-main commit to remove that constraint).
