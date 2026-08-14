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
An issue eligible to enter planning: its stage is specified, its status is open, it carries a non-empty set of acceptance criteria, and it is not blocked by an unshipped dependency.

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
The issues selectPlannableIssue will pick for /cam-plan (stage:specified, open, carrying acceptance criteria, not blocked). Demoting to idea removes an issue from this set until it is re-specified.

**boot-surfaced marker**:
A durable .claude/.cam-*.json file (ship-stalled, plan-escalated, plan-preflight-failed, implement-blocked, post-merge-stalled, sidecar-stalled) that a deterministic recovery/terminal path writes to record a non-happy outcome. The orchestrator reads it at boot and surfaces it as an opening blocker line (read-only); it never deletes the marker itself. Each marker is cleared only by its own specific deterministic path (e.g. implement-blocked by the next re-armed implement dispatch for the same issue; plan-preflight-failed by the next non-preflight-failed plan run; plan-escalated by the next converging plan run).

**suggestions pen**:
An append-only, on-main-committed scripts/cam/suggestions.jsonl file where reviewer SUGGESTION findings accumulate (one JSONL line each, deduped by the suggestion-fingerprint) instead of being auto-filed as stage:idea issues. It is triaged in batch via the cam suggestions CLI (list/promote/dismiss); a suggestion becomes a real issue only when explicitly promoted.

**model tier alias**:
A stable model selector (default, best, fable, opus, sonnet, haiku, opusplan, sonnet[1m], opus[1m], opusplan[1m]) that the Claude Code CLI resolves at spawn to the current latest model of that tier for the logged-in subscription. cam stores an alias in project.toml [models] and forwards it as --model, so it auto-tracks new model launches without hardcoding dated model ids. Trade-off: an alias is always-latest (not reproducible); a dated snapshot id pins a specific model. The canonical, doc-verified list of all ten values lives in src/config/claude-models.ts's CLAUDE_MODEL_ALIASES.

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

**Gateship**:
The product's display name: a local software delivery runtime, a control plane for coding agents that sits between an issue (or a PRD generated from one) and a merged, verified pull request, owning the outer loop a human would otherwise run by hand (plan, implement, review, ship), keeping state, coordinating specialized agents, and recovering interrupted runs. The invoked command stays cam.

**wordmark**:
The hand-authored uppercase CAM ASCII block logo rendered on the splash screen (src/ui/Splash.tsx), distinct from the tagline text line.

**LLM backend**:
The claude-vs-codex choice made per worker phase (src/config/models.ts), distinct from the issue_system backend (local/github/linear).

**per-subagent backend wiring**:
The config that assigns each worker phase (implementer/planner/auditor/reviewer) its own LLM backend (claude|codex), mixable in a single run, mirroring the per-phase model config.

**BackendAdapter**:
The per-actor abstraction seam fronting spawn argv, completion detection, session/transcript model, agent-prompt injection, permission/sandbox+env, and model-id namespace for a given LLM backend.

**design spike (CAM-54)**:
The issue's mandated first deliverable: a design ADR resolving the claude/codex mismatches before any codex dispatch code is written.

**report/sentinel contract**:
The backend-agnostic completion+result boundary (CAM_*_STATUS lines, <review> tags, worker-report.json/review-report.json) parsed by report-parse.ts (ADR-0038); the enabler of mixed-backend runs.

**Fir Green**:
#10C66F -- Gateship brand PRIMARY ACCENT: subscribe button, links, nav, highlights, and the splash accent (CAM-329).

**Forest Green**:
#003333 -- deep green for text placed over green surfaces (e.g. calendar days).

**Aero Green**:
#CAFFE3 -- light green for the welcome-page background and light highlights.

**brand neutrals (Gateship)**:
#1F1F1F ink (dark text/backgrounds, tiles, dark cards, banner), #6F6F6F secondary text, #9C9C9C secondary over dark, #EDECF0 surface (light cards), #E3E3E5 line (borders/dividers), #FFFFFF base white.

**subagent colors**:
Blue Lotus #426DFF, Lemon #AFE220, Sun Yellow #FFDF24, Salmon #FF6666 -- used ONLY to mark agents in figures; explicitly NOT part of the site or TUI chrome.

**external README**:
The public-launch, English, ultra-professional README for Gateship (with vendored cam-dss visual assets), distinct from the internal-contributor documentation. Build owned by CAM-331; informed by the CAM-330 readiness analysis and the CAM-332 brand palette.

**launch-readiness report**:
The written audit (e.g. docs/launch-readiness.md) of Gateship's fitness for public release across distribution/install, onboarding, external docs, security/secrets, license/repo-visibility, telemetry/privacy, versioning/release/update, support channels, and a prioritized gap triage.

**public v1 go/no-go**:
The explicit release recommendation the readiness analysis (CAM-330) produces, naming the must-fix blocking set for a public v1.

**self-invoke primitive**:
The single canonical function (resolveSelfInvokeArgv) that computes the argv prefix for a cam process to re-invoke its own entrypoint, correct in both interpreted (bun + script path) and compiled (standalone binary) modes.

**bunfs virtual entry**:
The /$bunfs/root/<outfile> path that bun injects as process.argv[1] inside a bun build --compile binary. Its presence is the positive signal that the process is running as a compiled binary; subcommand dispatch therefore reads argv[2] in both modes.

**dispatch-failed marker**:
The durable .cam-dispatch-failed.json file (CAM-433) written when a verified planner/implementer/reviewer dispatch fails at any checked step (pane_pid read, @cam_label set, respawn-pane, pipe-pane) or when respawn-pane's exit-0 does not correspond to a real process replacement. Carries phase, paneId, uuid, exitCode, stderr, reason, and timestamp; projected read-only into `cam status`, and cleared only by the next dispatch that converges (pane_pid changes and pipe-pane exits zero), never by a boot read.

**verified dispatch**:
The shared tmux dispatch primitive (runVerifiedDispatch, CAM-433) used by every implementer/reviewer/planner/auditor respawn: relabel the pane's @cam_label, respawn-pane -k, then prove the process actually changed via pane_pid identity verification before piping output. Replaces a bare respawn-pane exit-code check, which a lying zero exit cannot be trusted against on its own.

**pane_pid identity verification**:
Reading a tmux pane's #{pane_pid} before and after a respawn-pane call and requiring the two to differ. A respawn-pane exit code of 0 alone is not proof the pane's process was replaced; an unchanged pane_pid after a nominally successful respawn is itself a dispatch failure (reason pane-pid-unchanged).

**plannable gate**:
The predicate that decides whether a backlog issue may be handed to the planner. An issue passes the gate only when it is open, at stage specified, not blocked by an unshipped dependency, and carrying oracle forms.

**oracle form**:
The literal shell check text that sits under an acceptance criterion, as opposed to the prose claim the criterion asserts. A criterion delivers a form when the check can be copied and run verbatim; it delivers only a claim when it states what must be true and leaves the check to be invented downstream.

**oracle species**:
The classification of an oracle as either change-detection or invariance pin. A change-detection oracle must be red against the pre-change tree, because the condition it detects does not exist there yet. An invariance pin is green by construction and derives its comparand from the tree at check time rather than freezing a literal.

**specSource**:
The provenance of an issue's specification: interview when produced by an operator interview, derived when synthesized from one or more parent issues, operator when asserted directly by the operator.

**lint-origin BLOCK**:
A plan-round rejection synthesized by the deterministic oracle lint (runOracleLintCheck) from the prd.json the planner just wrote, before the auditor is spawned. It is returned with result kind audit-blocked, which is why it is indistinguishable from an auditor-origin BLOCK unless an explicit origin discriminator is carried.

**auditor-origin BLOCK**:
A plan-round rejection produced by the auditor subagent after it has actually run and returned a BLOCK verdict. Distinct from a lint-origin BLOCK in cause and in what a correction round can achieve, even though both share the audit-blocked result kind.

**auditor correction budget**:
The number of re-plan rounds reserved for correcting findings the auditor actually produced. Its purpose is to guarantee that auditor findings receive at least one correction attempt before the plan escalates.

**oracle-lint budget**:
The independently bounded number of re-plan rounds allowed for a planner that keeps emitting a PRD with provably broken oracles. Bounded separately from the auditor correction budget so that a persistently broken oracle cannot spin the planner indefinitely.

**post-auditor correction round**:
A re-plan round that follows an auditor-origin BLOCK and exists to address the auditor's findings. The structural guarantee at issue in CAM-448 is that every PRD reaching the auditor receives at least one of these before escalating.

**cycle-metrics row**:
One line of the versioned cycle-metrics artifact, derived by code from the event log, describing exactly one attributed cycle. Its purpose is recomputation by a third party, so it is text, diffable, and never a binary format.

**attributed cycle slice**:
The run of events from the one immediately after the previous cycle-tokens marker through the current marker. Bounded on both ends: the left bound is what makes the resulting row honest, and a slice whose left bound cannot be established is not a cycle.

**unattributed leading span**:
The events preceding the first cycle-tokens marker in a log. They belong to no attributable cycle, because nothing in the log establishes where one ends and the next begins. Disclosed as an explicit count in the artifact header rather than folded into the first row or dropped in silence.

**cycleId**:
The opaque cycle key carried by cycle-tokens events. Free-form in practice: branch names, drain markers, bare issue ids, and session ids all occur. Treated as an identity only, never parsed for a date or an issue number, and never sorted as if it encoded order.

**derived cache**:
The only sanctioned role for a database in this system: a store rebuilt from the append-only event log, never the source of truth. The log stays canonical because it is multi-writer-safe by construction and because git can diff it.

**instalacao aditiva**:
Instalacao que acrescenta os binarios novos (gateship, gship) sem remover o binario antigo (cam). Necessaria enquanto o loop ainda se auto-spawna pelo nome antigo, porque uma instalacao destrutiva feita durante um ciclo tira do proprio loop a capacidade de respawnar sidecar, watcher e dashboard.

**janela de rename**:
Periodo delimitado, aberto pelo ADR-0054, durante o qual os cinco contratos internos (CAM_*, .cam-*, socket tmux -L cam, comandos /cam-*, sentinelas) e o diretorio scripts/cam/ podem ser renomeados. Abre no estagio de launch packaging e fecha na primeira instalacao externa, quando a clausula Never original volta a valer integralmente.

**prerelease de lancamento**:
Primeiro GitHub Release publicado, marcado prerelease. Entrega um caminho de instalacao real e verificavel sem consumar a primeira instalacao externa que fecharia a janela de rename.

**auto-spawn por execPath**:
Padrao em que o processo invoca uma subcomando de si mesmo por process.execPath mais process.argv[1], em vez do nome do binario resolvido via PATH. Torna o auto-spawn imune a rename do binario e a divergencia entre o binario instalado e o codigo da branch.

**fidelidade de evidencia**:
Especie de oraculo para entregavel em prosa. Um grep de presenca de token confirma que uma palavra existe e nada sobre a veracidade da afirmacao ao redor. Um oraculo de fidelidade e aquele que fica vermelho quando a afirmacao verdadeira e trocada por prosa inventada plausivel, e por isso e varrido contra uma copia fabricada antes de ser aceito.

**oraculo vacuo por parse**:
Criterio de aceitacao cujo marcador de oraculo nao e reconhecido pelo parser (kind malformed), tipicamente por colchete desbalanceado dentro do regex. O criterio some da verificacao sem erro visivel: o lint o pula e o gate comportamental nao o executa. E pior que um oraculo errado, porque um oraculo errado ao menos falha; este nunca roda e por isso nunca contradiz nada.

**suite execution**:
One full run of the project test suite (about 5936 tests). The unit of cost that check:all was paying three times per invocation, and CI a fourth time via the container lane.

**shared suite output**:
The combined stdout and stderr text of a single `bun test --coverage` run, captured once and passed to more than one gate. It carries both the coverage table row (`All files | % Funcs | % Lines`) and the summary lines (` N pass`, ` N skip`, `Ran N tests across M files.`), so one capture satisfies both the coverage parser and the skip-ratchet parsers. Measured 2026-08-03: all of it arrives on stderr.

**gate identity**:
The property that each gate in check:all keeps its own name, its own row in gate-results.json, and its own independent failure condition, regardless of how its work is executed. Sharing an execution between gates must not merge their verdicts.

**fail-closed**:
A gate that reports failure when its evidence is missing, empty, or unparseable, rather than passing by default. In skip-ratchet this property comes from the positive-evidence tally guard, not from the skip parser, which returns 0 when the line is absent and would otherwise pass on empty input.

**recurring per-cycle tax**:
The admission criterion for internal work, canonized 2026-08-03 in memory/project_target_admission.md. An internal item earns a cycle only when its cost recurs every cycle until fixed. Redundant suite execution qualifies because both the worker (per story) and the reviewer (per round) pay it.

**SHA256SUMS.txt**:
Arquivo publicado como asset de um GitHub Release do Gateship, com uma linha SHA-256 por artefato de release, no formato que shasum -a 256 -c e sha256sum -c consomem. Os hashes sao tirados do artefato final em disco, depois da assinatura ad-hoc dos alvos darwin, de modo que correspondem byte a byte ao que o usuario baixa. E o insumo da verificacao automatica do install.sh.

**build provenance attestation**:
Atestado assinado, ancorado em sigstore e emitido pelo proprio GitHub Actions, que amarra criptograficamente um artefato ao workflow, ao commit e ao repositorio que o produziram. Verificado sob demanda com gh attestation verify. No Gateship e a unica camada que responde autenticidade de origem; nao entra no caminho automatico de instalacao porque exige o gh CLI, que o produto declara opcional.

**verificacao fail-closed**:
Postura em que a ausencia de meio de verificacao aborta a operacao em vez de prosseguir sem verificar. No install.sh do Gateship cobre tres condicoes: hash divergente, arquivo de checksums inalcancavel e ausencia de qualquer ferramenta de hash no PATH. O oposto, fail-open, e o modo de falha que a verificacao existe para proibir, porque produz instalacao aparentemente verificada sem verificacao nenhuma.

**checksum de mesma origem**:
Checksum servido pelo mesmo host, pelo mesmo canal TLS e sob o mesmo controle de escrita que o artefato que ele descreve. Compra integridade contra corrupcao de transporte e contra adulteracao parcial do Release, e nao compra autenticidade: quem consegue reescrever o Release reescreve os dois arquivos. Distingui-lo de assinatura e o que impede a prosa publica de prometer garantia que a mecanica nao entrega.

**janela de prerelease**:
Intervalo em que o Gateship tem caminho de instalacao publicado mas ainda nao teve instalacao externa, durante o qual o ADR-0054 autoriza renomear contratos internos. O ADR-0055 marcou o primeiro Release como prerelease para manter a janela aberta. Medicao de 2026-08-04 refinou o marco de fechamento: o Release v0.278.0 saiu como efeito colateral do push de tag, com downloads=0, entao o evento que fecha a janela e o primeiro download e nao o ato de publicar.

**staged install temp**:
Arquivo temporario criado por mktemp DENTRO do diretorio de instalacao, preparado por completo (conteudo, bit de execucao, quarentena removida, e no caminho interno tambem assinatura e smoke) e so entao renomeado por cima do destino final. Fica no mesmo diretorio, e nao em $TMPDIR, porque rename so e atomico dentro do mesmo filesystem.

**running-image poisoning**:
Falha do macOS em que sobrescrever in-place o inode de um binario que um processo vivo mantem aberto como imagem executavel (fd txt) faz o arquivo resultante ser morto com SIGKILL no proximo exec (rc=137), sem nenhuma mensagem de diagnostico. Bytes identicos noutro caminho executam normalmente. O equivalente no Linux e o kernel recusar a escrita com ETXTBSY.

**atomic install swap**:
Invariante de instalacao do gateship: um destino de instalacao e substituido por rename(2) de um staged temp do mesmo diretorio, nunca por escrita in-place. Garante as duas coisas de uma vez, que o processo em execucao siga com o inode antigo intacto e que nenhum leitor consiga observar um arquivo parcialmente escrito.

**cam runtime artifact**:
A file the product writes during loop execution (event log, supervisor log, durable markers, session/lock files, gate results), as opposed to template content that gship init installs and which is meant to be committed. Runtime artifacts can carry the user's file paths, prompts, raw git/gh stderr and pane transcripts, so they must be ignored in every project cam manages.

**parity oracle**:
A set-equality comparison between two verdicts derived live from the tree at check time. Because it compares sets rather than asserting membership, it fails in both directions by construction (omission and over-inclusion) and therefore needs no separately authored negative control.

**rotating harness state**:
Per-story files the harness overwrites each cycle (prd.json, handoff.json, review-artifact.txt). An acceptance-criterion oracle must never target one: whichever story's rotation happens to be at HEAD decides the verdict, so the criterion passes or fails by coincidence rather than by correctness. Enforced deterministically by the prd-oracle-lint rule rotating-artifact-target.

**wait censurado a direita**:
Falha de espera cuja duracao medida coincide com o proprio orcamento do timeout. Ela limita a latencia real apenas por baixo (a latencia e maior ou igual ao orcamento) e nunca revela o valor verdadeiro, portanto nao serve de base para dimensionar um orcamento novo.

**pin de invariancia com comparand derivado**:
Oraculo cujo valor de comparacao e lido da referencia base no momento da checagem, em vez de congelado no texto do criterio. Verde por construcao quando a invariante e respeitada, e imune ao apodrecimento que atinge um comparando literal.

**oraculo de deteccao de mudanca**:
Oraculo que prova a existencia de uma mudanca ainda inexistente na base. Precisa ser varrido VERMELHO contra a base antes de ser aceito: verde na base significa que ele nao detecta aquilo que alega detectar.

**condicao de carga declarada**:
Condicao de contencao especificada de forma explicita e reproduzivel sob a qual um criterio sensivel a tempo e avaliado. Substitui a mencao vaga a contencao, que nao e verificavel porque a carga de uma maquina varia por causas exogenas.

**worker headless**:
Sessao de worker executada como processo filho nao interativo, via `claude --print` com entrada e saida em stream-json, sem painel de tmux e sem terminal alocado. Contrasta com o worker TUI, que vive num painel de tmux criado por respawn-pane e e observado pelo supervisor atraves da vitalidade desse painel.

**stream-json**:
Formato de entrada e saida do Claude Code CLI em que cada linha do fluxo e um envelope JSON completo. O vocabulario observado em medicao real de 2026-08-08 foi system (subtype init), rate_limit_event, assistant e result. O custo acumulado da sessao sai no campo total_cost_usd do envelope result. Eventos parciais (stream_event) so aparecem sob a flag --include-partial-messages, que o projeto nao usa.

**recorte de invariante**:
Forma de mudar uma invariante do projeto em que a regra original continua valendo integralmente no escopo onde foi medida, e um escopo novo nasce explicitamente isento, com a isencao nomeada e fundamentada. Distingue-se de aposentar a invariante, que a derruba em todos os escopos de uma vez. O recorte e preferido quando o escopo novo ainda nao foi provado em producao.

**seam de dispatch**:
Ponto unico onde o supervisor decide como um worker sera executado, antes de montar qualquer argumento de linha de comando. No codigo atual esse ponto e a resolucao de worker_isolation em src/supervisor/host.ts, uma leitura unica cujo resultado e passado adiante. Nao confundir com BackendAdapter, que decide qual binario e quais flags (claude ou codex) e cujo contrato ja fixa respawn-pane como destino.

**log append-only por dispatch**:
Arquivo em disco, um por invocacao de worker, que recebe a saida do modelo conforme ela chega e nunca e reescrito nem truncado. Substitui, para o worker headless, a funcao de observabilidade que o painel de tmux exercia por acidente no worker TUI, e e o material que uma superficie web posterior consome.

**template pair**:
A tuple of one file under templates/ and the installed copy it maps to in a cam-managed project (under .claude/, scripts/cam/, or the repo root). The mapping is one-way and total: every template file has exactly one destination, but a destination may exist with no template behind it.

**seed-vs-live pair**:
A template pair whose template side is an initial seed and whose installed side accumulates runtime state over the life of the project (the cycle journal, the durable patterns list, the suggestion holding pen). The two sides are never expected to agree, are never reconciled, and are never collapsed into a single source; treating one as stale relative to the other destroys accumulated project history.

**overlay pair**:
A single {find, replace} substitution of exact literal text, declared for one document, that carries a project-specific deviation from a shared base. A document's full set of overlay pairs is the complete statement of how that project's copy differs from what ships to every other project.

**anchor arity**:
The requirement that the find side of an overlay pair matches its base exactly once: never zero times (the base moved and the deviation is now unanchored) and never more than once (the deviation would be applied ambiguously). Arity is the drift detector for the portion of a document that cannot be single-sourced.

**pristine-base matching**:
The rule that every overlay pair for a document is matched and counted against the unmodified base, with all matches resolved before any replacement is written. The alternative, applying each pair to the result of the previous one, makes anchor arity depend on ordering and silently voids the guarantee it exists to provide.

**hunk carve-out**:
A sub-region of a divergent hunk whose correct owner differs from the owner of the hunk as a whole, for example a generic process rule that should propagate to the base while the stack-specific command names inside the same hunk stay project-local. Carve-outs are why hunk-level reconciliation cannot be decided by picking a winning side per hunk alone.

**symlink-integrity gate**:
A bidirectional check over a set of collapsed template pairs: it asserts both that the paths which must be single-sourced are recorded as links in version control and resolve to their intended target, and that the paths which must never be linked are still independent files. The negative direction is the load-bearing one, because a well-meaning extension of the collapse is what would destroy a seed-vs-live pair.

**reconciliation direction**:
For a divergence that should not exist, the decision of which side is current and which is stale, made per hunk. Assigning it is a judgment about which text describes live behavior, not a mechanical diff operation, and it is the point at which content is most easily lost without trace.

**cursor de stream**:
Posicao de leitura que um cliente da superficie web carrega para retomar o stream de eventos sem perder nem duplicar. Composto por offset de byte no event log append-only mais uma identidade do arquivo, de modo que truncamento ou substituicao do log provoque reset em vez de leitura a partir de offset invalido.

**estado idle**:
Um dos dois estados da tela web. Vigora quando nao ha ciclo ativo, condicao em que prd.json nao existe. Responde o que aconteceu por ultimo e o que vem a seguir, a partir de cycle-metrics.jsonl e do backlog, em vez de renderizar a view de ciclo ativo vazia.

**idade do dado**:
Tempo decorrido desde o ultimo snapshot recebido, calculado pelo relogio do CLIENTE e nao do servidor. Existe para tornar visivel qualquer falha de entrega: servidor caido, loop parado ou leitura periodica interrompida aparecem como dado velho, em vez de uma tela congelada que parece viva. Definicao corrigida em 2026-08-13: a versao anterior dizia ultimo EVENTO recebido, formulada quando a superficie web ainda previa stream; o stream foi cortado pela emenda 3 de 2026-08-13 e a leitura passou a ser periodica, entao a ancora do calculo e o snapshot.

**pino de invariancia**:
Especie de criterio de aceite que afirma que algo NAO mudou, por oposicao ao criterio de deteccao-de-mudanca, que afirma que algo passou a existir. Um pino nasce verde e so fica vermelho se a fatia violar a fronteira que ele guarda; seu comparando e sempre derivado ao vivo dos dois lados, nunca congelado como literal.

**vendorizacao re-executavel**:
Forma de trazer codigo de terceiro para o repositorio por meio de um script que pode ser rodado de novo contra a fonte upstream, com versao pinada e gate de drift, em vez de uma copia manual. Impede que adaptacoes locais virem um fork que precisa ser reaplicado a cada atualizacao.

**contrato de tres sinais**:
Regra de conclusao de um worker executado como processo filho: a conclusao so e reconhecida quando os tres sinais concordam, sendo eles o evento terminal observado no stream de saida, o codigo de saida do processo filho, e o artefato de papel presente e valido no schema. Qualquer divergencia entre os tres nao e empate a resolver por precedencia: e um desfecho nomeado, sem veredito, com o artefato preservado como forense.

**signal-disagreement**:
Desfecho nomeado emitido quando os sinais do contrato de tres sinais nao concordam entre si. Carrega os sinais observados em vez de escolher um deles. Nunca produz veredito de papel.

**evento terminal**:
Ultimo evento estruturado que o agente emite no stream de saida antes de encerrar, declarando o fim do proprio protocolo. Sua ausencia indica execucao truncada ou morta, mesmo quando o processo saiu com codigo zero. O nome concreto do evento e especifico de cada backend.

**await-then-read-once**:
Forma de deteccao de conclusao em que o supervisor espera o processo filho terminar e so entao le o artefato de papel uma unica vez, em oposicao a um laco de poll que amostra periodicamente arquivo e liveness enquanto o worker roda.

**ator de worker**:
Papel que uma sessao de agente ocupa no ciclo, entre implementer, planner, auditor e reviewer. E o eixo pelo qual se decidem persona, permissoes de escrita e marcadores de ambiente. Nao se confunde com backend, que e qual ferramenta de agente executa o papel.

**artefato de papel**:
Arquivo que um ator de worker produz como sua saida de contrato, e que o supervisor le para derivar o resultado. E a lingua franca entre papeis e e neutro de backend: worker-report.json para o implementer, review-report.json para o reviewer, prd.json para o planner, plan-verdict-report.json para o auditor.

**roteamento por campo de sessao**:
Mecanismo pelo qual todas as fases de um ciclo herdam uma escolha de substrato de execucao a partir de um unico campo no arquivo de estado do loop, escrito por qualquer porta de entrada de CLI e lido por todas as fases, em vez de cada comando decidir isoladamente.

**bloco de paridade**:
Uma das unidades de informacao que o dashboard mostra ao operador (estado do loop, story corrente, progresso, tempo desde a ultima atividade, sessao, custo em tokens, branch, lista de stories, detalhe da story, ultimos eventos). Serve de contrato entre superficies: qualquer superficie nova que se proponha a substituir o dashboard e medida por quantos blocos ela reproduz, e a omissao de um bloco e sempre declarada com o motivo.

**payload idle**:
A resposta que uma superficie de observacao devolve quando nao existe ciclo em andamento. Em vez de mostrar a view de ciclo ativo com campos vazios, ela troca de conteudo e passa a mostrar historico recente de ciclos fechados e o backlog. Idle e um estado de primeira classe do produto, nao a ausencia de estado.

**leitura limitada por sessao**:
Politica de leitura em que o custo de responder e proporcional ao que foi registrado na sessao corrente, e nao ao historico acumulado. O leitor comeca pelo fim do registro e para quando ultrapassa o inicio da sessao, com margem para desordem de relogio entre escritores concorrentes.

**split de tsconfig**:
Separacao do typecheck em dois projetos que nao se enxergam, para que codigo de servidor e codigo de navegador convivam no mesmo repositorio sem que um contamine o outro. O tsconfig da raiz exclui explicitamente a arvore do cliente e nao declara lib DOM; a arvore do cliente carrega o proprio tsconfig com lib DOM. Necessario porque o tsconfig da raiz nao tem include, entao qualquer diretorio novo entra no typecheck por omissao e nao ha como evitar isso deixando de citar o diretorio.

**renderizacao estatica**:
Forma de exercitar um componente React em teste convertendo-o a string de HTML por renderToStaticMarkup, sem instalar nenhuma global de navegador. Executa o componente de verdade, portanto detecta crash de renderizacao e ramo de estado nao renderizado, e nao cobre efeito, evento nem layout. Distingue-se de duas praticas vizinhas: e mais forte que assercao sobre texto-fonte, que nunca executa o codigo, e mais barata que harness de DOM simulado, que executa mas tambem nao computa layout.

**guard de referencia de licenca**:
Verificacao que impede codigo de terceiro vendorizado de arrastar dependencia de licenca incompativel por referencia, e nao apenas por caminho de arquivo. Complementa o guard por caminho: restringir o manifesto a um subdiretorio de licenca permissiva nao basta quando arquivos daquele subdiretorio importam um pacote irmao de licenca copyleft. O guard falha fechado, ou seja, a vendorizacao aborta quando sobra qualquer referencia.

**override de disco para desenvolvimento**:
Valvula de escape que permite servir a interface web a partir de um diretorio em disco em vez do bundle embarcado no binario, sob controle de variavel de ambiente ou caminho de configuracao. Padrao universal entre projetos de binario unico que embarcam interface, medido em 2026-08-13: todos os cinco levantados mantem uma. Existe para que desenvolvimento nao exija recompilar o binario a cada mudanca de tela.

**spine de gates**:
O conjunto de 16 gates registrados no manifesto GATES de scripts/check-all.ts, executado por bun run check:all e usado pelo CI para decidir o merge. Registro no manifesto e o unico mecanismo que faz um gate rodar: script declarado em package.json mas ausente do manifesto nunca executa, e nenhuma checagem acusa a ausencia.

**gate path-scoped**:
Gate cuja cobertura e delimitada por glob, por whitelist de config ou por argumento posicional, e que portanto deixa arvore nova de fora por omissao em vez de por decisao. Medido em 2026-08-13: dos 16 gates do repo, nove sao path-scoped e deixariam uma arvore webui/ nova descoberta.

**violacao plantada**:
Forma de oraculo que escreve um arquivo violando a invariante do gate dentro da arvore alvo, roda o comando daquele gate isolado, assevera exit nao-zero e remove o arquivo. Distingue glob certo de glob presente porem errado, coisa que assercao de texto de config nao faz. Roda o gate isolado e nunca a spine inteira, porque sob check:all qualquer gate vermelho satisfaria o oraculo e todos viram um so, vacuamente.

**varredura nas duas direcoes**:
Provar que a MESMA violacao ja reprova dentro do escopo atual do gate (a forma da violacao e real) e passa na arvore alvo (o buraco existe), com controle verde sem probe. Varrer apenas o vermelho na main nao detecta vacuidade por forma de violacao invalida: medido em 2026-08-13, tres formas de violacao inventadas saiam exit 0 tambem dentro do escopo do gate, e so a segunda direcao revelou isso.

**ratchet congelado**:
Gate que cobra teto apenas para os paths presentes num snapshot persistido, e que portanto nao cobre nada criado depois dele. O gate file-size do repo e desta forma: checkSizeCeilings itera o orcamento e nao a varredura, entao arquivo sem entrada em scripts/file-size-budget.json nunca e visitado, em qualquer tamanho.

**comando do gate**:
Cada entrada do manifesto GATES carrega o proprio comando literal, que pode delegar explicitamente a um script do package.json. O gate typecheck faz isso hoje com g('typecheck', 'bun run typecheck'), de modo que o mesmo script verifica em sequencia os projetos TypeScript do servidor/CLI e da webui tanto quando chamado diretamente quanto via check:all/CI. Um script novo continua inerte no CI ate ser registrado no manifesto; todo criterio que queira provar cobertura de gate deve derivar o comando de GATES ao vivo, em vez de presumir que o script homonimo e ou nao e delegado.

**fecho transitivo de vendorizacao**:
O conjunto de arquivos copiados do upstream, calculado pelo script a partir de uma lista-semente seguindo os imports relativos ate o ponto fixo. E o que torna a clausula do guard sobre caminho relativo satisfeita por construcao, e o que faz um arquivo inalcancavel na arvore vendorizada ser sinal de que o script copiou demais.

**guard fail-closed por allowlist**:
Verificacao em que todo especificador literal de import precisa ser ou caminho relativo que normalizado permanece dentro da raiz vendorizada, ou membro de uma lista npm explicita, e qualquer coisa desconhecida REPROVA. Oposto de denylist, que so reprova o que ja foi previsto.

**registro de proveniencia**:
Arquivo na raiz da arvore vendorizada com URL do upstream, SHA do commit, o texto do LICENSING.md da raiz do upstream como estava naquele SHA, e o texto MIT com a linha de copyright do upstream. Substitui deteccao por disciplina, porque comparacao de conteudo contra o lado AGPL e inutil por construcao.

**item de registry construido**:
A saida do shadcn build em apps/ui/public/r/*.json, onde os tokens de cor aparecem como dados no campo cssVars. E a fonte MIT dos tokens, por oposicao ao CSS do pacote AGPL.

**namespace de registry**:
No shadcn, uma entrada de registryDependencies como @coss/ui que resolve por template de URL para outro item de registry. NAO e import npm. E a razao de o guard precisar parsear declaracao de import em vez de casar string solta: @coss/ui e token sobrecarregado no upstream, significando pacote npm AGPL num sitio e conjunto de componentes MIT noutro.

**@theme inline**:
Forma do Tailwind v4 em que o utilitario emite a referencia da custom property diretamente, resolvendo no elemento em vez do sitio da definicao. Obrigatoria, nao opcional, para que qualquer override no cascade tenha efeito, inclusive o de modo escuro.

**idade de transporte**:
Decorrido entre o instante em que o cliente recebeu o ultimo snapshot com sucesso e o agora do relogio do cliente. Detecta servidor caido e rede quebrada.

**idade de loop**:
Decorrido entre lastActivity e o nowMs do servidor, ambos vindos de dentro do snapshot. Detecta loop travado enquanto os snapshots continuam chegando normalmente. E defeito distinto da idade de transporte, e um numero so deixa um dos dois silencioso.

**paridade por construcao**:
Propriedade em que a rota web chama o mesmo readSnapshot exportado que o pane consome e serializa o resultado omitindo chaves, em vez de reproduzir os blocos do pane. Fixada pela emenda 6 de 2026-08-13. Tem duas excecoes estruturais medidas: as duas superficies de custo em token do pane e a ausencia de contrapartida do idleState.
