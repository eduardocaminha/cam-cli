# ADR 0018: issue_system none is a deprecated read-normalized alias, not a removed value

## Context

CAM-236 renamed the canonical issue_system value none->local. init's mergeIntoConfig does not rewrite an existing project.toml value, so every already-initialized cam project still carries issue_system='none'. A raw removal (throw on none) silently breaks ship-finalize.ts, ship-pr.ts, and issue-list.ts for all of them.

## Decision

Accept none as a deprecated alias normalized to local at the single read point (readIssueSystem), and keep it accepted by cam init --issue-system. Do not reintroduce none as a canonical or selectable value. Guard the alias permanently via the build-release smoke (cam init --issue-system none) and a unit test.

## Consequences

Existing none-configured projects keep working without a migration. The canonical value and init default remain local. Truly-unknown values still fail loud. Cost: a permanent small compatibility branch in the reader plus a smoke/test guarding it.
