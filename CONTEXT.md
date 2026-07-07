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
