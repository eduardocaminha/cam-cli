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
