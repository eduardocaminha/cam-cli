# ADR 0037: Doc-as-code gate detects path-claims by heuristic + allowlist, not explicit annotation

## Context

The gate must decide which backtick-delimited spans in CLAUDE.md / agent docs are file-path claims to resolve versus incidental code tokens (env vars, regex, JSON keys, tool names). Two strategies were weighed: (a) a path-shape heuristic (contains '/' or a known source extension, no spaces/metachars, strip :NNN line-refs, glob spans match >=1 file) backed by a known-missing allowlist for runtime artifacts; (b) an explicit opt-in annotation syntax the docs would adopt so only marked spans are validated.

## Decision

Adopt the heuristic + allowlist (a). Spans passing the heuristic must resolve on the filesystem or appear in the allowlist; spans failing the heuristic are ignored.

## Consequences

No existing docs need rewriting to opt in, so the gate delivers value immediately across the whole scanned surface. The cost is heuristic false-positives, absorbed by the audited known-missing allowlist (each entry carries a reason and the gate warns on unused entries). Reversing to explicit annotation later would require retrofitting markup across all scanned docs, so the heuristic choice is moderately sticky.
