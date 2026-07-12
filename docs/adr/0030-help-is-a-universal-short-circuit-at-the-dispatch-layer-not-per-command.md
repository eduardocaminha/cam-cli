# ADR 0030: --help is a universal short-circuit at the dispatch layer, not per-command

## Context

cam sidecar --help started the daemon because the sidecar command ignored the unknown arg and booted. Adding a --help check inside each command body would leave every future command free to re-introduce the same footgun, and would run after side-effects for commands that act before parsing flags.

## Decision

Intercept --help/-h once at the dispatch/arg-parse layer, before any command body runs, printing usage and exiting 0. A table-driven test asserts the invariant holds for every registered command. Considered per-command guards but rejected them as a band-aid that does not protect new commands.

## Consequences

New commands inherit safe --help for free and are covered by the table-driven test automatically. Command usage text must be registered where the central guard can reach it. --help can never start a daemon or mutate state again.
