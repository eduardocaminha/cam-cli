# ADR 0054: The typed alias is `gship`, and internal-contract renames get a bounded pre-launch window instead of "Never"

## Context

ADR-0050 named the product Gateship and left two things open on purpose.

First, it deferred the typed alias: "This ADR does not coin a replacement alias: that choice is re-decided at the launch-packaging stage of the staged rename plan below, the same stage ADR-0049 deferred the binary rename itself to. Inventing a `gateship`-derived alias now, ahead of that stage, would be policy this ADR was not asked to decide." That stage is now active. Launch packaging is the operator's declared priority, and the packaging gap is measured, not assumed: 276 git tags against 0 published GitHub Releases, and a `package.json` carrying `private: true` with no `bin` map, no `files`, no `license`, no `repository`, and no `engines`, so neither `npm i -g` nor `bun install -g` can produce a working command for a stranger today. The deferred decision is due.

Second, ADR-0050 carried forward a "Never rename internal contracts" clause. That clause originates in ADR-0045, was restated by ADR-0049, and was copied into ADR-0050 verbatim, with zero new reasoning added at either hop. Across three ADRs its entire justification is one sentence covering five layers collectively, with no per-layer argument:

> "internal contracts never rename, at any stage... These are invisible contracts baked into running installs, on-disk state, and deterministic git history; renaming any of them is pure downside with no user-facing upside."

ADR-0050 also set the trigger for revisiting it: "a future ADR is only needed if that plan changes, not to execute it." This ADR changes that plan, so it is the required instrument.

A correction to the record belongs here, because it was made and propagated during the analysis that produced this ADR. Neither ADR-0049 nor ADR-0050 lists `scripts/cam/` or the `CAM-` issue prefix in its Never clause. Both were asserted to be in it during this cycle's analysis, from a summary rather than from the source text. They were not. The Never clause names exactly five things: `CAM_*` environment variables, `.cam-*` state files, the `tmux -L cam` socket, `/cam-*` slash commands, and sentinel strings (`CAM_*_STATUS`).

## Decision, part 1: the typed alias is `gship`

The canonical binary is `gateship`, per ADR-0050. The typed alias created by the installer is `gship`. The command `cam` is retired at launch packaging rather than preserved as a personal shell alias, per the operator's explicit instruction on 2026-07-30.

Availability was re-verified on 2026-07-30, which ADR-0050 requires: "the availability facts recorded here are point-in-time... and must be re-checked at the moment those ceremonies actually run." Both `gship` and `gateship` return E404 on npm (free). This fact expires; re-check it at the moment the publish ceremony runs.

The candidate sweep, all measured on 2026-07-30:

| candidate | npm | shell-framework collision | verdict |
|---|---|---|---|
| `gship` | free (E404) | none in oh-my-zsh, bash-it, or prezto | adopted |
| `gsp` | taken (0.5.4, dormant since 2022, 18 weekly downloads) | prezto `modules/git/alias.zsh:240` defines `alias gsp='git stash pop'` | rejected |
| `gsh` | taken (0.0.0) | oh-my-zsh git plugin defines `alias gsh='git show'`; bash-it repeats it | rejected |
| `gs` | taken (0.0.2) | Ghostscript owns `/usr/bin/gs` via the Debian `ghostscript` package; bash-it and prezto both bind it | rejected |
| `gt` | taken (2.16.0, actively maintained: General Translation's CLI) | Graphite's CLI also ships as `gt`; bash-it and prezto bind `gt='git tag'` | rejected |
| `gate` | taken (0.3.0, dormant) | none found, but it is a bare English word with high ambiguity | rejected |
| `gtsp` | free (E404) | none found | rejected: three consonants, must be spelled out letter by letter |

### The fifth gate: shell-framework alias shadowing

ADR-0050 formalized a four-layer name gate (domain, npm, GitHub org, live homonymous product) and declared layer 4 eliminatory. That gate is correct for a product name and insufficient for a short typed alias, because it does not model the way a short command actually fails.

A shell alias shadows a `PATH` binary silently. The user types the alias, gets someone else's command, and receives no error and no clue. There is no diagnostic, no conflict warning, and no exit code to inspect. The failure surfaces as confusion, not as breakage.

The magnitude is measured, not estimated. The oh-my-zsh git plugin, fetched from its canonical source on 2026-07-30, defines **197 `g*` aliases**, of which **21 are `gs*`**. bash-it and prezto define overlapping but non-identical sets. Any short `g`-prefixed alias is therefore being planted in a namespace that three widely-installed frameworks already occupy densely and continue to extend. Passing today is not the same as staying safe.

So, for any typed alias adopted by this project from here on, a fifth layer is mandatory and eliminatory:

5. **Shell-framework alias shadowing.** Check the candidate against the alias tables of oh-my-zsh (all plugins, git plugin especially), bash-it, and prezto. A hit disqualifies the candidate outright, regardless of registry availability, because the collision is silent at the user's terminal and is not fixable by anything the project controls.

`gsp` is the concrete demonstration. It passes layers 1 through 4, and it is absent from all 197 oh-my-zsh `g*` aliases, so a sweep of the largest framework alone clears it. It is nonetheless disqualified: prezto binds it exactly.

## Decision, part 2: "Never" becomes a bounded pre-launch window

The Never clause's one sentence rests on three claims. Each was tested against measurement, and they do not all survive.

**"invisible contracts": no longer true.** The repository is already public. A contributor who opens it sees `scripts/cam/`, `/cam-plan`, and `CAM_SESSION`. These are not user-facing, but they are contributor-facing, and contributor-facing incoherence is precisely the problem the Gateship rename exists to solve. The clause was written when the rebrand was scoped display-only (ADR-0045); that premise no longer holds.

**"baked into running installs": true, but the install count is one.** There is exactly one install of this software in the world, the operator's, and zero external users. The cost of renaming an internal contract is therefore approximately zero today, and it rises monotonically from the moment the first stranger installs the binary. A policy of "never" assumes a cost that does not exist yet and will exist permanently afterwards. The correct reading is not that the clause is wrong, but that it is right at the wrong time: it is sound after launch and unsound before it.

**"deterministic git history": true, and decisive, for a strict subset.** 1,637 `CAM-nnn` references appear in commit subjects across 1,565 commits, 312 of 349 merged pull-request titles carry a `CAM-` id, 276 tags are published, and 486 unique issue ids are in circulation, against 13,573 total tracked occurrences repo-wide. Git history and merged PR titles cannot be rewritten. This argument fully sustains a permanent Never, but only for the identifiers that history is keyed on.

The revised policy therefore splits the layers by which argument actually applies to them:

**Renamed at launch packaging, before the first external install:**

- `CAM_*` environment variables
- `.cam-*` state files
- the `tmux -L cam` socket
- `/cam-*` slash commands
- sentinel strings (`CAM_*_STATUS`)
- the `scripts/cam/` state directory (never in the Never list to begin with)

**Never renamed, permanently:**

- the `CAM-` issue-id prefix
- `chore(cam):` and other historical commit trailers
- any reference already written into git history, a merged PR title, or a published tag

The `CAM-` prefix stays for the same reason a company that rebrands does not renumber its historical invoices: it is a record key, not a brand surface. It is also the only layer where the "deterministic git history" argument is load-bearing on its own.

**The window closes at the first external install.** After a stranger has the binary on their machine, the original Never clause resumes in full force for every layer, and this ADR stops authorizing anything.

### Migration mechanics, measured per layer

These are recorded so the plan is executable rather than aspirational, and because the difficulty is very unevenly distributed.

- **`CAM_*` environment variables.** Only **5 distinct names** are actually read from the environment (`CAM_RUN_DRY_RUN`, `CAM_ORCH_TOKEN_BUDGET`, `CAM_WORKER_MAX_TOKENS`, `CAM_WORKER_TIMEOUT_MS`, `CAM_VENDOR_CACHE_DIR`), across 3 source modules. The remaining `CAM_*` names are tmux pane variables, sentinels, or test-only. A dual-read shim (`GSHIP_X ?? CAM_X`) is five one-line edits; the fallback is removed after one full cycle with no old-form read observed.

- **Sentinel strings.** One parser file with two regex sites owns the parse. A dual-accept alternation of the form `(?:CAM|GSHIP)_IMPLEMENTER_STATUS=` is a single-token change. This layer is the dangerous one and must be two-phase: the parser accepts both forms first, and only in a later change do the agent prompts emit the new form. Doing both at once produces a silent hang, because a worker spawned with the old prompt writes a sentinel the new parser does not match, and nothing errors. This project has already shipped two bugs of exactly this class (CAM-32 and CAM-35), which is why the ordering is mandatory rather than advisory.

- **`.cam-*` state files.** 23 of roughly 40 distinct filenames are already reached through exported constants; 17 inline literals must be hoisted to constants first. A boot-time idempotent migration (if the old path exists and the new one does not, rename it) is then sufficient. Cold only: it cannot run against a live session.

- **`tmux -L cam` socket.** Cold only, by construction. The session must be stopped, the socket name changed, and the session restarted, because the running orchestrator is itself attached to that socket.

- **`scripts/cam/`.** No canonical constant exists anywhere in the codebase. There are 280 occurrences across 60 source files and 373 across 96 test files. This must be two separate changes: first introduce the constant and replace the literals with it, leaving the path value unchanged, which is behavior-preserving and fully covered by the existing suite; then change the constant's value and `git mv` the directory. Combining them means a failure cannot be attributed to either. One hazard is out of reach of a TypeScript refactor and must be handled explicitly: `src/vendor/_generated.ts` is a vendored agent-prompt blob holding its own copies of the literal path.

## Consequences

The installer creates `gateship` and `gship` at launch packaging, and stops creating `cam`. Documentation, help output, and usage strings move to `gship` for the invocation examples and `gateship` for the product name.

The internal-contract rename becomes a scheduled, bounded piece of launch packaging rather than a permanently forbidden one, and it is explicitly sequenced after the user-facing packaging work: publishing a working install path moves a stranger from unable to able, whereas the internal rename moves nobody into the product and only improves coherence for someone already reading the source. Doing the rename first would spend the cheapest remaining pre-launch window on the lower-value half.

ADR-0045, ADR-0049, and ADR-0050 are left untouched apart from a supersession pointer appended to ADR-0050 noting that its Never clause and its deferred alias decision are both resolved here. Their text is the record of how a clause travelled through three decisions accumulating no new reasoning, and that record is part of the value of this correction, not an error to edit away. The same treatment ADR-0050 gave ADR-0049 applies here.

The four-layer name gate of ADR-0050 is extended to five layers for typed aliases specifically. Product names continue to run layers 1 through 4; any short typed alias must additionally clear layer 5.

Contributors reading the codebase during the window will see a mix of old and new contract names while the two-phase sentinel migration and the dual-read env shim are in flight. That is expected and bounded: each shim is removed after one clean cycle.

This decision clears the three ADR admission gates. It is hard to reverse: once the alias is published to a registry and the internal contracts are renamed against live on-disk state, undoing either costs a second migration with real installs in the field, which is the precise cost the window exists to spend before it becomes real. It is surprising without context: a reader who knows only ADR-0045, ADR-0049, and ADR-0050 would find a permanent, thrice-restated Never clause and would not expect it to be revised, nor would a reader expect `gsp` to be rejected while it passes every layer of the gate those ADRs formalized. It reflects a genuine trade-off with real alternatives on the record: six alias candidates were screened and rejected with specific measured causes, and the Never clause was tested claim by claim rather than overturned wholesale, with one of its three claims sustained and carried forward permanently.
