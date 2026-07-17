# ADR 0044: Typed pattern records replace patterns.md go-forward, no bulk migration; decay lives under cam patterns

## Context

CAM-64 asks to replace the free-text patterns.md (833 lines / 538KB) with typed mulch-model records plus outcome-scoring and a decay gate. A big-bang migration of the existing free-text bullets to typed records would require LLM parsing of long prose bullets and is error-prone. The issue also proposes a cam prune command, but cam prune is already the branch-cleanup command (/cam-prune). Outcome-appends fire at cycle-close while a cam run session is live, so the writer must be concurrency-safe.

## Decision

Introduce the typed record store as the go-forward WRITE mechanism only: new patterns are written as typed records; the existing patterns.md stays grep-readable during the transition and is NOT bulk-migrated (archivable via the existing cam patterns archive). Records use a hand-rolled TS typeof guard per ADR-0038 (no zod / no schema-loader). The store is written on-main ref-only (commitTreeToMain + dedup, mirroring suggestions.jsonl), never via branch append. The decay/demotion gate is a new subcommand cam patterns prune under the existing cam patterns namespace, NOT cam prune. Outcome attribution flows from the implementer/planner reporting applied pattern-ids, recorded by the supervisor at cycle-close (mirroring the CAM-189 terminal-verdict hook).

## Consequences

Two pattern stores coexist during the transition (legacy free-text + typed records) and readers must consult both; the issue's literal cam prune name and big-bang replace are not implemented as written; the on-main ref-only writer keeps outcome-appends multi-writer safe; the effort is large and expected to be sliced across multiple PRs.
