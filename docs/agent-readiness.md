# Agent readiness self-score

A point-in-time self-assessment of cam-cli against the agentic-readiness rubric
that Jaymin West's `os-eco` fleet uses (the public 82-criterion / 9-category
rubric at `jayminwest/os-eco/notes/readiness-report-prompt.md`; `warren`, a
Bun+TS CLI, is the fleet's Level-5 reference). Dogfood research 2026-06-16.

## Methodology

Existence checks, as the rubric mandates ("prefer existence checks over deep
semantic analysis; if ambiguous, fail"). cam is a CLI tool, not a deployed
service, so the service-only criteria (HTTP health endpoints, distributed
tracing, metrics/APM, alerting, canary/feature-flags, DAST, PII handling) are
scored N/A and excluded from the denominator, consistent with `warren` (also a
CLI) being the L5 reference. Judgment calls are flagged; the score is reported
as a band, not a precise grade.

## Score: cam is roughly Level 3 (~26/57 applicable criteria, ~45-50%)

| Category | Pass / applicable | Gap |
|---|---|---|
| Documentation | ~6/8 | strong (README, CLAUDE.md, FLOW.md diagrams, recovery-runbook); missing agents_md_validation (doc-as-code) |
| Testing & Quality | 5/9 | has unit + integration + isolation; missing coverage-threshold, test-perf-tracking, flaky-detection, quality-metrics (all CI/coverage-bound) |
| Style & Validation | 3/8 | type_check + strict_typing pass; no linter/formatter, no complexity/dead-code/dup gates |
| Development Workflow | 4/9 | agentic-development + gh + priority-labels; missing tech-debt-scanner, code-boundaries, unused-deps, pr-template; branch_protection blocked (free private plan) |
| Build System | 2/5 | build doc + lockfile; no file-size/build-perf/bundle-size tracking |
| Security & Compliance | 2/5 applic. | secrets + gitignore; no secret-scanning/codeowners/security-review |
| Observability & Debugging | 2/2 applic. | structured event log (cam-worker-events.jsonl) + backoff resilience; rest N/A (CLI) |
| Development Environment | 1/5 | only single-command-setup; no devcontainer/pre-commit/.env.example |
| Progressive Deployment | 1/6 applic. | rollback runbook; no CD/dep-update/release-notes/auto-pr-review |

Judgment calls that most move the band: `CLAUDE.md` counted as the `agents_md`
criterion; service-only criteria as N/A; `branch_protection` as a structural
fail of the free private plan.

## The keystone: CI cascades

cam has no `.github/workflows` at all, and that single absence fails ~8 criteria
across 5 categories: `fast_ci_feedback`, `build_performance_tracking`,
`test_performance_tracking`, `secret_scanning`, `automated_security_review`,
`agents_md_validation`, `code_quality_metrics`, `release_automation`,
`automated_pr_review`. Adding CI plus the ratchets/coverage moves cam from
Level 3 toward Level 4 without touching any service-only criterion.

## Where cam is already ahead of the rubric

The rubric only checks that tests and coverage EXIST; it does not measure
verification QUALITY. cam's edge is exactly what the rubric does not score: the
two-layer LLM verification (Layer A implementer gate-discipline + Layer B
reviewer with a fixed BINARY rubric and per-criterion evidence) and
machine-checkable acceptanceCriteria with typed oracles (named-command /
file-assert / reviewer-judgment). Every fleet project uses freeform-prose
acceptance and has no in-loop binary judge. So Level 3 understates cam on the
judgment axis; the real gap is purely the deterministic plumbing
(CI / gates / ratchets / typed records).

## Prioritized gap roadmap

Filed as issues, dependency-ordered by leverage:

1. CAM-59 (P1): CI on macOS + gate spine (check:all/verify + ci-parity). Keystone.
2. CAM-60 (P1): linter (biome) + ratchets (coverage / file-size / debt / dead-code / dup).
3. CAM-61 (P2): doc-as-code gate + check-count assertions + golden-fixtures for the CAM_*_STATUS sentinel.
4. CAM-62 (P2): test-quality enforced in the reviewer (anti-mock codified + per-test discipline + flaky), extends CAM-56 Layer B.
5. CAM-63 (P2): harden the supervisor<->worker boundary (orchestrator-surface contract test + actor-ACL + empty-push verification).
6. CAM-64 (P3): typed pattern records + outcome-status + decay (mulch model), replacing free-text patterns.md.

## Future

This self-score was produced by hand against the public rubric. A natural
follow-up is to make it a `cam audit` command that scores the repo against the
rubric and prints the Level plus the per-criterion gaps, so readiness becomes a
tracked, re-runnable signal rather than a one-off snapshot.
