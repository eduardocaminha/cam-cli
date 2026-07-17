# Context

## Language

**toolchain parity**:
The invariant that the bun and Node versions used by the containerized worker gates equal the versions used by CI and the pinned source of truth, so an in-loop gate result matches CI by construction.

**version-skip masking**:
A failure mode where a test is skipped based on the runtime toolchain version (e.g. skipIf(bun<1.3)), so a container running an older toolchain skips a test that CI runs, hiding a real failure from the in-loop gates while the host CI goes red.

**bun-version single source of truth**:
A single repo-root file (.bun-version, with .tool-versions for Node) pinning the exact toolchain versions that both CI (setup-bun bun-version-file) and the container Dockerfile (build-arg) read, so the two cannot diverge.

**container preflight fail-closed assert**:
A preflight check that refuses to dispatch a containerized worker when the running image toolchain does not equal the pinned source of truth, escalating instead of running blind.

**sidecar auto-rebuild**:
The sidecar behavior of rebuilding the worker container image on a preflight toolchain mismatch against the pinned source of truth, so toolchain updates roll out with no operator rebuild ceremony.

**re-plan round**:
One planner+auditor cycle triggered after an audit-blocked verdict, feeding the prior round's plan-verdict-report.json findings back into the planner's spawn prompt; capped at N=2 rounds.

**plan escalation**:
The terminal state when a PRD fails to converge (still audit-blocked) after N re-plan rounds; the orchestrator surfaces it to the operator via a durable marker and never auto-proceeds to branch or commit.

**findings feedback**:
Injecting the auditor's plan-verdict-report.json findings (description and suggestion per finding) into the next planner spawn's prompt so the planner corrects the flagged defects instead of regenerating the PRD blind.

**close (issue)**:
The deterministic on-main mutation that sets an issue to stage:shipped, modeling 'done/shipped'. Includes an issue subsumed by another issue that shipped. Orthogonal to abandon: close moves the stage axis, not the status axis.

**abandon (issue)**:
The deterministic on-main mutation that sets an issue to status:abandoned, modeling 'won't-do / dropped'. Orthogonal to close: abandon moves the status axis and leaves the stage untouched.

**Layer-1 CLI-exposure**:
A CAM-197-class change that wires an already-implemented on-main mutation to a deterministic CLI subcommand with zero LLM in the path. The behavior already exists; only the CLI surface is added.

**structured handback line**:
A machine-parseable stdout line a deterministic cam CLI emits (e.g. CAM_ISSUE_RESULT=<id> on success, CAM_ISSUE_RESULT=ERROR on failure) so the orchestrator reads the outcome from stdout instead of scraping the rendered pane.

**auto-ship**:
No modo de plan-approval auto, o sidecar despacha a fase de ship automaticamente quando o ciclo atinge um retorno terminal complete com veredicto de review CLEAN, sem acao do operador.

**phase signal**:
O campo phase no arquivo de estado do cam-loop (.claude/cam-loop.local.md), lido a cada tick do sidecar para selecionar a proxima acao do loop: implementing, shipping ou idle.

**fire-once marker**:
Um timestamp duravel gravado no prd.json (ex: autoShipDispatchedAt) que deduplica um despacho one-shot atraves de ticks e reinicios do sidecar, garantindo disparo unico end-to-end de um efeito externo nao idempotente.

**clobber chain**:
Sequencia deterministica de escritas ao mesmo arquivo de estado, no mesmo caminho de controle, onde uma escrita anterior e sobrescrita ou apagada por escritas posteriores; no cam, phase:shipping (escrito primeiro) e destruido pelo unlink do onProgress e depois pela reescrita idle do clearActive.

**meta_loop**:
cam project.toml [loop] key controlling inter-cycle behavior: off (no chaining), observe (emit would-dispatch events, no state mutation), auto (deterministic auto-dispatcher chains the next plannable backlog issue as a new autonomous cycle). Read via readMetaLoop, fail-closed to off.

**worker_isolation**:
cam project.toml [loop] key selecting where implementer/reviewer workers run: host (same machine as the operator) or container (isolated dev-container sandbox). Read via readWorkerIsolation, fail-closed to host. The auto-drain (meta_loop=auto) is gated to container-only (ADR 0007); in host mode the dispatcher is not armed (CAM-208).

**auto-drain**:
the inter-cycle unattended dispatcher (meta_loop=auto) that, at a safe idle boundary, selects the next plannable backlog issue and writes phase:planning to chain a new autonomous cycle. Container-gated by design (ADR 0007). worker_isolation=host is a permanent mismatch and does not arm it; worker_isolation=container with Docker preflight not yet ready is a transient state that refuses per-tick until ready.

**plan preflight**:
The deterministic gate the sidecar runs before dispatching a plan phase: git checkout main, git pull, prune merged cam branches (best-effort), a clean-tree check (strict git status --porcelain), typecheck, and bun test, halting on the first failing step. A failure reverts phase to idle and, per the durable surfacing marker pattern, writes .claude/.cam-plan-preflight-failed.json for the operator.

**durable surfacing marker**:
A runtime JSON file the sidecar writes on a silent terminal state (ship stalled, plan escalated, plan preflight failed) so a recycled orchestrator surfaces it at boot as an opening blocker. The pattern is a triad: a durable file, a boot read, and a best-effort pane notify. The file is the source of truth because the notify is a no-op when the orchestrator pane is gone.

**orchestrator self-handoff**:
The mechanism by which the long-lived cam orchestrator hands its accumulated context to a fresh copy of itself at a cycle boundary, instead of degrading as its context window fills. At cycle close the orchestrator writes a handoff file and arms a recycle marker via cam journal append --cycle-close; a recycle watcher terminates the stale session and the wrapper respawns a fresh orchestrator that rehydrates from the consumed handoff. A context-occupancy backstop (around 80 percent of the window) arms the same recycle autonomously as a secondary trigger. Plain cam journal append signals that a handoff is due but does not arm the recycle.

**plannable issue**:
An issue eligible to enter planning: its stage is specified, its status is open, and it is not blocked by an unshipped dependency. This is the single condition that qualifies an issue for /cam-plan.

**issue stage**:
The lifecycle-progress axis of an issue: idea, specified, planned, or shipped. It records how far the issue has advanced and is orthogonal to status.

**issue status**:
The disposition axis of an issue: open or abandoned. Orthogonal to stage. An abandoned issue keeps its last stage as history and is excluded from every active backlog view regardless of that stage.

**invariant**:
A durable, always-applicable project rule a worker must obey on every story (e.g. runtime choice, type-safety guards, quality gates). Invariants are curated and live in the auto-loaded agent instructions, reaching every worker with no extra read.

**pattern**:
A reusable codebase insight, library quirk, or gotcha recorded for future reference. Patterns are append-only reference material consulted on demand (grep by the subsystem a story touches), not loaded in full at story start.

**cam/issue-<N> branch**:
Nome de branch deterministico do cam, derivado em codigo a partir do numero do issue (prd.issueNumber), sem slug. Um unico nome por issue, no namespace cam/.

**issue type**:
Campo do issue (enum feat|fix|chore|docs, default feat) que classifica a mudanca. Deriva o prefixo conventional-commit do titulo da PR e o label do GitHub aplicado na criacao.

**type-to-label map**:
Mapeamento deterministico do issue type para o label do GitHub aplicado na PR: feat->enhancement, fix->bug, docs->documentation, chore->sem label. Usa apenas labels ja existentes no repo.

**issue_system=local**:
Valor canonico do issue_system para o issue system local (arquivos JSON em scripts/cam/issues/, CLI cam issue list, stages, WSJF, spec flow). Substitui o antigo none, que sugeria ausencia apesar de haver um tracker local completo.

**readIssueSystem**:
Central project.toml reader (src/config/issue-system.ts) that selects the issue backend (linear|github|local). Fail-loud on truly-unknown values, but treats the legacy none as the local alias rather than throwing.

**deprecated alias (issue_system)**:
A legacy config value (none) still accepted on read and normalized to the canonical value (local). Never offered as a selectable option nor written fresh by init, but existing project.toml files carrying it must keep working.

**ci-container**:
A CI job on ubuntu-latest that validates the cam-worker container (builds the image and runs the test suite in-container via test-in-container.ts). Distinct from the macos-latest 'ci' job, which is blind to the container. Exposed as its own required status check so Renovate automerge of container-scoped bumps waits on real container validation.

**neutral-pass required check**:
A required status check whose job always runs (so its context always reports and branch protection stays satisfiable) but early-exits success when its heavy work is irrelevant to the change. Used to make a path-scoped check (e.g. ci-container, which only matters when container paths change) safe as a branch-protection required check, avoiding the GitHub trap where a skipped required check blocks the PR forever.

**container-scoped managers**:
The Renovate managers whose bumps change only the container image and are not exercised by the macOS CI: 'dockerfile' (.devcontainer base image) and 'asdf' (.tool-versions nodejs). Contrast with CI-exercised managers (bun-version, github-actions) whose bumps the macOS 'ci' job actually validates.

**file-size ratchet**:
The check:file-size gate (scripts/check-file-sizes.ts, part of the check:all spine) that fails when a budgeted source file exceeds its per-file line-count ceiling recorded in scripts/file-size-budget.json.

**ceiling raise**:
Bumping a file's line-count ceiling in scripts/file-size-budget.json; the raise is only accepted if the staged diff also carries a tracker-ref (CAM-NNN, #N, or a URL) in the top-level _ref key.

**_ref tracker-ref**:
The top-level prose key in scripts/file-size-budget.json that must contain an issue/PR reference for any staged ceiling raise; checkDiffTrackerRef reads only the staged diff, so it must be committed alongside the raise.

**sibling ratchets**:
The four quality gates inside check:all that share the file-size gate's late-catch shape: coverage (check-coverage.ts), debt-markers (check-debt-markers.ts), dead-code (knip), and dup (jscpd).

**late-catch gap**:
The window in which a legitimate change trips a quality gate only at ship/CI (Layer B) rather than during the implementer's story run, because the worker runs only typecheck+test (plus the file-size gate) and not the full check:all spine.

**reviewer backstop**:
The reviewer's duty to judge whether a gate loosening (a raised ceiling, lowered floor, added ignore/exclude, or bumped threshold) reflects legitimate change or masks a defect that should have been fixed instead: REQUEST CHANGES when the loosening is unjustified.

**in-story gate run**:
Running a quality gate during the implementer's single-story iteration (self-correction, Layer A) so failures surface and are resolved inline in the same commit, rather than deferring the whole check:all spine to ship/CI.

**derivedFrom**:
Structured issue-schema field (string[] of issue ids) recording which issue(s) an issue was derived from. Populated on manually-linked follow-ups and, per CAM-263, on auto-filed SUGGESTION follow-ups pointing back to the parent issue whose review produced the suggestion.

**wedge (absorbing wedge state)**:
A cam autonomous cycle stuck in a state with no self-recovery path: an in-flight PRD (stories still passes:false) sitting under phase:idle, where nothing re-arms and only an operator cam next recovers it. Named for the 2026-07-06 CAM-118 incident.

**parked**:
The deliberate at-rest state of the cam loop, signalled by phase:idle in cam-loop.local.md. Set by cam stop or by clearActive at end-of-cycle. A parked cycle is never auto-resumed by the sidecar; it is the discriminator that distinguishes an intentional pause from a wedge.

**in-flight PRD**:
A prd.json with at least one non-operator user story whose passes flag is still false: the cycle has started but not completed. Distinct from a completed PRD (all non-operator stories pass) and from no-PRD (backlog-only) state.

**drain preconditions**:
The set of gating conditions the sidecar checks before dispatching or re-arming a cycle: no blocked terminal marker, no pending merge-watch, and no plan/ship phase already in progress. Shared by both the meta-loop dispatch path and the in-flight re-arm path.

**re-arm**:
The sidecar action of flipping an in-flight-but-idle cycle back to active:true implementing, at boot or on an idle-tick, using cam next semantics. Triggered by an in-flight PRD with phase==implementing and an inactive loop; suppressed when parked (phase:idle).

**circuit-breaker (implement)**:
A harness safety mechanism that halts the sidecar auto-dispatch chain after N consecutive identical terminal-blocked outcomes on the same story, so a deterministic contradiction does not burn unbounded fresh implementer sessions. Mirrors the plan-escalation halt: stop re-dispatching, flag a durable marker, surface it read-only at orchestrator boot, and recover when the underlying PRD changes.

**blocked-outcome dedup key**:
The identity a blocked terminal is compared against to decide 'same problem again': the tuple (storyId, specific BLOCKED_* token, sha256 of prd.json). A match increments the consecutive counter; any difference (PRD amended, different story, different token) resets it.

**PRD content hash**:
A sha256 digest of prd.json used as the amendment-detection component of the blocked-outcome dedup key. A real operator/planner PRD amendment changes the hash and therefore resets the circuit-breaker counter; hashing the whole PRD (not just the touched story) is the conservative direction, resetting on unrelated edits rather than ever holding a stale count.

**consecutive identical blocked outcome**:
A blocked terminal whose dedup key matches the immediately preceding blocked terminal's key. The count of these, persisted across fresh implementer sessions in the .cam-implement-blocked.json marker, is what the circuit breaker thresholds on (N=3).

**post-merge-stalled**:
A cam cycle whose PR squash-merged to origin/main but whose post-merge sequence (pull, tag, prune, close) did not complete, leaving the merge real but the cycle half-done. Recorded durably in .cam-post-merge-stalled.json with the completed and remaining steps, and surfaced at orchestrator boot. Distinct from ship-stalled (PR not merged).

**subsumed commit**:
A local unpushed commit on main whose content was recreated at a new SHA by a squash-merge into origin/main. Its patch is already present in origin/main, so git pull --rebase drops it via patch-id without loss. Contrast with genuine un-squashed local work, which a rebase replays or conflicts on rather than dropping.

**local-main divergence**:
The state where local main and origin/main share history but each has commits the other lacks (local has the unpushed commit, origin has the squash). A plain git pull refuses or merges awkwardly; the codebase detects only bare SHA-inequality (checkMainUpToDate), not subsumption.

**post-merge sequence**:
The ordered git steps runPostMerge performs after a PR merges: checkout main, pull origin main, read version, tag and push, prune local and remote branch, close the issue. A failure at the pull step currently aborts the rest; recovery must either continue these steps or record which remain.

**wake-up push**:
The one-line send-keys message the sidecar pushes to the orchestrator pane to signal that a report is ready. Per CAM-75/77/78 it carries no durable content: it is only a signal to wake the orchestrator, which then reads the durable truth from files (worker-report.json, cam-worker-events.jsonl) and markers. If the wake-up is lost, the truth is not.

**delivery verification**:
Confirming a send-keys push actually submitted, rather than fire-and-forget. Done by idle-gating before the send and checking the composer emptied after it, with bounded-backoff retry on failure. It is a pane-state check, never a parse of rendered scrollback content.

**composer-emptied state check**:
The post-send verification that the pushed line left the orchestrator TUI composer (composer is empty), proving the trailing Enter submitted. The sanctioned verification signal, distinct from and never conflated with parsing the rendered pane for the message content (the lossy capture-pane trap).

**push-undelivered**:
A flight-recorder event emitted when a verified send-keys push exhausts its retries without confirming submission. It records a lost wake-up for observability; it does not itself carry recovery state, because terminals that matter already write durable markers the orchestrator surfaces at its next boot.

**sidecar-liveness watcher**:
A long-lived process spawned by cam run alongside orch-recycle-watch that polls sidecar liveness (via .cam-sidecar.pid and the sidecarAlive() composite) and, on a dead sidecar, attempts a bounded respawn before surfacing a durable marker. The counterpart to orch-recycle-watch, which watches only the orchestrator.

**sidecar-stalled marker**:
The durable .cam-sidecar-stalled.json file written when the sidecar dies in a way the orchestrator must learn about (a firewall-init failure or a watcher-exhausted respawn). Carries a structured reason; surfaced read-only at orchestrator boot and removed on the next healthy sidecar bring-up. One file, two producers.

**port-53 collision**:
The container-mode wedge where a stale cam-worker container from a prior session still holds dnsmasq on port 53, so the next session's firewall init fails to bind ('Address already in use') and the sidecar aborts. Rooted in the container being left running at session exit and reused on the next boot.

**firewall-init failure**:
A non-zero exit of the container firewall init (docker exec cam-worker init-firewall.sh, dnsmasq --port=53), which under set -euo pipefail aborts the sidecar boot before the loop starts, so no worker is dispatched. Container-mode only; a no-op in host mode.

**issue identity resolution**:
Mapping an issue number/id to its canonical record and branch name via the configured issue_system (local -> scripts/cam/issues/CAM-NNNN.json; github -> gh). A deterministic-code responsibility performed once upstream, not re-derived by any LLM agent.

**prior-art signal**:
An auditor observation that a PRD may duplicate or contradict already-shipped work. Sourced from git history (commits + merged PRs), backend-agnostic, and emitted as a non-blocking WARNING/SUGGESTION, never a critical BLOCK.

**context backstop**:
The orchestrator-side recycle trigger that fires when the session's token occupancy crosses a fraction (0.80) of the configured context window, forcing a handoff + respawn before a hard context overflow. Distinct from the cycle-close trigger, which fires when a PR/cycle is resolved.

**orch_context_window**:
A [loop] project.toml integer key giving the orchestrator's real usable context window in tokens. Default 200000 (the Claude Code flat-subscription reality); set to 1000000 only when running against API credit that unlocks the 1M window.

**handoff-before-arm guard**:
The invariant that the recycle marker is never armed (and SIGTERM never issued) unless a handoff file exists on disk. Shared by both recycle triggers; mirrors the cycle-close exit-3 guard in index.ts.

**deterministic minimal handoff**:
A machine-written handoff (schemaVersion 1, reason 'context-backstop') the watcher writes when the agent does not produce an authored handoff within 30s of the backstop signal. Carries only pointers to durable state (prd.json, branch, loop file, journal tail), enough for the fresh session to rehydrate.

**authored handoff**:
A handoff written by the orchestrator agent itself (rich narrative context), as opposed to the deterministic minimal handoff written by the watcher as a fallback.

**--help short-circuit guard**:
A single check at the dispatch/arg-parse layer that, when --help or -h is present, prints the command's usage and exits 0 before any command body (including daemon starts or state mutations) executes.

**internal command**:
A cam subcommand not meant as a user-facing entry point (e.g. sidecar), invoked by the harness rather than typed by the operator. Listed under an Internal section in cam --help for discoverability, not hidden.

**file-local filer**:
cam issue --file-local: the deterministic commit-to-main issue filer the orchestrator uses to record backlog without touching the working branch.

**worktree-coherent-with-HEAD invariant**:
After any on-main commit-tree writer returns, the working tree matches HEAD: no staged additions, no deletion-staged files. Established by CAM-137 for MODIFY; extended to CREATE by CAM-140.

**deletion-staged**:
A git index state where HEAD contains a file but the index and worktree do not, so git status shows 'D <path>'. The CREATE-on-main bug left newly-committed issue files in this state.

**CREATE route**:
The createLocalIssueOnMain path that commits a brand-new issue file on main (vs the MODIFY route that edits an existing one). Only CREATE was missing worktree materialization.

**demote**:
cam issue --demote <id>: a deterministic on-main stage move from specified back to idea, so a defective spec can be re-specified through the normal /cam-spec interview. Only specified->idea is allowed.

**re-spec**:
Re-running the /cam-spec interview on an issue whose spec is defective. Reached by demoting the issue to idea first; there is no in-place overwrite of a specified spec.

**defective spec**:
A stage:specified spec that is internally contradictory or that a planner keeps mis-implementing, such that the cycle cannot converge without rebuilding the spec.

**plannable set**:
The issues selectPlannableIssue will pick for /cam-plan (stage:specified, open). Demoting to idea removes an issue from this set until it is re-specified.

**boot-surfaced marker**:
A durable .claude/.cam-*.json file (ship-stalled, plan-escalated, plan-preflight-failed, implement-blocked, post-merge-stalled, sidecar-stalled) that a deterministic recovery/terminal path writes to record a non-happy outcome. The orchestrator reads it at boot and surfaces it as an opening blocker line (read-only); it never deletes the marker itself. Each marker is cleared only by its own specific deterministic path (e.g. implement-blocked by the next re-armed implement dispatch for the same issue; plan-preflight-failed by the next non-preflight-failed plan run; plan-escalated by the next converging plan run).

**suggestions pen**:
An append-only, on-main-committed scripts/cam/suggestions.jsonl file where reviewer SUGGESTION findings accumulate (one JSONL line each, deduped by the suggestion-fingerprint) instead of being auto-filed as stage:idea issues. It is triaged in batch via the cam suggestions CLI (list/promote/dismiss); a suggestion becomes a real issue only when explicitly promoted.

**model tier alias**:
A stable model selector (opus, sonnet, haiku, default, fable, opusplan, sonnet[1m], opus[1m]) that the Claude Code CLI resolves at spawn to the current latest model of that tier for the logged-in subscription. cam stores an alias in project.toml [models] and forwards it as --model, so it auto-tracks new model launches without hardcoding dated model ids. Trade-off: an alias is always-latest (not reproducible); a dated snapshot id pins a specific model.

**actor-ACL**:
An authority check keyed on which actor (worker vs deterministic supervisor vs operator) may mutate a field. In cam it governs story passes:true: only the supervisor (post-gate) or the operator may set it, never the worker.

**empty-push**:
A branch push (or origin-already-at-HEAD state) that carries zero commits ahead of main. branchPushed/pushed being true does not prove work landed; only ahead_by>=1 does.

**ahead_by**:
The count of commits the work branch is ahead of main, computed via git rev-list --count origin/main..HEAD. Used as the empty-push gate: a worker pass with ahead_by==0 is degraded to blocked.

**contract test**:
A single test that pins the supervisor<->worker protocol shape (send-keys submit form, worker-report.json shape, CAM_*_STATUS sentinel, @cam_label lifecycle) using an in-memory fake worker plus real supervisor logic, catching protocol drift in CI.

**passes ownership**:
Which actor writes story passes:true in prd.json. Under CAM-63 (variant A-i) ownership moves entirely to the deterministic supervisor after its own gate run; the worker only signals done via worker-report.json.

**operator-story exemption**:
Stories tagged requires:'operator' are ceremonies out of scope for autonomous implementation; they are exempt from commit-existence and empty-push gates and do not block the review cycle. The planner no longer emits them (US-003); they are hand-filed only.

**control-plane state**:
The cam-owned coordination artifacts that drive the loop and issue tracker: scripts/cam/prd.json and the scripts/cam/issues/ directory. Mutated only by the orchestrator/supervisor (the orchestrator files issues on main via `cam issue`; the supervisor and planner own prd.json), never by an implementer worker on a feature branch.

**worker-actor marker**:
The CAM_WORKER=1 environment variable set only on the implementer worker spawn path (worker-argv.ts for host, worker-container.ts for container), deliberately outside the shared workerEnvPrefix so the reviewer and planner do not inherit it. It is the signal the orch-agent-allowlist hook uses (together with CAM_SESSION) to scope the Write-deny to the implementer actor alone.

**hand-file oracle**:
An acceptance criterion that verifies a required issue was hand-filed on main (e.g. `git show main:scripts/cam/issues/CAM-XXXX.json`), expressed as a file-assert oracle the reviewer's behavioral gate re-runs. It replaces the anti-pattern of asking an implementer worker to satisfy a hand-file requirement by writing the issue file on its feature branch.

**doc-as-code gate**:
A CI gate that treats the factual claims embedded in the repo's own documentation (cited command names, package.json script names, and file paths) as machine-checkable assertions against the live repository, failing when a cited reference no longer resolves. In cam it is scripts/validate-agents-md.ts, wired as a gate in the check:all manifest.

**known-missing allowlist**:
A structured inline set of { pattern, reason } entries (glob-capable) enumerating doc-cited paths that legitimately do NOT exist in a clean working tree because they are created only at runtime (e.g. .claude/.cam-orch-ready, scripts/cam/prd.json, worker-report.json, .cam-*.json markers). Entries are exempt from the doc-as-code gate; a required reason keeps the list auditable, and the gate warns on entries that matched nothing.

**count-freeze**:
A test that asserts the exact cardinality (and, where relevant, exact membership) of a load-bearing registry so that a silent shrinkage or addition fails a test rather than passing green. In cam, GATES.length and the COMMANDS array membership are count-frozen.

**wire boundary**:
A seam where cam drives or parses the output of a real external tool (git, tmux, gh, or the filesystem). Code at a wire boundary must have at least one real-I/O integration test exercising the real dependency, because a fake can encode the output the buggy code expects and pass while the real tool behaves differently (the CAM-55 fakes-lie lesson).

**behavioral DI-fake**:
A dependency-injected fake that reproduces a real dependency's observable behavior (e.g. a fake spawn returning realistic git output keyed on argv) so the test asserts the code's real output. It is the blessed cam testing pattern and is explicitly distinct from, and permitted unlike, a tautological mock-call assertion that only checks 'the mock was called' (which is documentation, not verification).

**absence oracle**:
An acceptance-criterion oracle that asserts the ABSENCE of a pattern rather than its presence. The correct, cross-platform (GNU and BSD/macOS) form is shell negation of a quiet match, `! grep -q PATTERN file`. The self-nullifying anti-pattern `grep -q` combined with `-L`/`-l` is broken: the quiet flag suppresses the list-files inversion so the exit status mirrors a plain match, producing a false gate result.

**operator-decision gate**:
A deterministic pause point where the sidecar cannot auto-decide and must wait for a human choice. Represented as the durable file .claude/.cam-gate.json = { gate, options[], context, decision? } together with phase:awaiting-operator as the coarse loop state, and answered via `cam decide <decision>`. The shape is generic across the plan, ship, and drainer phases (gate discriminator + options[] + context).

**cam decide**:
The CLI thin-proxy that answers an active operator-decision gate: it validates the given decision against the active gate's options[] and writes it into the gate file for the sidecar to consume, then resume. Distinct from `cam resume`, which is interrupt-recovery (resetting a wedged story/PRD/branch).

**phase effort**:
The reasoning-effort level (one of low, medium, high, xhigh, max) configured per LLM phase, stored as the effort: frontmatter line in .claude/agents/subagent-<phase>.md and consumed directly by the Claude Code CLI at spawn time. Distinct from the phase model. The ship phase has none (deterministic, zero-LLM per ADR-0009).

**plan-time split advisory**:
A non-gating recommendation emitted by the plan runner after PRD generation when an issue's projected token spend (the historical mean of same-jobSize issues) exceeds a fixed multiple (~1.5x) of that jobSize bucket's median, signalling the issue may be oversized and worth splitting into multiple PRs. Advisory only: it never blocks or fails the plan/loop.

**split advisory**:
Plan-time non-gating heuristic (src/stats/split-advisory.ts) that projects per-jobSize-bucket token spend and advises slicing a PRD when the projection exceeds 1.5x the bucket median.

**jobSize bucket**:
The set of historical per-issue token totals grouped by exact wsjf.jobSize match with the issue being planned.

**orchTokens (cumulative)**:
Orchestrator session token spend: monotonic across a session and re-snapshotted into every cycle-tokens event, hence NOT summable across cycles of the same session.

**cycle-tokens event**:
An event-log record in .claude/cam-worker-events.jsonl capturing a cycle's token usage as orchTokens + workerTokens.

**orchTokensMode marker**:
Per-event flag on cycle-tokens events distinguishing delta-mode (new, per-cycle delta) from legacy cumulative orchTokens; absent marker means legacy cumulative.

**scope-proposal artifact**:
A fixed-shape deterministic summary emitted at plan completion (problem, in-scope stories, explicit out-of-scope, MVP-vs-launch-ready framing) that the orchestrator narrates to the operator.

**docs-fetch channel table**:
The lib->official-docs-channel mapping the planner consults, capturing {lib,url,version,fetchedAt,summary,status} with one targeted fetch per lib.

**anti-over-fetch guard**:
The planner rule capping documentation fetches to one per lib to prevent redundant retrieval and context bloat.

**setup-checklist (ship)**:
The ship-time table (| # | Item | Where | How | Status |) of manual setup steps a change requires, added to the PR body by composePrBody.

**file-based operator gate**:
cam's shipped operator-decision primitive (cam-gate.schema.json + the cam decide return channel, ADR-0041), used instead of the AskUserQuestion tool.

**reporter port**:
A feature ported from the sibling reporter project's .claude/commands/ralph-*.md blueprints into cam's deterministic artifact layer.

**typed pattern record**:
A schema-validated record replacing a free-text patterns.md bullet, with fields {type, classification tier, recorded_at, evidence, dir_anchors, outcomes[]}, validated by a hand-rolled TS typeof guard (ADR-0038).

**classification tier**:
A pattern record's confidence/authority level in the mulch model, distinct from its accumulated outcome history.

**dir_anchors**:
The directories/paths a pattern record is scoped to, letting grep-on-demand filter records by the subsystem a story touches.

**outcome-status / confirmation-scoring**:
The success|failure|partial result appended to a record's outcomes[] each time the pattern is applied, accumulating a confirmation score used by the decay gate.

**decay/demotion gate**:
cam patterns prune -- a subcommand that demotes or decays pattern records whose confirmation score falls below a threshold.

**mulch model**:
The external mulch project's typed expertise-record + scoring + decay design (record.ts / scoring.ts / prune.ts) that CAM-64 ports into cam.

**on-main ref-only writer**:
The commitTreeToMain + dedup write path (src/git/on-main.ts) that commits directly to main without touching the working tree; multi-writer safe while a cam run session is live.

**CAM Runtime**:
The product's display name (formerly cam-cli): a local software-delivery runtime for coding agents that turns issues and goals into verifiable planning, implementation, review, and ship workflows, keeping state, coordinating specialized agents, and recovering interrupted runs. The invoked command stays cam.

**wordmark**:
The hand-authored uppercase CAM ASCII block logo rendered on the splash screen (src/ui/Splash.tsx), distinct from the tagline text line.
