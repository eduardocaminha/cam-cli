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
