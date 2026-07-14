# ADR 0038: Shared hand-rolled TS guard for worker/review reports, not zod or a JSON-schema loader

## Context

worker-report.json and review-report.json are consumed by four scattered ad-hoc runtime guards (host.ts, result.ts with a divergent WorkerReportFallback type, loop.ts, review.ts), leaving nested fields (gates, findings) unchecked and the type duplicated. A single source of truth was needed. The repo has no zod dependency and no runtime JSON-schema-validator idiom: the *.schema.json files (handoff/orch-handoff/issues) are draft-07 documentation only, and every runtime validation in the codebase (readOrchHandoff, the report readers) is a hand-rolled TypeScript typeof guard against an exported interface.

## Decision

Consolidate validation into ONE shared hand-rolled parse module in src/supervisor/ (parseWorkerReport / parseReviewReport, fail-closed T | null) that every reader routes through, re-exporting the existing WorkerReport / ReviewReport types. Reject introducing zod or an ajv/JSON-schema-file loader for these two files.

## Consequences

Zero new runtime dependency in the bun-compile single-file binary; validation stays consistent with the codebase idiom; nested gates/findings are now validated (strictly more than before). The cost is manual nested-field checks and no schema-inferred types. zod remains a viable REPO-WIDE bet if the team later chooses to standardize validation library-wide, which would supersede this ADR and warrant its own decision; adopting zod for only these two files was rejected to avoid a lone island of a new pattern.
