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

## Score: cam is roughly Level 3 (~27/57 applicable criteria, ~45-50%)

Note: score below reflects the pre-CAM-60 baseline. CAM-60 closed the Style &
Validation gap (see section below).

| Category | Pass / applicable | Gap |
|---|---|---|
| Documentation | ~6/8 | strong (README, CLAUDE.md, FLOW.md diagrams, recovery-runbook); missing agents_md_validation (doc-as-code) |
| Testing & Quality | 5/9 | has unit + integration + isolation; missing coverage-threshold, test-perf-tracking, flaky-detection, quality-metrics (all CI/coverage-bound) |
| Style & Validation | 4/8 (pre-CAM-60); ~8/8 post-CAM-60 | type_check + strict_typing pass; biome lint (complexity rules, grandfather overrides) added; no formatter, no dead-code/dup gates. CAM-60 added: coverage, file-size, debt-markers, dead-code, dup ratchets. |
| Development Workflow | 4/9 | agentic-development + gh + priority-labels; missing tech-debt-scanner, code-boundaries, unused-deps, pr-template; branch_protection available (public repo; used by ci-gated mode via CAM-101/CAM-73) |
| Build System | 2/5 | build doc + lockfile; no file-size/build-perf/bundle-size tracking |
| Security & Compliance | 2/5 applic. | secrets + gitignore; no secret-scanning/codeowners/security-review |
| Observability & Debugging | 2/2 applic. | structured event log (cam-worker-events.jsonl) + backoff resilience; rest N/A (CLI) |
| Development Environment | 1/5 | only single-command-setup; no devcontainer/pre-commit/.env.example |
| Progressive Deployment | 1/6 applic. | rollback runbook; no CD/dep-update/release-notes/auto-pr-review |

Judgment calls that most move the band: `CLAUDE.md` counted as the `agents_md`
criterion; service-only criteria as N/A; `branch_protection` counted as
available (the repo is public; branch protection can be enabled and is used by
ci-gated mode, CAM-101 absorbing CAM-73).

## CAM-59 done: CI on macOS + gate spine (2026-06-23)

CAM-59 shipped the CI keystone that was the single largest gap in the 2026-06-16
snapshot. What was added:

- `.github/workflows/ci.yml` running on `macos-latest`, invoking `bun run check:all`
  as the single spine step, plus an `if: always()` summary step that reads
  `gate-results.json` (written by `check:all -- --json`) and appends a per-gate
  timing table to the GitHub step summary.
- `scripts/check-all.ts`: the GATES manifest (typecheck, test, embed-vendor,
  ci-parity) and the `runGates` runner. The `--json` flag writes a structured
  `gate-results.json` for the summary step.
- `scripts/check-ci-parity.ts`: the parity gate that enforces `ci.yml` and the
  GATES manifest stay in sync. Prevents ad-hoc CI steps from drifting out of
  the spine.

With CAM-59, `fast_ci_feedback` and `code_quality_metrics` now pass. The CI
cascade that was failing ~8 criteria now passes the first two; the remaining
gaps (`secret_scanning`, `automated_security_review`, `release_automation`,
`automated_pr_review`) require later issues (CAM-60+).

## The keystone status after CAM-59

cam now has `.github/workflows/ci.yml` running on every push. The gate-spine
pattern means CI will automatically pick up any gate added to `GATES` in
`scripts/check-all.ts` without manual `ci.yml` edits. The ci-parity gate
enforces this contract.

## CAM-60 done: static-layer ratchets (2026-06-23)

CAM-60 closed the Style & Validation gap that was the largest remaining cluster
after CAM-59. What was added:

- `scripts/check-file-sizes.ts`: per-file LOC ratchet. Ceilings captured in
  `scripts/file-size-budget.json`. Raising a ceiling requires a tracker ref in
  the staged diff; lowering is always allowed.
- `scripts/check-debt-markers.ts`: blocks bare TODO/FIXME/HACK/XXX tokens in
  `src/` and `scripts/` (excludes vendor, dist, tests). Self-reference gotcha
  avoided by wrapping the token list in parens in comments.
- `scripts/check-coverage.ts`: enforces a minimum coverage floor (functions and
  lines) parsed from `bun test --coverage` stderr. Lowering the floor requires
  a tracker ref in the staged diff.
- `bunx knip` (dead-code gate): detects unused files using the knip config
  (entry points include tests and scripts; bulk export/type issues grandfathered
  to keep the gate green at adoption time).
- `bunx jscpd@5 --config .jscpd.json src scripts` (dup gate): enforces a 4%
  duplication ceiling via `.jscpd.json` threshold reporter.
- `bunx biome lint --error-on-warnings` (lint gate): style and complexity rules
  via biome 2.x with a lean `biome.json` (per-file grandfather overrides for
  complex orchestration functions; stale suppressions removed).

All 6 gates are entries in the GATES manifest (`scripts/check-all.ts`). The
gate-spine pattern means CI picks them up automatically through `bun run
check:all`; no direct `ci.yml` edits were needed. `bun run check:ci-parity`
verifies this contract.

With CAM-60, the Style & Validation row goes from 4/8 to approximately 8/8
(the remaining gap is a code formatter, which is lower priority than ratchets
on an established codebase with consistent style).

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

1. CAM-59 (P1): CI on macOS + gate spine (check:all/verify + ci-parity). DONE (2026-06-23).
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
