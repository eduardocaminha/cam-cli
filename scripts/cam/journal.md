# Cam Journal

This file is the orchestrator's long-term memory for this project. One entry
per completed (or abandoned) cycle, appended in chronological order — newest
at the bottom.

The orchestrator reads this file on startup to rehydrate context. Workers
never read or write to it directly; only the orchestrator appends entries.

---

## Format

Each entry follows this template:

```markdown
## <cycle id> — <short title>

- **Started**: <ISO 8601 date>
- **Closed**: <ISO 8601 date or "abandoned">
- **Branch**: <branch name>
- **Issue**: <Linear ID / GitHub #N / CAM-XXX>
- **Outcome**: shipped | abandoned | blocked
- **Summary**: <1-2 sentences describing what was done>
- **Decisions**: <key architectural choices with rationale; omit if none>
- **Blockers encountered**: <what went wrong, how it was resolved>
- **Follow-ups**: <any debt, known issues, or next-cycle candidates>

```

---

## Guidelines for the orchestrator

- Append a new entry **only after a cycle fully ends** (shipped, abandoned,
  or explicitly closed by the human). Do not append mid-cycle.
- Keep each entry concise — aim for < 200 words. Details live in the PRD,
  PR description, and commit history; the journal is a scannable index.
- When referencing past work in conversation, cite the cycle id
  (e.g. "see LIN-42" or "see cycle cam/pr-12-auth").
- When the journal exceeds ~50 entries, summarize the oldest third into a
  single "Pre-<date> summary" block at the top of this file and archive
  the raw entries to `scripts/cam/journal.archive.md`.

---

## Entries

<!-- Entries are appended below. Do not remove this marker. -->
<!-- ENTRIES_BELOW -->

> Archived 37 oldest entries to scripts/cam/journal.archive.md on 2026-07-08. See that file for the full history.

## cam/CAM-114-stale-no-linter-docs — Corrigir docs stale 'no linter configured' (biome + check:all vivos desde CAM-60)

- **Started**: 2026-06-29
- **Closed**: 2026-06-29
- **Branch**: cam/CAM-114-stale-no-linter-docs
- **Issue**: CAM-114
- **Outcome**: shipped
- **Summary**: DOC-only: corrige a claim stale 'no linter configured / typecheck e o gate estatico' em 4 arquivos de instrucao do harness. Desde CAM-60 (PR #66) biome.json existe e bun run check:all roda gate de lint (CI roda check:all), mas planner/auditor/implementer/reviewer ainda eram instruidos que nao havia linter (implementer e reviewer EXPLICITAMENTE mandados a NAO rodar lint, minando o gate). 4 stories, um arquivo cada: US-001 scripts/cam/CLAUDE.md:45, US-002 subagent-auditor.md:91, US-003 subagent-implementer.md:93, US-004 subagent-reviewer.md:39. Review CLEAN round 1. PR #93, v0.20.0.
- **Decisions**: AC#2 do issue (editar mirror templates/ + re-embed _generated.ts) INTENCIONALMENTE nao implementado: planner verificou que os templates/ sao skeletons genericos sem o texto stale; embed-vendor:check fica como safety oracle verde. Divergencia documentada na description do PRD (nao silenciosa).
- **Blockers encountered**: Auditor BLOCKou round 1 num CRITICAL real (classe two-layer): o spec enumerava 2 sites mas o stale vivia em 3 (.claude/agents/subagent-implementer.md:93 omitido, o mais consequente pois roda os gates por-story). Planner adicionou US-003 e o full-repo grep dele achou um 4o site (subagent-reviewer.md:39) que o auditor tambem perdeu, adicionado como US-004. Re-audit APPROVE (escopo completo, oracles discriminam). Merge-watch consumido antes do CI verdar 1x (classe CAM-103); re-escrito, post-merge autonomo.

## CAM-99-abandoned-no-cycle — CAM-99 abandonado: bump-by-default ja satisfeito pelo Step 4 do CAM-88

- **Started**: 2026-06-29
- **Closed**: 2026-06-29
- **Branch**: none (fechado sem ciclo/PR)
- **Issue**: CAM-99
- **Outcome**: abandoned
- **Summary**: CAM-99 (/cam-ship bumpa por default, sem flag --bump manual) fechado como redundante apos grounding no plan. O objetivo do operador (nao decidir bump caso a caso) JA esta satisfeito: o Step 4 do cam-ship.md (ambas as copias) roda `cam ship --bump` incondicional desde antes (CAM-88/89), e classifyBump/computeNextVersion ja no-opam sem commit feat/fix. O residual proposto (flipar o default da CLI bare `cam ship` pra bump-on com --no-bump opt-out) NAO fecha arquiteturalmente: o `cam ship` bare e o THIN-PROXY (injeta /cam-ship no pane do orquestrador, sem contexto de release in-process), entao 'bump default-on' nao pode valer pro comando bare sem quebrar o proxy, e --no-bump ficaria opting-out de um bump que so dispara com --bump explicito (semantica incoerente). O planner flagou isso como load-bearing design decision; o operador escolheu fechar (opcao 1) em vez de redesenhar o dispatch.
- **Decisions**: Operador escolheu fechar CAM-99 como already-done (sem mudanca de codigo) em vez de (2) ciclo cosmetico doc-only ou (3) redesign do dispatch thin-proxy. status:abandoned (schema: open|abandoned, additionalProperties:false, sem campo de razao -> razao mora aqui no journal, convencao CAM-51/76). prd.json gerado descartado, nao branchou.
- **Blockers encountered**: Nao ha CLI pra fechar issue arbitrario (finalize so fecha o issueNumber do PRD; cam spec so promove idea->specified, o modo abandon do specifyIssueOnMain nao esta exposto). Marquei status:abandoned via hand-edit jq + commit direto no main (admin, enforce_admins=false). Lacuna ja conhecida (follow-up CAM-108): vale um cam issue close/abandon determinístico.

## cam/CAM-94-blocked-narration-supervisor-outcome — Narracao terminal-blocked narra outcome do supervisor (nao o auto-reporte do worker)

- **Started**: 2026-06-29
- **Closed**: 2026-06-29
- **Branch**: cam/CAM-94-blocked-narration-supervisor-outcome
- **Issue**: CAM-94
- **Outcome**: shipped
- **Summary**: Single-story supervisor narration fix. Os 6 sites terminal-blocked de notifyOrchestrator em src/supervisor/loop.ts narravam formatWorkerReportSummary(report) (auto-reporte do worker, ex DONE), podendo mostrar [cam] US-XXX DONE numa story que o supervisor bloqueou. Fix: narrar lastOutcome.detail no shape [cam] <storyId> BLOCKED: <detail> nos 6 sites, independente do kind (blocked|fail|unknown|incomplete; sites ~949/996 carregam fail/unknown/incomplete via lastOutcome=outcome em loop.ts:876). Os 3 usos happy-path (DONE/genuine-advance/PRD_COMPLETE) intactos. Oracle behavioral: injeta report DONE, dirige a terminal-blocked, asserta que a linha narrada reflete BLOCK. Review CLEAN round 1. PR #94, v0.21.0.
- **Decisions**: Auditor APPROVE (1 important + 2 suggestion). F-01 aplicado: AC fixava so typecheck+bun test, adicionado [oracle: bun run check:all] (ironia com CAM-114 recem-shipado que corrigiu a claim no-linter). F-02 aplicado: AC#1 reformulada pra narrar detail nos 6 sites SEM gatear em kind==='blocked' (senao pularia os 2 sites fail/unknown/incomplete). Worker levantou file-size loop.test.ts 2810->2966 (_ref CAM-94) sozinho no commit feat (licao orch-no-hardkill).
- **Blockers encountered**: CORRECAO DE DIAGNOSTICO (eu errei 3x: CAM-93/114/94): o merge-watch sumir em segundos NAO e perda de watch, e BY DESIGN. sidecar.ts:299-300 deleta .cam-merge-watch.json ANTES de iniciar runMergeWatch ('to prevent re-entry on sidecar restart'); o watch vive em memoria dentro de runMergeWatch que faz polling ate 4h e trata OPEN+BLOCKED+sem-check-falho como keep-polling (merge-watch.ts:250). Re-escrever o arquivo era desnecessario e CAUSAVA o double post-merge (cada re-escrita spawna um 2o watcher in-memory -> 'tag created' + 'tag existed'). Unico modo de falha real: sidecar morrer apos consumir o arquivo. CAM-103 e outra coisa: o await runMergeWatch BLOQUEIA o outer loop do sidecar ate 4h sem health-check.

## cam/CAM-95-promote-cap-stop-to-max-rounds-debt — Promote review verdict a MAX_ROUNDS_DEBT quando o loop para no cap (reentry)

- **Started**: 2026-06-29
- **Closed**: 2026-06-29
- **Branch**: cam/CAM-95-promote-cap-stop-to-max-rounds-debt
- **Issue**: CAM-95
- **Outcome**: shipped
- **Summary**: Fix do wedge de review-cap (classe CAM-53b/CAM-78). O bug e o caminho de REENTRY: quando o loop re-entra com roundsCompleted==maxRounds e lastVerdict ainda FIXES_PENDING:N, decideNextAction (decide.ts:116-118, funcao PURA) retorna complete/await-operator sem promover o verdict, deixando-o FIXES_PENDING e travando o /cam-ship (terminal so com CLEAN|MAX_ROUNDS_DEBT via makeHasPendingStories), forcando bump manual de maxRounds. A promocao existente (loop.ts:1107) so cobria post-review-round, nao reentry. Fix: US-001 adiciona sinal puro promoteVerdictTo?:'MAX_ROUNDS_DEBT' aos variants complete+await-operator (so quando lastVerdict non-null e NAO terminal); US-002 runSupervisor persiste em prd.review antes do terminal, entao cap-reentry sai MAX_ROUNDS_DEBT e makeHasPendingStories flipa true->false. 2 stories, 2101 pass, review CLEAN round 1. PR #95, v0.22.0.
- **Decisions**: Split signal(puro)+persist por causa do contrato de pureza do decideNextAction. Auditor APPROVE round 1 (0 critical/important, 2 suggestions cosmeticas nao aplicadas: pinar arquivo do oracle AC3, nota de traceability na description). Cobre os DOIS terminal exits (complete+await-operator), nao whack-a-mole; CLEAN/ja-MAX_ROUNDS_DEBT intactos.
- **Blockers encountered**: Nenhum em runtime: loop self-drove US-001->002->review CLEAN round 1 com zero re-arm. VALIDACAO DA CORRECAO DE MERGE-WATCH: este foi o primeiro ship onde NAO re-escrevi o .cam-merge-watch.json apos ele ser consumido. Resultado: post-merge rodou UMA vez (tag created), sem o double 'tag existed' dos ciclos anteriores. Confirma que consume-on-read e by-design e re-escrever causava o double. Memoria merge-watch-consume-on-read-is-by-design validada live.

## cam/CAM-105-post-merge-prune-observability — Evento post-merge-done carrega branchPrunedLocal/Remote + warn no prune-failure

- **Started**: 2026-06-29
- **Closed**: 2026-06-29
- **Branch**: cam/CAM-105-post-merge-prune-observability
- **Issue**: CAM-105
- **Outcome**: shipped
- **Summary**: Observability fix (P3). runPostMerge ja retornava branchPrunedLocal/branchPrunedRemote mas o evento merge-watch-post-merge-done so gravava {prNumber,ok,tag,tagCreated} (doneDetail em merge-watch.ts:225, branch ok==true), entao um prune falho nao deixava rastro no event log (evento dizia ok:true). Fix: 2 booleans adicionados ao MergeWatchPostMergeDoneEventDetail (events.ts:205), ligados no doneDetail, + warn narration quando algum prune falhou (seam na linha 224). ok==false intacto; -d->-D deixado como follow-up (latente, fora das ACs). 1 story, 2102 pass, review CLEAN round 1. PR #96, v0.23.0.
- **Decisions**: Auditor APPROVE round 1 (0 critical/important, 2 suggestions APLICADAS: F-01 oracle behavioral ganhou assertion negativa do happy-path (both-true => zero warnings espurios), F-02 dropou o grep redundante da warn-condition em favor do teste behavioral). 6 ACs.
- **Blockers encountered**: Nenhum: loop self-drove US-001 + review CLEAN round 1 zero re-arm. Merge-watch NAO re-escrito (correcao holding): post-merge unico (tag created), sem double. Segundo ship consecutivo validando a memoria merge-watch-consume-on-read-is-by-design.

## cam/CAM-137-sync-worktree-on-main — on-main writers sincronizam a worktree quando rodados em main (fim do footgun)

- **Started**: 2026-06-29
- **Closed**: 2026-06-29
- **Branch**: cam/CAM-137-sync-worktree-on-main
- **Issue**: CAM-137
- **Outcome**: shipped
- **Summary**: Conserta o footgun de worktree-desync dos on-main writers (vivido ~6x esta sessao: cada journal append/issue/spec/triage rodado EM main deixava os arquivos escritos como reversao staged). Redefine o invariante de commitTreeToMain de 'nunca toca a worktree' para 'deixa a worktree coerente com o HEAD apos a call'. Novo syncWorktreeIfOnMain(cwd,paths,spawnFn) (src/git/on-main.ts) roda como passo final apos o CAS update-ref OK, gated em current-branch==main (self-detect via rev-parse --abbrev-ref HEAD), path-scoped sobre files++removals via `git restore --staged --worktree --source=HEAD -- <paths>` (trata add/mod/del uniforme; NAO checkout HEAD que vaza delecoes), best-effort (warn, nunca throw, nunca muda o sha). Os 6 call-sites herdam do choke-point. 3 stories, 2116 pass, review CLEAN round 1. PR #97, v0.24.0.
- **Decisions**: Auditor APPROVE round 1 (0 critical, 1 important + 2 suggestion, TODOS aplicados): F-01 pinou check:all nas ACs (US-001+002), F-02 promoveu a discriminacao (testes FALHAM contra pre-US-001 HEAD) a AC reviewer-judgment, F-03 alinhou a AC do warning com captura real de stderr (printError em color.ts:117). Off-main byte-identico/regression-guarded; CAS/checkMainUpToDate inalterados. branchWasMain virou candidato a dead-code (cleanup nao exigido).
- **Blockers encountered**: Nenhum: loop self-drove US-001->002->003 + review CLEAN round 1, zero re-arm. Merge-watch nao re-escrito (post-merge unico, tag created). NOTA DE COERENCIA: o fix esta em main (v0.24.0) mas NAO no binario instalado (0.17.0); este proprio journal append rodou com o footgun ainda ativo (sincronizei a worktree a mao). O fix so elimina a mitigacao manual APOS rebuild+reinstall.

## cam/CAM-132-meta-loop-observe — CAM-132: meta-loop observe core (config flag, event, decide-fn, idle-tick wiring, notify-on-drain)

- **Started**: 2026-06-29
- **Closed**: 2026-06-29
- **Branch**: cam/CAM-132-meta-loop-observe
- **Issue**: CAM-132
- **Outcome**: shipped
- **Summary**: Implementa o observe core dormente do meta-loop inter-ciclo (CAM-132). Quando meta_loop=observe em project.toml [loop], o idle-tick do sidecar observa o backlog entre ciclos: seleciona o proximo issue plannavel, emite um evento estruturado meta-loop-observe, e envia Resend quando a fila drena. Off por default e byte-identico sem configuracao. Sem dispatch, sem mutacao: apenas observe. 5 stories (US-001..005), 2161 pass / 0 fail, review CLEAN round 1. Loop self-drove com zero re-arm.
- **Decisions**: readMetaLoop fail-closed (unknown->off, nunca observe por typo; padrao readMergeMode/readPlanApproval). decide-fn pura (src/supervisor/observe.ts): dedup por id + drained detection sem I/O (seam injetado, nao chamado internamente). wiring via runMetaLoopObserveFn opcional em RunSidecarLoopOptions: undefined=inerte quando off (zero behavior change). drain notify via readResendConfig+sendEscalation com subject drain-especifico, nao reusa o escalateFn de nao-convergencia (semanticamente errado). Backlog lido do main (CAM-86/CAM-133 invariante).
- **Blockers encountered**: Nenhum em runtime: loop self-drove US-001->005 com zero re-arm, ~46min end-to-end. Sidecar vivo desde o boot desta sessao (pid 79502). Dois SUGGESTION nao-bloqueantes do reviewer (testes injetam seams em vez de executar factories de producao; selectPlannableFromFile roda todo idle-tick sem coarser interval); ambos deferidos como follow-up.

## cam/CAM-119-init-installs-skills — cam init instala a subarvore skills/ no destino downstream (conserta /cam-spec)

- **Started**: 2026-06-29
- **Closed**: 2026-06-29
- **Branch**: cam/CAM-119-init-installs-skills
- **Issue**: CAM-119
- **Outcome**: shipped
- **Summary**: Follow-up do CAM-107. O cam init nao instalava a subarvore skills/ no destino: o install routine (targetPath + SUBTREES em src/templates/embedded.ts, copyTemplates em src/commands/setup.ts) nao tinha branch pra skills/, entao as 5 chaves skills/* caiam em <cwd>/skills/ (lugar errado), a contagem por-subtree nunca as rastreava e o summary nao emitia linha de skills. Consequencia: projeto downstream recebia .claude/commands/cam-spec.md mas NAO a skill grill-with-docs que ele invoca, quebrando /cam-spec (skill nao encontrada). US-001 adicionou o branch de routing + entry de count + linha de summary; US-002 travou com teste de regressao downstream (byte-parity da grill-with-docs + co-install com cam-spec.md). 2 stories, review CLEAN round 1, 2169 pass / 0 fail, check:all verde. PR #99, v0.26.0.
- **Decisions**: Planner corrigiu o spec (5 chaves skills/ on-disk em _generated.ts, nao 6 como o texto do issue dizia). Oracle de runtime (captura stdout, asserta 'Installed 5 file(s) para .claude/skills') escolhido sobre file-assert estatico pra cobrir o sintoma headline ('NENHUMA linha de skills'). copyTemplates exportado (era privado em setup.ts:300) pro teste runtime invocar.
- **Blockers encountered**: Auditor BLOCKou round 1 num critical real (classe two-layer): US-001 criterion #4 usava grep -q '.claude/skills' setup.ts, pre-satisfeito no HEAD pela prompt-string em setup.ts:346, logo tautologico (nao falha contra pre-fix HEAD). Planner trocou por oracle runtime discriminante + criterion #5 secundario com token ausente no HEAD (subtree: 'skills'); re-audit APPROVE. Loop self-drove plan, US-001, US-002, review CLEAN com zero re-arm; ci-gated post-merge autonomo (CI verde, auto-merge squash, sidecar pull/tag v0.26.0/prune).
- **Follow-ups**: Sessao de batch autonomo (96 em diante): proximo por rank e CAM-130 (doc-only, licao bytes-vs-chars do git cat-file --batch pro patterns.md). CAM-65 (reviewer pane lingering pos-CLEAN) reproduzido, matado a mao pre-ship. No inicio da sessao: limpeza de 15 branches remotos legados + 1 worktree-agent local (todos squash-merged, anteriores ao auto-prune confiavel). Binario reinstalado pra 0.26.0 fica pendente pro proximo boundary (instalado e 0.25.0; CAM-119 toca so o install routine, behavior-coerente).

## cam/CAM-138-merge-watch-state-machine — merge-watch per-tick state machine (fecha CAM-103)

- **Started**: 2026-06-29
- **Closed**: 2026-06-29
- **Branch**: cam/CAM-138-merge-watch-state-machine
- **Issue**: CAM-138
- **Outcome**: shipped
- **Summary**: Endurece o lifecycle do merge-watch do sidecar, movendo disciplina-do-orquestrador pra runtime deterministico (filosofia CAM-122/72/131). Troca o await bloqueante de 240 polls (4h) do runMergeWatch por um state-machine de um-passo-por-tick: stepMergeWatch(state,now,pollFn) roda 1 poll por idle tick (throttle ~60s via lastPolledAt persistido), estado duravel em .claude/.cam-merge-watch.json (restart do sidecar retoma em vez de perder o watch), arquivo removido so em outcome terminal. Fecha CAM-103 (outer loop nao bloqueia mais; hasSessionFn roda todo tick). 4 stories + 2 fix-stories, 2197 pass / 0 fail, check:all verde, review CLEAN round 2. PR #100, v0.27.0.
- **Decisions**: O titulo dizia live-owner guard (pid/heartbeat) mas o grill OVERRODE: sem owner-guard, confia no invariante de sidecar-unico (CAM-67) + post-merge idempotente. Seed legado de 2 campos {prNumber,mergedBranch} tratado como fresh (sem migracao, sem schemaVersion). requires:US-00X usado pra encodar dependencia entre stories (auditor confirmou schema-valido: PrdSnapshot.requires e string|null, decideNextAction so trata 'operator' especial; ordem tambem por priority).
- **Blockers encountered**: Auditor APPROVE round 1 (0 critical/important, 2 suggestions cosmeticas de wording nao aplicadas). Review round 1 FIXES_PENDING:2 (2 WARNINGs reais que o two-layer pegou: evento estruturado merge-watch-watching nao emitido no novo path; comentario de contrato stale invertido pelo US-003), 2 fix-stories US-R1-001/002, round 2 CLEAN. Loop self-drove plan->US-001..004->review->2 fixes->CLEAN com zero re-arm; ci-gated post-merge autonomo. Nada landou no main entre PR-open e merge, entao nao ficou BEHIND (ao contrario do CAM-132/#98).
- **Follow-ups**: (1) REBUILD+RESTART do sidecar pra ativar o CAM-138 de fato: o codigo novo do merge-watch esta no main (v0.27.0) mas o sidecar rodando e 0.24.0 (watch in-memory antigo, behavior-coerente). Instalado 0.25.0. (2) 2 SUGGESTIONs do review round 1 deferidas: writeMergeWatchState nao e best-effort (erro de FS num tick podia propagar pelo await desprotegido e crashar o outer loop, ironico num PR de hardening); runMergeWatch agora e dead-code de producao (so testes referenciam, knip nao pega, classe F-05 do CAM-133). (3) Gap do CAM-137 (writeIssueFile em src/issues/alloc.ts:90 nao chama syncWorktreeIfOnMain, e o 7o writer fora do choke-point commitTreeToMain): vivido no filing do CAM-141, ainda NAO filado (operador nao confirmou). (4) Proximo por rank: CAM-82 (rank 5).

## cam/CAM-82-run-claude-auth-preflight — cam run verifica auth Claude no startup antes do loop

- **Started**: 2026-06-29
- **Closed**: 2026-06-29
- **Branch**: cam/CAM-82-run-claude-auth-preflight
- **Issue**: CAM-82
- **Outcome**: shipped
- **Summary**: cam run agora roda um preflight de auth no startup ANTES de subir session/sidecar/panes. checkClaudeAuth (spawn injetavel) roda `claude auth status --json`, hard-gate em loggedIn===true, fail-closed (exit nao-zero / stdout unparseable / claude ausente / loggedIn:false -> mensagem clara e sai sem subir o loop); subscriptionType informativo. Mata o failure mode antigo (worker-pane morto silencioso pre-sessao + 3min de no-progress backoff sem mensagem util). 2 stories, review CLEAN round 1, 2215 pass / 0 fail, check:all verde. PR #101, v0.28.0.
- **Decisions**: Probe resolvido AO VIVO como `claude auth status --json` (retorna {loggedIn,subscriptionType,...}, exit 0 logado), NAO `claude --version` (que o spec hand-waveou mas nao checa auth), nem `claude -p` (proibido no projeto). Gate roda antes do early-return do CAM_RUN_DRY_RUN, entao dry-run tambem valida auth. SpawnFn DI seam reusado (padrao do init.ts validateClaude, nao status.ts como o spec dizia errado). subscriptionType so informativo (nao hard-gate em valores validos desconhecidos).
- **Blockers encountered**: Nenhum em runtime: loop self-drove US-001->002->review CLEAN round 1, zero re-arm. Auditor APPROVE round 1 (0 critical/important, 1 suggestion nao-bloqueante: a AC do US-002 nao FIXA o gate antes do dry-run early-return, mas as notes cobrem). PRIMEIRO ciclo no sidecar 0.27.0 (rebuildado+restartado mid-sessao): VALIDOU O CAM-138 ao vivo. O merge-watch foi enriquecido com pollCount/lastPolledAt (state machine duravel em vez do eager-delete+in-memory do 0.24.0), o arquivo foi removido no terminal, e o post-merge rodou EXATAMENTE 1x (1 linha v0.28.0 no supervisor.log, sem o double 'tag created'/'tag existed' dos ciclos antigos). Confirma o fix do CAM-138 em producao.
- **Follow-ups**: Pendencias da sessao: (1) 2 SUGGESTIONs do CAM-138 (writeMergeWatchState nao best-effort; runMergeWatch dead-code de producao). (2) CAM-142 (gap do CAM-137: writeIssueFile sem syncWorktreeIfOnMain) filado, aguarda priorizacao. (3) Binario instalado + sidecar agora 0.27.0; main e 0.28.0 (CAM-82 toca so run.ts startup, behavior-coerente; rebuild pra 0.28.0 opcional). (4) Proximo por rank: CAM-126 (rank 6, doc build-release.sh ponteiro stale) ou CAM-134 (rank 7, dead-code buildMergeDescription).

## cam/CAM-126-lessons-archive-pointer — build-release.sh repointa lessons.md para lessons.archive.md

- **Started**: 2026-06-29
- **Closed**: 2026-06-29
- **Branch**: cam/CAM-126-lessons-archive-pointer
- **Issue**: CAM-126
- **Outcome**: shipped
- **Summary**: DOC-only (1 linha): o comentario em scripts/build-release.sh:108 apontava pro lessons.md aposentado no CAM-123 (renomeado pra lessons.archive.md). CAM-123 deliberadamente nao editou .sh (AC#7), entao o ponteiro stale ficou (SUGGESTION nao-bloqueante do reviewer do CAM-123). Repointado. 1 story, review CLEAN round 1, 2215 pass, check:all verde. PR #102, v0.29.0.
- **Decisions**: Premissa verificada AO VIVO antes de planejar (nao stale como o CAM-130): grep confirmou 1 ref bare lessons.md na linha 108 e lessons.md inexistente. Oracle discriminante: grep -Eq '(^|[^.])lessons\.md' (fails-at-HEAD, e lessons.archive.md nao satisfaz falsamente) + count==1.
- **Blockers encountered**: Nenhum: loop self-drove US-001 + review CLEAN round 1, zero re-arm. Post-merge rodou 1x (CAM-138 holding, 2o ciclo consecutivo validando o state machine). Nit: bump classificou minor (0.28->0.29) porque o commit do fix usa o template feat: do implementer, mesmo sendo doc-only (comportamento deterministico do classifyBump; nao intervim).
- **Follow-ups**: Pendencias da sessao inalteradas: CAM-142 (gap CAM-137) + 2 SUGGESTIONs do CAM-138 aguardam priorizacao. Proximo por rank: CAM-134 (rank 7, dead-code buildMergeDescription em issue-specify.ts), depois CAM-80 (rank 8), CAM-129 (rank 9).

## cam/CAM-134-remove-dead-buildmergedescription — remove dead code buildMergeDescription de issue-specify.ts

- **Started**: 2026-06-29
- **Closed**: 2026-06-29
- **Branch**: cam/CAM-134-remove-dead-buildmergedescription
- **Issue**: CAM-134
- **Outcome**: shipped
- **Summary**: Cleanup cirurgico: removida a funcao buildMergeDescription (src/commands/issue-specify.ts:261), definida mas nunca chamada (mergeIssueOnMain monta a nota de merge inline em :532). Pre-existente em main, flagada como SUGGESTION fora-de-escopo no review do CAM-133. Escapava do knip (knip.json exclui exports) e do tsc (noUnusedLocals:false) por ser privada. Behavior-neutra. 1 story, review CLEAN round 1, 2215 pass, check:all verde. PR #103, v0.30.0.
- **Decisions**: Premissa verificada ao vivo: grep confirmou 1 hit (so a definicao), zero callers. Oracle discriminante: ! grep -rq buildMergeDescription src/ test/ (fails-at-HEAD) + check:all (o gate que originalmente perdeu o dead code). Nit recorrente: bump minor porque o commit do implementer usa template feat:, mesmo sendo cleanup.
- **Blockers encountered**: Nenhum: loop self-drove US-001 + review CLEAN round 1, zero re-arm. Post-merge 1x (CAM-138 holding, 3o ciclo consecutivo). 5o ship consecutivo clean na sessao.
- **Follow-ups**: Pendencias inalteradas: CAM-142 (gap CAM-137) + 2 SUGGESTIONs do CAM-138. Proximo por rank: CAM-80 (rank 8, geometria do worker-pane openPaneInSession), depois CAM-129 (rank 9, cam init non-TTY no build smoke).

## cam/CAM-80-deterministic-worker-pane-geometry — geometria deterministica do worker-pane (pane explicito + tamanho)

- **Started**: 2026-06-29
- **Closed**: 2026-06-30
- **Branch**: cam/CAM-80-deterministic-worker-pane-geometry
- **Issue**: CAM-80
- **Outcome**: shipped
- **Summary**: openPaneInSession criava o worker-pane via split-window -t <session>:0 -v (mira a JANELA, sem flag de tamanho), entao o tmux splitava o pane ATIVO 50/50; num recreate com a dashboard ativa o worker nascia 49x24 ilegivel. Fix: mira o pane explicito do orquestrador (getOrchPaneId, resolvido local no host.ts) com -l 60%, deterministico em create e recreate independente do pane ativo. Pre-req do CAM-65 (que torna todo dispatch um recreate). 2 stories, review CLEAN round 1, 2216 pass, check:all verde. PR #104, v0.31.0.
- **Decisions**: Planner corrigiu o spec: UNICO call site de producao e host.ts ensureWorkerPaneFn (run.ts NAO cria o worker pane; loop.ts:278 e so JSDoc), entao 1 site a threadar, nao 2; orch pane id resolvido local via getOrchPaneId, sem plumbing novo por run.ts/CreatedPaneIds. Geometria: split vertical, worker pega ~60% (precedente -l <size> ja existe no dashboard split de ensureProjectSession). tmux 3.6a aceita -l 60% (man page + officialDocsConsulted). US-002 = teste REAL-tmux OS-gated (display-message), NAO argv-shape fake (licao CAM-55 'fakes mentem'): ativa pane nao-orquestrador, recria o worker, assert geometria canonica.
- **Blockers encountered**: Nenhum: loop self-drove US-001->002->review CLEAN round 1, zero re-arm. Post-merge 1x (CAM-138 holding, 4o ciclo consecutivo). 6o ship consecutivo clean. Auditor APPROVE round 1 (0 critical/important, 1 suggestion F-01 DEFERIDA: o fallback do getOrchPaneId==null nas notes oferece <session>:0, que reintroduziria o bug no path degradado raro; reviewer e backstop, core path testado).
- **Follow-ups**: Pendencias: CAM-142 (gap CAM-137), 2 SUGGESTIONs do CAM-138, e agora F-01 do CAM-80 (fallback determinismo no path orch-pane-ausente). CAM-65 (fecha worker-pane ocioso) agora desbloqueado pelo CAM-80. Proximo por rank: CAM-129 (rank 9, cam init crasha non-TTY/Ink raw mode no build smoke + dup), depois CAM-92 (rank 15, extrair narrateReport helper).

## cam/CAM-129-init-rawmode-guard — init/setup stdin raw-mode gate + build-smoke soft-check honesty

- **Started**: 2026-06-29
- **Closed**: 2026-06-30
- **Branch**: cam/CAM-129-init-rawmode-guard
- **Issue**: CAM-129
- **Outcome**: shipped
- **Summary**: Gated cam init/setup interactivity on stdin raw-mode (not only stdout.isTTY) so the Ink useInput path degrades to the print/readline fallback in non-TTY-stdin contexts (the hermetic build smoke), fixing the Raw mode is not supported crash. Also made build-release.sh soft-check distinguish a missing claude prerequisite from a genuine init crash. Shipped as v0.32.0 via PR #105.
- **Decisions**: Gate extracted to an exported pure predicate so tests assert the non-interactive branch without touching real process streams. US-002 (duplicate React key) closed as already-clean: the warning does not reproduce in these screens (static JSX siblings reconcile positionally; the only dynamic render, checks.map, already uses unique ids). US-R1-001 corrected the false patterns.md entry that US-002 had introduced.
- **Blockers encountered**: Review round 1 flagged US-002 as a no-op fix (adding keys to static siblings cannot affect the same-key warning, verified via React docs + live ink-testing-library repro). Resolved by fix-story US-R1-001 (close as already-clean + correct the pattern entry); review round 2 CLEAN.
- **Follow-ups**: Next in rank: CAM-92 (narrateReport helper, rank 15). Still open from prior cycles: CAM-142 (gap CAM-137), CAM-138 SUGGESTIONs (writeMergeWatchState best-effort, runMergeWatch dead-code), CAM-80 F-01 (orch-pane-absent determinism fallback).

## cam/CAM-142-writeissuefile-worktree-sync — writeIssueFile worktree sync (7th on-main writer routed through syncWorktreeIfOnMain)

- **Started**: 2026-06-30
- **Closed**: 2026-06-30
- **Branch**: cam/CAM-142-writeissuefile-worktree-sync
- **Issue**: CAM-142
- **Outcome**: shipped
- **Summary**: Closes the staged-deletion footgun (class CAM-121/68) for the 7th on-main writer. writeIssueFile (src/issues/alloc.ts, the CAM-90 CAS primitive) has its own commit loop (read-tree main, hash-object, write-tree, commit-tree, update-ref) and returned on success without ever calling syncWorktreeIfOnMain, so filing an issue with main checked out left a staged-deletion (D scripts/cam/issues/CAM-XXXX.json) in the working tree. CAM-137 had wired the sync only inside commitTreeToMain, covering the 6 choke-point writers but not this 7th. Fix: add syncWorktreeIfOnMain to the existing on-main.ts import and call it unconditionally after the successful CAS, mirroring commitTreeToMain:347. 1 story, 2230 pass / 0 fail, check:all green, review CLEAN round 1. Shipped as v0.33.0 via PR #106.
- **Decisions**: 1-story scope (operator declined the optional recovery-runbook/observability extras). Call syncWorktreeIfOnMain unconditionally with no call-site branch==main gate: the helper self-detects HEAD via git rev-parse and returns early when not on main (on-main.ts:254), so the gate would be redundant. Regression placed in test/integration/ (real-git harness) not test/issues/ (the issue's loose hint), mirroring issue-file-on-main.test.ts Case B + sync-worktree-on-main.test.ts porcelain-clean invariant.
- **Blockers encountered**: None at runtime: the loop self-drove plan-approval through US-001 to review CLEAN round 1 with ZERO manual re-arm, and the CLEAN verdict reached the orchestrator via send-keys live. The fix surfaced an expected side effect the worker handled: issue-specify-ref-only.test.ts had a toBe(false) worktree-state precondition that pre-dated the sync and was flipped to toBe(true).
- **Follow-ups**: Reviewer flagged 3 SUGGESTION-level stale comments in test files: issue-file-on-main.test.ts (in-scope, comment now contradicts the synced behavior) plus triage-ref-only.test.ts and journal-ref-only.test.ts (pre-existing, ref-only paths not touched by US-001). None required (review CLEAN); candidate for a low-priority comment-cleanup follow-up. Post-merge rebuild + reinstall so the installed binary carries the CAM-142 fix. CAM-65 (reviewer pane lingers post-CLEAN) hit again (pane %14), harmless.

## cam/CAM-144-fast-track-plan-ready — fast-track plan-ready: derived/operator issues skip the grill (Option Y + specSource)

- **Started**: 2026-06-30
- **Closed**: 2026-06-30
- **Branch**: cam/CAM-144-fast-track-plan-ready
- **Issue**: CAM-144
- **Outcome**: shipped
- **Summary**: Grill-exempt fast-track for the issue system: issues born plan-ready (derived fixes, operator nice-to-haves) file directly at stage:specified with a specSource discriminator (grill|derived|operator), reaching /cam-plan without the grill, while the grill stays the path for ambiguous ideas. Representation = Option Y: specified redefined as plan-ready (grill is one path); the 3 plannability filter sites (select/rank/gate) and the ranker stay unchanged. WSJF resolved at filing (explicit stdin wins, else overridable inherit from --derived-from parent, refuse if unresolvable). All 4 guardrails hard pre-commit (schema if/then + filing-path validation). ADR 0002 records the two-door decision, revising ADR 0001/CAM-107. 5 stories (US-001..004 + US-R1-001), check:all green, shipped as v0.34.0 via PR #107.
- **Decisions**: Design fully grilled this session (Q1-Q7), see CAM-0144.json spec. Option Y over X (flag): keeps the 3 filter sites + ranker untouched, pays semantic cost (specified now means plan-ready) instead of spreading predicate logic. specSource is a TOTAL discriminator (absent⟹grill back-compat). WSJF inheritance is a SUGGESTED DEFAULT, overridable (not binding). Fast-track set ONLY via explicit --fast-track/--derived-from flags, no content-heuristic auto-marking; reviewer-SUGGESTION auto-filer deferred as separate follow-up. ADR numbered 0002 (0001 already existed; revises not overwrites).
- **Blockers encountered**: Full autonomous run after the operator authorized it: plan -> auditor BLOCK (1 critical: no check:all in any story; 2 important: missing Option-Y filter-sites-unchanged invariant oracle, single-token greps under-verifying) -> applied 4 findings via the same planner agent -> re-audit APPROVE -> branch -> cam next -> 4 stories + 1 fix drained by the sidecar with ZERO manual re-arm. Review round 1 FIXES_PENDING:1 caught a real WARNING: the US-004 ADR recorded the WSJF-inheritance decision BACKWARDS (labeled hard-binding, listed overridable as rejected) vs the grilled Q2 decision + impl + PRD + patterns + test; fixed in US-R1-001 (ADR-only, 2 lines), round 2 CLEAN. Only manual touch: killed the lingering reviewer pane (CAM-65) before dispatch and before ship.
- **Follow-ups**: Reviewer SUGGESTION deferred: parseIssueArgs accepts --derived-from "" (empty) and degrades to stage:idea instead of erroring (index.ts:627, low risk, fast-track candidate now). CAM-145 (bake recommend-on-merits clause into the grill-with-docs wrapper + cam-plan Step 6) and CAM-143 (post-merge false prune warning + narration stuck-in-input) are now fast-track-eligible via this feature. Autonomy map: cross-cycle drainer still needs CAM-71 (auto-ship), CAM-117 (deterministic plan runner), CAM-139 (inter-cycle auto-dispatch), with CAM-111/116 as safety gates. CAM-65 (reviewer pane lingers post-CLEAN) hit twice this cycle.

## cam/CAM-143-postmerge-prune-narration — post-merge prune end-state + narration coalesce

- **Started**: 2026-06-30
- **Closed**: 2026-06-30
- **Branch**: cam/CAM-143-postmerge-prune-narration
- **Issue**: CAM-143
- **Outcome**: shipped (PR #108, v0.35.0, merged, tagged)
- **Summary**: Corrigiu dois defeitos do post-merge: BUG A (falso warning 'remote: FAILED' a cada ship) agora classifica prune por end-state nos dois legs (git ls-remote / git rev-parse) e troca o delete local p/ git branch -D (cam faz squash); BUG B (race de narracao consecutiva) coalescido numa unica linha do notifyOrchestrator. Mais o invariante no patterns.md. 4 stories, 2287 pass / 0 fail, review CLEAN no round 1.
- **Decisions**: A1 (classificacao por end-state) sobre A2 (scrape de stderr do git, fragil); B1 (coalesce determinista) sobre B2/B3 (settle-delay/debounce heuristicos). -d -> -D local porque o cam squash-merge nunca deixa a branch ancestral da main.
- **Blockers encountered**: Auditor round 1 BLOCK: o oracle do US-003 AC2 era nao-discriminante (grep -L sobre FD de process-substitution sempre exit 0). Fixado p/ forma com temp file; round 2 APPROVE com 1 important (F-02: os fakes de post-merge.test.ts precisavam modelar ls-remote/rev-parse/-D senao false-green), aplicado nos notes de US-001/US-002.
- **Follow-ups**: O proprio ship do CAM-143 ainda exibiu o race do BUG B (o /cam-ship do autoShipFn foi engolido; o orquestrador shipou proativo) porque o sidecar rodando e 0.33.0; o fix do CAM-143 so vale apos rebuild+reinstall+restart do sidecar. CAM-65 (reviewer pane lingering pos-CLEAN) bateu de novo (matei o %16 na mao). Chain autonomo segue p/ CAM-145, depois os epics (CAM-111/117/116/149).

## cam/CAM-145-recommend-by-merit — recommend by engineering merit not execution cost (3 cam-owned surfaces)

- **Started**: 2026-06-30
- **Closed**: 2026-06-30
- **Branch**: cam/CAM-145-recommend-by-merit
- **Issue**: CAM-145
- **Outcome**: shipped
- **Summary**: Baked a rename-neutral 'recommend by engineering merit, not execution cost' clause into 3 cam-owned recommendation surfaces so every cam user inherits it (not just Eduardo's sessions): grill-with-docs/SKILL.md (spec-interview recs), cam-plan.md Step 6 (scope/story recs), subagent-orchestrator.md Output style (general-conversation recs). Each is a dual-copy (.claude/ + templates/) feeding the embed (_generated.ts); plus a parity test in embedded.test.ts (CAM-49/68/79 class) asserting the clause in the embedded shipped copies. 2 stories, review CLEAN round 1, auditor APPROVE round 1 (0 critical/0 important/1 suggestion). Shipped as v0.36.0 via PR #109. Product counterpart of the Plan-First recommend-on-merits rule already in Eduardo's global CLAUDE.md.
- **Decisions**: English text (shipped artifacts are English). Clause is rename-neutral (uses 'recommendation', no 'grill' vocabulary) so CAM-146 (grill to spec rename) rebases clean. Vendored /grilling and /domain-modeling skills left untouched (editing them drifts from mattpocock upstream); the cam-specific guidance lives in the grill-with-docs wrapper we own. cam-plan.md's two copies were NOT byte-identical (per cam-dual-copy-is-per-file), so the clause was inserted per-copy at the Step 6 anchor rather than byte-copied; grill-with-docs and orchestrator copies were identical.
- **Blockers encountered**: None at runtime. First cycle on the freshly rebuilt+reinstalled 0.35.0 binary + restarted sidecar (pid 36379, replacing the stale 0.33.0 pid 10132): the CAM-143 post-merge fixes were confirmed live, no false remote-prune warning and post-merge narration coalesced cleanly across two report lines. autoShip did NOT auto-fire /cam-ship on review CLEAN; the loop reset to active:false and the /cam-ship injection only arrived as a post-merge no-op (heavily delayed), so the orchestrator killed the lingering reviewer pane (CAM-65) and shipped proactively as before. Sidecar post-merge lagged ~80s+ behind the GitHub merge (poll cadence) but completed cleanly.
- **Follow-ups**: autoShip timing: even on the 0.35.0 sidecar the /cam-ship injection arrived too late to be useful (post-merge no-op); proactive orchestrator ship remains required. Investigate whether autoShip is expected to fire on review CLEAN and why it lags (relates to CAM-71/CAM-143 bug B area). CAM-65 (reviewer pane lingers post-CLEAN) recurred again (killed %17 by hand before ship). Auditor SUGGESTION F-01: US-001 AC8 rename-neutrality oracle only scans subagent-orchestrator.md, a weak proxy; candidate to widen the negative grep to all 3 edited files. Next in the autonomous chain by order: CAM-111 (worker isolation, local devcontainer), then CAM-117 (deterministic plan-runner), CAM-116 (behavioral verification), CAM-149 (deterministic ship-runner); CAM-139 (inter-cycle auto-dispatch) last. Consider that CAM-111/117/116 are jobSize-3 epics likely to exceed the 3-round review cap (expect re-plan/split).

## CAM-111 — worker isolation dev-container + egress firewall (Half A)

- **Started**: 2026-07-01
- **Closed**: 2026-07-01
- **Branch**: cam/CAM-111-worker-container
- **Issue**: CAM-111
- **Outcome**: shipped (PR #110, v0.37.0)
- **Summary**: Half A of the worker-isolation epic. Added .devcontainer (Dockerfile + devcontainer.json + init-firewall.sh): the cam worker runs non-root with pinned claude-code@2.1.197 behind an egress default-deny firewall allowlisting exactly 7 domains, NET_ADMIN/NET_RAW caps, workspace bind mount, and a named ~/.claude volume. Also added an exported-but-uncalled preflightWorkerContainer() helper (unit-tested, mocked docker) and ADR 0003 + recovery-runbook section (x). Additive only: zero change to the live worker-spawn path. 5 stories; review 2 rounds, CLEAN.
- **Decisions**: Split CAM-111 into 2 sequential PRs on engineering merit to stay inside the 3-round review cap (spec gotcha #8 predicted it; handoff anticipated the split): this PR = Half A (inert isolation artifact + verification); Half B deferred to CAM-150. File-assert oracles cannot verify Docker buildability (CI is macos-latest, no Docker), so the reviewer caught the CRITICAL (oven/bun:slim ships no npm, breaking the pinned-CLI install) by reasoning about the base image; real image-build + live-firewall smoke is an operator/Half-B ceremony, not a CI gate.
- **Blockers encountered**: None at runtime. Auditor BLOCKed the plan once (US-005 targeted an already-used runbook section letter t; retargeted to x, plus a firewall exact-7 count oracle). Review round 1 raised 1 CRITICAL (bun:slim base has no npm) + 3 WARNINGs (firewall tooling/sudo missing; workspace mount path unresolved; ADR/runbook described a non-existent cam-worker user); all four fixed in the round-1 fix pass (one scoped fix-story per finding), CLEAN round 2.
- **Follow-ups**: CAM-150 filed (idea, main 47b3f84): Half B: route the worker spawn through the container, fail-closed no-host-fallback, GITHUB_TOKEN + CLAUDE_CODE_OAUTH_TOKEN wiring, live green-story validation; safety net for live full-autonomy (P1-worthy); needs /cam-spec then /cam-plan. NO sidecar rebuild after this ship (Half A is inert: preflight uncalled, nothing wired); rebuild+reinstall+restart only when CAM-150 ships since it wires the spawn. autoShip again did not fire on CLEAN (killed lingering reviewer pane CAM-65 + shipped proactively). Minor bug to file: cam journal append (0.35.0) throws TypeError (A.replace) when decisions/blockers/followups are arrays; it must be strings, should coerce or reject cleanly.

## cam/CAM-117-plan-runner — deterministic plan-phase runner (Half A)

- **Started**: 2026-07-01
- **Closed**: 2026-07-01
- **Branch**: cam/CAM-117-plan-runner
- **Issue**: CAM-117
- **Outcome**: shipped (PR #111, v0.38.0, merged+tagged)
- **Summary**: Half A of CAM-117: converts the plan phase from LLM-interpreted markdown into a deterministic TS runner (runPlanPhase) driven by the sidecar, mirroring loop.ts. Deterministic pre-flight, pick-issue via selectPlannableFromFile (CAM-106), spawn planner + auditor as TUI worker-panes (never Task, never claude -p), read the structured verdict from a handback file (plan-verdict-report.json, not scrollback), and on APPROVE + plan_approval=auto (decidePostAuditAction, CAM-109) commit PRD + branch + flip active:true for the existing loop.ts to assume implement to review to ship. Incremental: runSupervisor untouched. New module plan-verdict-report.ts + plan-argv.ts + plan-preflight.ts + plan-runner.ts + ADR 0004; auditor prompt made to emit the verdict file (self-hosting dual-copy edit). 9 stories (7 planned + 2 review fixes), 2439 pass, check:all green.
- **Decisions**: Split CAM-117 into 2 sequential PRs on engineering merit (spec gotcha #6 + prd-size-vs-review-convergence): Half A = runner skeleton + planner/auditor worker-pane spawn + happy-path auto-mode; Half B deferred to CAM-151 (BLOCK to re-plan loop, plan_approval=operator full-PRD gate, in-progress-work escalation, cam-plan.md reduced to thin phase-signal). PlanVerdictReport interface aligned to the auditor's real output schema (description not text, carries id/category/suggestion + top-level summary) per auditor F-01 so findings round-trip into Half B without a schema change. Half A escalates to operator on auditor BLOCK; no auto re-plan yet. Runner is INERT at runtime (nothing in the live sidecar/loop path calls runPlanPhase; cam-plan.md still owns the plan phase) so no sidecar rebuild is needed to continue the chain.
- **Blockers encountered**: None at runtime. Auditor APPROVEd round 1 (0 critical / 0 important / 1 suggestion F-01, applied pre-branch via the planner agent). Review round 1 FIXES_PENDING:2: a CRITICAL (planner poll only broke on pane death, but interactive TUI workers do not self-exit, so the happy path would loop until the 30-min timeout and never spawn the auditor; tests masked it by simulating pane death after one tick) and a WARNING (ADR 0004 contradicted the code). Both fixed via one fix-story each (US-R1-001 breaks the poll on the report-file being written mirroring makeReviewDispatch; US-R1-002 corrects the ADR), CLEAN round 2. Two SUGGESTIONs not re-raised.
- **Follow-ups**: CAM-151 (Half B) is next in the plan-runner arc: gates + BLOCK to re-plan loop + escalation + cam-plan.md thin phase-signal; stage:idea, needs /cam-spec then /cam-plan. SUGGESTION (plan-runner.ts:407): the auditor pane is left alive on success so the Half B loop wiring must own teardown. autoShip again did not fire on review CLEAN (killed lingering reviewer pane %19 per CAM-65, shipped proactively; the delayed /cam-ship injection arrived as a no-op). cam journal append (0.35.0) still throws TypeError when decisions/blockers/followups are arrays (pass strings). Next autonomous candidates already specified: CAM-149 (deterministic ship-runner) or CAM-116 (behavioral verification in the loop).

## cam/CAM-150-worker-container-substrate — worker isolation substrate (Half B, part 1)

- **Started**: 2026-07-01
- **Closed**: 2026-07-01
- **Branch**: cam/CAM-150-worker-container-substrate
- **Issue**: CAM-150
- **Outcome**: shipped (PR #112, v0.39.0, merged+tagged)
- **Summary**: B-1 (substrate) of CAM-150 worker-isolation Half B. Adds the substrate for running cam workers inside the fail-closed dev container without yet flipping the live spawn: a new src/supervisor/worker-container.ts (docker build + one long-lived docker run argv builder carrying the devcontainer.json runArgs/mounts/volume/--user bun/containerEnv + name-only -e GITHUB_TOKEN/-e CLAUDE_CODE_OAUTH_TOKEN credential threading, injectable spawnFn); a parity test asserting the TS docker-run args match .devcontainer/devcontainer.json; container git HTTPS + x-access-token credential config (no ~/.ssh, no host cred file); a DNS-based firewall rewrite (dnsmasq + ipset dynamic matching) so CDN hosts survive IP rotation, with the LFS host fixed to objects.githubusercontent.com; preflightWorkerContainer() wired into the dispatch decision point (observed/logged, gates nothing live yet); docs (recovery-runbook credential + firewall + ADR 0003 extension). Additive/inert like CAM-111 Half A: the live worker spawn path is UNCHANGED (workers still spawn on host). 7 stories (6 + 1 review fix), 2517 pass, check:all green.
- **Decisions**: Split CAM-150 into B-1 (substrate) + B-2 (flip-spawn) at plan time on engineering merit (grilled spec gotcha; jobSize-3; mirrors CAM-111/CAM-117). B-2 filed as CAM-152 (idea, grilled scope in its description) BEFORE branching (CAM-121 guard clean); it will be specified autonomously from the grilled design and flips the spawn (docker exec wrap of the 4 dispatch sites) + fail-closed + live-validation + the sidecar rebuild-gate. Credentials provisioned by the operator this session (fine-grained repo-scoped GITHUB_TOKEN + CLAUDE_CODE_OAUTH_TOKEN) in a gitignored .env; Bun auto-loads them into the sidecar process.env and the container gets them via docker run -e. Firewall is DNS-based (dnsmasq) not dig-once-freeze, chosen because the long-lived container makes CDN IP rotation certain. B-1 is inert at runtime so NO sidecar rebuild is needed on this merge (rebuild is B-2's gate).
- **Blockers encountered**: None at runtime. Auditor APPROVEd round 1 (0 critical / 1 important F-01 + 2 suggestions, all applied pre-branch via the planner: F-01 made the firewall allowlist oracle discriminating, F-02 clarified the dnsmasq github.com/*.github.com fold, F-03 forbade the git credential.helper store). Review round 1 FIXES_PENDING:1 caught a real egress-security WARNING: the implementer let ALLOWED_DOMAINS (echo/self-verify only) drift from the real dnsmasq --ipset directives, so the reachable set was 8 hosts (raw.githubusercontent.com added) not the required 7, and the test only parsed the decorative array. Fixed in US-R1-001 by making the --ipset directives + array + runbook + test REQUIRED_HOSTS a single source of truth, with the firewall test asserting host-set equality against the parsed --ipset directives (drop OR add fails). CLEAN round 2.
- **Follow-ups**: CAM-152 (B-2 flip-spawn) completes the CAM-150 isolation: wrap the 4 dispatch sites in docker exec -it, fail-closed no-host-fallback (preflight-before-dispatch + exec-failure catch -> escalateFn+blocked), live-validation (requires:operator, ties into CAM-116), REBUILD-GATE. On engineering merit the spawn-flip (B-2) is best deferred until just before CAM-139 (the unattended drainer) since it is disruptive (all worker spawns become containerized) and its live-validation is an operator gate, while the intermediate runner epics (CAM-116/151/149) can run on the proven host-spawn path. autoShip again did not fire on review CLEAN (killed lingering reviewer pane %20 per CAM-65 + shipped proactively). Deterministic-drainer B-trail remaining: CAM-116 (behavioral verification), CAM-151 (plan-runner live), CAM-149 (ship-runner), CAM-152 (B-2 spawn-flip), CAM-139 (drainer, last). Drainer-ready when CAM-151 + CAM-149 + CAM-152 are shipped.

## cam/CAM-116-behavioral-verification-gate — behavioral verification gate in the loop

- **Started**: 2026-07-01
- **Closed**: 2026-07-01
- **Branch**: cam/CAM-116-behavioral-verification-gate
- **Issue**: CAM-116
- **Outcome**: shipped (PR #113, v0.40.0, merged+tagged)
- **Summary**: Gives the loop the ability to RUN behavioral verification (drive the real cam system in a tmux session and assert the per-story CAM-109 behavioral oracle), not just unit tests. Refines the CAM-56 two-layer: the behavioral gate is a SHARED runnable, not a worker-exclusive capability. New src/supervisor/behavioral-gate.ts (parse the per-story oracle + the shared runnable that drives real cam in a private-socket tmux session, captures the pane, asserts the oracle, built ON the existing test/integration tmux-real harness). The implementer runs it at Layer A to self-correct (not official); the reviewer re-runs independently at Layer B and writes the capture-pane as the artifact-of-record (referenced from review-report.json), and a reviewer gate-fail is a hard-constraint FAIL feeding the existing 8-criteria + buildFixStories path -> FIXES_PENDING. At ship the artifact-of-record is posted to the PR as a labeled gh pr comment (never committed). ADR 0005. 7 stories, 2556 pass, check:all green, review CLEAN round 1.
- **Decisions**: Single cohesive PR (7 stories, no split; the 8 ACs mapped to ~7 stories under the cap). Gate BUILT ON test/integration/ tmux-real (not a from-scratch driver) per the spec + the anti-shadow-mock lesson. Reviewer write-exception widened to name BOTH review-report.json AND the artifact file (F-01, dual-copy + embed). Artifact-post placed BEFORE the merge-mode branch in cam-ship.md so it runs on the ci-gated path too (F-02, load-bearing: ci-gated ends with Skip Step 9). REVIEW_ARTIFACT_FILENAME pinned to scripts/cam/review-artifact.txt as a single source string (F-03). Web-downstream tooling (playwright/agent-browser image artifacts) explicitly deferred to a follow-up (recorded in ADR 0005). Host-spawn scope: activates on the host path; whether the tmux gate runs under the worker container (unix-socket/seccomp) is a CAM-152 concern, deferred.
- **Blockers encountered**: None at runtime. Auditor APPROVEd round 1 (0 critical / 2 important F-01+F-02 + 1 suggestion F-03, all applied pre-branch via the planner). Review CLEAN round 1 (first-round clean). No bootstrap paradox: the behavioral gate code lands in this branch but the running 0.35.0 sidecar reviewed CAM-116 with its existing logic (the new gate only activates after a sidecar rebuild). autoShip again did not fire on CLEAN (killed lingering reviewer pane %21 per CAM-65 + shipped proactively).
- **Follow-ups**: The behavioral gate is INERT on the running 0.35.0 sidecar (only activates after rebuild) so NO rebuild was needed on this merge; the gate goes live when the sidecar is rebuilt (batch with CAM-152 / the drainer). Deterministic-drainer B-trail remaining: CAM-151 (plan-runner live, next), CAM-149 (ship-runner), CAM-152 (B-2 worker-container spawn-flip, deferred to just before the drainer), CAM-139 (drainer, last). Drainer-ready when CAM-151 + CAM-149 + CAM-152 are shipped. Session note: 3 PRs shipped this session (CAM-117 Half A, CAM-150 B-1, CAM-116); context is large, a respawn before the complex CAM-151 would improve context quality.

## cam/CAM-151-plan-runner-make-live — plan-runner make-live (Half B/B-1)

- **Started**: 2026-07-01
- **Closed**: 2026-07-01
- **Branch**: cam/CAM-151-plan-runner-make-live
- **Issue**: CAM-151
- **Outcome**: shipped (PR #114, v0.41.0, merged+tagged; sidecar rebuilt to 0.41.0)
- **Summary**: CAM-151 B-1 (make-live): converts the plan phase into a LIVE deterministic sidecar-driven runner. Introduces a LoopPhase enum (idle|planning|implementing|awaiting-operator|shipping) in .claude/cam-loop.local.md as the single source of truth; the legacy active bool now DERIVES from phase==='implementing' (all readActive/outer-loop consumers read the derived value). cam plan N writes a phase:planning signal (validating the specific issue N, F-01); the sidecar outer loop detects it and invokes runPlanPhase (the CAM-117 Half A skeleton, now wired live); on auditor APPROVE + plan_approval=auto the runner (runPostAuditAction) commits the PRD, creates the branch, and flips phase:implementing, handing off to the implement loop. Half A escalate-to-operator on BLOCK preserved (no auto re-plan). cam-plan.md reduced to a thin phase-signal stub (both copies + embed regen); ADR 0006 records the phase-enum state machine. 8 stories (5 + 3 review fixes), 2602 pass, check:all green.
- **Decisions**: Scoped strictly to B-1 (make-live) per the grilled split (spec gotcha #1); B-2 (gates cluster) filed as CAM-153 (stage:idea, grilled scope in its description) BEFORE branching (CAM-121 guard clean). Kept the CAM-117 incremental boundary: runSupervisor implement->review->ship logic untouched, only the SOURCING of the active gate changed (readActive derives from phase). Named the new enum LoopPhase (not Phase, which collides with src/config/models.ts:22) and the ADR 0006 (0005 was taken by CAM-116). plan_approval=auto path only; the operator-mode full-PRD gate is B-2.
- **Blockers encountered**: None at runtime. Auditor APPROVEd round 1 (0 critical / 0 important / 2 suggestions; F-01 tightened cam plan N to resolve the SPECIFIC issue N, applied pre-branch via the planner agent). Review round 1 FIXES_PENDING:2 caught two REAL criticals that green tests had masked: (1) the production plan closure called runPlanPhase but DISCARDED its result so runPostAuditAction was never invoked (APPROVE+auto never committed/branched/flipped, the plan phase never handed off); (2) the planning branch re-invoked runPlanPhase every 2s idle tick with no re-entry guard, busy-looping git/network indefinitely (and unbounded auto-re-plan on BLOCK). Both fixed (US-R1-001 wires runPostAuditAction into the production closure; US-R1-002 adds exitPhaseAfterPlan to transition phase out of planning on every non-branch outcome). Round 2 FIXES_PENDING:1 (WARNING: ADR 0006 went stale vs the R1 fix), fixed in US-R2-001. CLEAN round 3.
- **Follow-ups**: MANDATORY sidecar rebuild done post-merge: rebuilt+reinstalled to 0.41.0 and restarted (pid 93239); this ALSO activated the CAM-116 behavioral gate (inert on 0.35.0), so validate the FIRST post-rebuild review cycle (next epic) carefully. New sidecar validated idling clean (cam status=paused, no busy-loop). B-2 = CAM-153 (needs /cam-spec then /cam-plan). Two reviewer SUGGESTIONs to fold into CAM-153 spec: (a) plan_issue=N convergence: cam plan N validates issue N but the production runner still uses selectPlannableFromFile (top-of-queue), so cam plan 42 may plan a different issue; (b) wrap runPlanPhaseFn in try/catch forcing phase->idle on a git-failure crash (crash-then-restart could re-enter planning). autoShip again did not fire on CLEAN (killed lingering reviewer pane %23 per CAM-65 + shipped proactively). Deterministic-drainer B-trail remaining: CAM-149 (ship-runner, NEXT), CAM-152 (B-2 worker-container spawn-flip, deferred to just before the drainer), CAM-139 (drainer, last). Drainer-ready when CAM-149 + CAM-152 shipped (CAM-151 done).

## cam/CAM-155-plan-runner-hardening — plan-runner production hardening (worker-pane + crash-safety)

- **Started**: 2026-07-02
- **Closed**: 2026-07-02
- **Branch**: cam/CAM-155-plan-runner-hardening
- **Issue**: CAM-155
- **Outcome**: shipped (PR #115, v0.42.0, merged+tagged; sidecar rebuilt to 0.42.0)
- **Summary**: P0: the deterministic plan phase (CAM-151 make-live) never worked in production. The planner/auditor pane spawn assumed a worker-pane existed (respawn-pane -t %2 fallback) and never created one, so no claude session started; a stale plan-verdict-report.json was read as a fresh APPROVE, post-audit built an empty branch name, and git checkout -b (empty) crashed the sidecar (no try/catch). 5 stories: US-001 ensureWorkerPane before spawn plus per-worker out-log; US-002 clear stale verdict and prd at plan start; US-003 planner-no-prd escalates and never spawns the auditor; US-004 guard empty branchName; US-005 try/catch forces phase:idle so the sidecar survives. 2647 pass, check:all green, review CLEAN round 1 (first live CAM-116 behavioral gate; real-tmux pane-spawn oracle passed).
- **Decisions**: Discovered while attempting to plan CAM-154 (plan_issue targeting). The plan phase had never run in prod (CAM-151 was planned via the old flow). Bootstrapped the fix through the working implement loop: planner and auditor spawned via Task (bypassing the broken plan phase), auditor APPROVE 0crit/0imp. Reprioritized CAM-154 to rank:9 top-of-queue (plan_issue not yet honored). Kept plan_approval=auto.
- **Blockers encountered**: The sidecar crashed twice on the git-checkout-b-empty path before diagnosis. Neutralized by clearing the stale verdict and resetting phase:idle; a controlled retry confirmed the worker no-op was structural (missing ensureWorkerPane), not a transient rate-limit.
- **Follow-ups**: MANDATORY sidecar rebuild done (0.42.0, restarted, idling clean); the fix and the CAM-116 gate are now live. CAM-154 (plan_issue targeting, rank:9 top-of-queue) is next and cam plan should now work end-to-end. CAM-113 confirmed live: ship --finalize closed CAM-0 (parsed string issueNumber as int), so CAM-155 was closed manually (stage:shipped). CAM-156 filed: push-verification false-BLOCKED by stale expected-ref (US-005 push had landed; verification used the prior story HEAD). Drainer B-trail remaining: CAM-149 (ship-runner), CAM-152 (B-2 spawn-flip), CAM-139 (drainer).

## cam/CAM-154-plan-issue-targeting — plan_issue targeting (selector + reader)

- **Started**: 2026-07-02
- **Closed**: 2026-07-02
- **Branch**: cam/CAM-154-plan-issue-targeting
- **Issue**: CAM-154
- **Outcome**: shipped (PR #116, v0.43.0, merged+tagged)
- **Summary**: First end-to-end validation of the CAM-155 plan-phase fix: planner -> prd.json -> auditor APPROVE -> branch -> implement -> review CLEAN, all deterministic, worker-pane spawned for real. US-001 threaded plan_issue into the plan-runner selectIssueFn via a target-aware selector (selectPlannableById + selectPlanTargetFromFile) and a makeReadPlanIssue loop-state reader; never silent-falls-back to top-of-queue (returns null -> clean halt on a non-plannable target). 2684 pass, CLEAN round 1.
- **Decisions**: Planned via bare cam plan (CAM-154 was top-of-queue at rank 9). plan_approval=auto cascaded straight to ship. issueNumber came out as the STRING 'CAM-154'.
- **Blockers encountered**: Self-inflicted PR BEHIND: I closed CAM-154 on main by hand (CAM-113 workaround, since finalize closed the phantom CAM-0 because issueNumber was the string 'CAM-154') BEFORE the PR merged, which advanced main; cleared with gh pr update-branch. Sequencing lesson: do the manual close only AFTER merge, or fix CAM-113.
- **Follow-ups**: Dogfooding revealed CAM-154 shipped FUNCTIONALLY INCOMPLETE (fixed by CAM-157): the selector was threaded but the planner still ignores it. Auditor findings F-01 (bare-plan pins the CLI-time top id) and F-02 (distinct escalation for sidecar-rejected targets) folded into CAM-157 scope.

## cam/CAM-157-plan-runner-authoritative-target — plan-runner authoritative target (planner obeys the selected issue)

- **Started**: 2026-07-02
- **Closed**: 2026-07-02
- **Branch**: cam/CAM-157-plan-runner-authoritative-target
- **Issue**: CAM-157
- **Outcome**: shipped (PR #117, v0.44.0, merged+tagged; sidecar rebuilt to 0.44.0)
- **Summary**: Completes CAM-154. Root cause: runPlanPhase selected the target issue (selectIssueFn) but spawned the planner with the generic DEFAULT_PLANNER_TASK_PROMPT, so the subagent-planner re-selected top-of-queue and cam plan --issue N planned the WRONG issue. US-001 threads the selected issue.id into the planner task prompt and adds a real-tmux e2e regression test (plan-runner-target-obey) asserting prd.issueNumber == target: the gate that let CAM-154 ship broken (unit tests mocked selectIssueFn). US-002 makes subagent-planner honor an explicit target id (both .claude/ and templates/ copies + re-embed). 2695 pass, CLEAN round 1.
- **Decisions**: Filed as P1 (a shipped feature that did not work). Operator directive: no gambiarras, robust root-cause fix, shortcuts only to unblock. Planned via bare cam plan after ranking CAM-157 to rank 1: legitimate (it genuinely was the top priority; bare-plan picking top-of-queue is designed behavior, not a workaround for the broken --issue). issueNumber came out NUMERIC (157) -> finalize closed correctly, no CAM-113/BEHIND.
- **Blockers encountered**: First cam plan 121 attempt halted silently: runPlanPreflight clean-tree failed on 2 orphan .claude/cam-plan-out-*.log files left by the prior cycle (not gitignored). Isolated by probing the selector (correct) then reading the preflight. Filed CAM-158 (gitignore) and CAM-159 (preflight halt emits no event).
- **Follow-ups**: Validated in production after rebuild: cam plan 121 planned CAM-121 (issueNumber 121), not top-of-queue CAM-85. CAM-158 and CAM-159 open. cam plan takes a POSITIONAL number (cam plan 121); there is no --issue flag.

## cam/pr-121-post-merge-issue-close — relocate none-backend issue-close to post-merge + robust issueNumber resolution (subsumes CAM-113)

- **Started**: 2026-07-02
- **Closed**: 2026-07-02
- **Branch**: cam/pr-121-post-merge-issue-close
- **Issue**: CAM-121
- **Outcome**: shipped (PR #118, v0.45.0, merged+tagged; sidecar rebuilt to 0.45.0)
- **Summary**: Original session goal; umbrella fix subsuming CAM-113. resolveIssueId (US-001) resolves prd.issueNumber whether string ('CAM-154') or number (42) to the canonical id, never the phantom prefix-0. The none-backend close relocates from ship-finalize (branch copy) to the post-merge step on main via closeIssueOnMain (US-003, commit-tree, fail-loud), with the issueId threaded through .cam-merge-watch.json (US-002/004). US-005 closes it in the ci-gated post-merge; US-006 documents both merge modes. Eliminates BY CONSTRUCTION the pre-merge main push that causes BEHIND and the stale-branch-copy clobber. 6 stories + 1 reviewer fix, 2759 pass, CLEAN round 2.
- **Decisions**: Planned via cam plan 121 (targeting works post-CAM-157: issueNumber 121). Close deferred to post-merge for both ci-gated (runPostMerge) and immediate (cam-ship.md inline closeIssueOnMain) modes. Stash gated by issueSystem===none so github/linear are untouched.
- **Blockers encountered**: Review round 1 FIXES_PENDING:1 caught a REAL github/linear regression: finalize stashed the issueId gated only by issueId!=null, so a non-none backend in ci-gated mode would call closeIssueOnMain against the none store and get a spurious not-found. US-R1-001 gated the stash behind issueSystem===none. Tests missed it (the AC5 github/linear tests used a no-op stashFn default).
- **Follow-ups**: This PR's own ship ran the OLD finalize (installed binary was 0.44.0) -> closed CAM-121 on the branch (issueNumber numeric, clean, no BEHIND); the new stash+post-merge path activates for future ships after the 0.45.0 rebuild (done). CAM-158 (gitignore cam-plan-out logs) and CAM-159 (preflight halt observability) remain open. Operational: hand-spawn the sidecar via nohup+disown, never the harness run_in_background (it gets reaped).

## cam/CAM-158-plan-preflight-hardening — plan-preflight hardening: gitignore logs + emit preflight-failed event (subsume CAM-159)

- **Started**: 2026-07-02
- **Closed**: 2026-07-02
- **Branch**: cam/pr-158-plan-preflight-hardening
- **Issue**: CAM-158
- **Outcome**: shipped (PR #119, v0.46.0, merged+tagged; sidecar rebuilt to 0.46.0)
- **Summary**: Dois fixes de robustez no plan pre-flight surfacados dogfooding CAM-121. US-001: .gitignore ganha .claude/cam-plan-out-*.log (espelho do .cam-worker-out-*.log, CAM-68), impedindo que logs do pipe-pane do planner/auditor sujam git status --porcelain e tripeiem o step clean-tree. US-002: WorkerEventKind ganha 'plan-preflight-failed'; runPlanPhase emite o evento via logEvent existente quando preflightFn retorna ok:false, paridade com sidecar-exit/spawn-resolution. CAM-159 subsuido e fechado. 2761 pass, check:all verde, review CLEAN round 1.
- **Decisions**: Planejado via cam plan 158 (targeting ok, numeric issueNumber, sem BEHIND). Auditor APROVOU com 2 suggestions nao-bloqueantes: F-01 cosmtico, F-02 (templates/.gitignore, filado como CAM-160). Ship: race condition merge-watch -- finalizeFn escreveu {issueId} mas sidecar idle deletou (consume-on-read) antes do step pos-PR; corrigi manualmente; filei CAM-161 pro fix de raiz. Post-merge automatico fechou CAM-158 (stage:shipped); CAM-159 fechado manualmente.
- **Blockers encountered**: Race condition merge-watch: issueId perdido na escritadel race com sidecar poll; workaround manual na ship. CAM-161 filado.

## cam/CAM-162-orch-recycle-core — autonomous orchestrator recycle CORE: marker + wrapper SIGTERM + explicit rehydrate (CAM-141)

- **Started**: 2026-07-02
- **Closed**: 2026-07-02
- **Branch**: cam/pr-162-orch-recycle-core
- **Issue**: CAM-162
- **Outcome**: shipped (PR #120, v0.47.0, merged+tagged; sidecar rebuilt to 0.47.0)
- **Summary**: Completa o loop autonomo do CAM-23: no cycle-close o orquestrador recicla (termina+respawna fresco) sem /exit manual. Fato confirmado (claude-code-guide+docs): hooks/in-session NAO encerram sessao interativa -> dono = wrapper cam run, mecanismo = SIGTERM gracioso no PID do claude, NAO send-keys/hook/sidecar. Marker dedicado .cam-orch-recycle armado por `cam journal append --cycle-close` (flag nova, discriminador distinto de --force e handoff-presence). Watcher em modulo separado orch-recycle-watch.ts; entrega explicita do handoff via CAM_ORCH_REHYDRATE no respawn (fix robusto do CAM-141: presenca-de-arquivo deixa de ser sinal). 7 stories + 3 review-fix (US-R1-001 orphan watcher no cam stop; US-R2-001 file-size; US-R2-002 gitignore runtime files), review CLEAN round 3. Split: o token backstop de ocupacao saiu pra CAM-163 (blocked-by).
- **Decisions**: Operador escolheu recycle IMEDIATO no cycle-close (um PR por sessao; habilita tokens/sessao como metrica de esforco). Design via grill: modelo=julgamento (escreve handoff), wrapper=mecanismo (deterministico). 3 plan-BLOCKs antes de convergir (auditor pegou: check:all por-story, SIGTERM=operator-ceremony, cumulative-vs-occupancy critical no backstop) -> split do backstop pra CAM-163 + fixes precisos (flag --cycle-close, watcher module) -> APPROVE. Auto-recycle so ativa no proximo cam run (watcher spawnado pelo wrapper novo).
- **Blockers encountered**: 3 plan-BLOCKs (superficie de 8 stories grande demais + subespecificacao minha do discriminador de journal-append); resolvido splitando o backstop e codificando o flag --cycle-close explicito. Ship: o race do merge-watch (CAM-161) recorreu (issueId consumido entre finalize e PR) -> fix manual. Add/add conflict em CAM-0164.json: o worker de US-004 criou o issue file direto (hook nao bloqueia Write), colidindo com o meu cam issue --file-local -> resolvido mantendo a versao do main.

## cam/CAM-163-orch-context-backstop — occupancy backstop for orchestrator recycle watcher (completes CAM-162)

- **Started**: 2026-07-03
- **Closed**: 2026-07-03
- **Branch**: cam/CAM-163-orch-context-backstop
- **Issue**: CAM-163
- **Outcome**: shipped (PR #122, v0.49.0, merged+tagged; binary reinstalled and sidecar hot-swapped to 0.49.0)
- **Summary**: Recycle watcher now reads the orchestrator transcript LAST-request context occupancy (parseContextOccupancy, US-001), maps model to context window with ORCH_CONTEXT_BACKSTOP_FRACTION (US-002), and arms ORCH_RECYCLE_MARKER via an injectable armMarkerFn seam when the session crosses the ceiling (US-003). 3 stories, 2825 pass, check:all green, auditor APPROVE (2 important AC-oracle findings), review CLEAN round 1. Backstop only arms on the next cam run (watcher is wrapper-spawned).
- **Decisions**: Operator chose to ship with the known F-01 defect (off-convention test file) and consolidate post-merge: filed CAM-169. plan_approval auto cascaded plan to implement without pause. PR ops ran with env -u GITHUB_TOKEN pending PAT fix, then the operator rotated the .env PAT mid-cycle.
- **Blockers encountered**: Merge-watch never detected MERGED: the sidecar inherited a stale revoked GITHUB_TOKEN at spawn (process env beats .env; gh 401 is treated as a silent transient null forever, pollCount 40+). Diagnosis: reproduced the exact pollFn call per-token; fix: respawn sidecar with the token explicitly injected from .env (two respawns, the first inherited the same stale token from the orchestrator shell). Filed CAM-170 (emit poll-error event after N consecutive nulls). F-01 materialized exactly as the auditor predicted and review round 1 CLEAN missed it (CAM-169).
- **Follow-ups**: CAM-169 (consolidate watcher tests into test/commands/), CAM-170 (merge-watch poll observability), CAM-168 confirmed still open in 0.49.0 (cam journal append has no --cycle-close flag; autonomous recycle self-trigger not armed), CAM-163 backstop goes live for the orchestrator only on the next cam run.

## cam/pr-168-recycle-self-trigger-arm — harden autonomous recycle self-trigger (refuse-to-arm, boot cleanup, doc disambiguation)

- **Started**: 2026-07-03
- **Closed**: 2026-07-03
- **Branch**: cam/pr-168-recycle-self-trigger-arm
- **Issue**: CAM-168
- **Outcome**: shipped (PR #123, v0.50.0, squash-merged + tagged local/remote; autonomous post-merge via sidecar 52439, CAM-168 stage:shipped)
- **Summary**: CAM-168's original premise was stale: it asked to add a writer that arms the recycle marker, but CAM-162 had already shipped `cam journal append --cycle-close` which arms ORCH_RECYCLE_MARKER when a handoff is present (index.ts:1176). Verified at runtime (comments-do-not-prove-behaviour lesson) rather than trusting the rehydrated handoff. Operator chose Option A: rescope to the real residual (harden the self-trigger), not close-as-done. 3 stories, review CLEAN round 1, 2829 pass, check:all green, auditor APPROVE. US-001: refuse-to-arm: `--cycle-close` now returns exit 4 when no live recycle watcher exists (was arming a marker no consumer would read), via injectable watcherAliveFn + sidecar-pid.ts watcherAlive + file-size-budget bump. US-002: cam run boot now clears a stale recycle marker on fresh start (the landmine where a leftover marker SIGTERMs the next fresh session). US-003: disambiguated the recycle-ceremony docs in both agent-file copies and re-embedded src/vendor/_generated.ts.
- **Decisions**: Design fork resolved to refuse-to-arm (exit 4) over silently arming an unconsumed marker: arming without a live watcher is a latent landmine, so fail loud. Scope G1-G4 approved by operator; G4 (end-to-end recycle-ceremony validation on a fresh cam run) is an operator ceremony, hand-filed as a follow-up rather than auto-implemented. plan_approval auto cascaded plan to implement without pause.
- **Blockers encountered**: Plan phase silently no-op'd on first phase:planning write (mutex-busy): a stale %3 reviewer pane left over from the CAM-163 ship gave 3 panes, so the plan-runner's exactly-2-pane mutex early-returned with no event and the sidecar consumed the signal silently. Fix: tmux -L cam kill-pane -t '%3', re-armed phase:planning with 2 panes. Ambient shell GITHUB_TOKEN was stale/revoked (inherited from cam run): all gh ops ran with env -u GITHUB_TOKEN (keyring gho_) and the sidecar was respawned with the .env token injected, avoiding the CAM-163 merge-watch 401 stall. autoShipFn fired a late duplicate /cam-ship after the manual ship was already done; ignored (would have double-bumped).
- **Follow-ups**: Hand-file G4 (requires:operator): validate the full recycle ceremony end-to-end on a fresh cam run (watcher present, cycle-close arms marker, SIGTERM, respawn, rehydrate). Lesson to capture: a lingering reviewer pane from a just-shipped cycle silently blocks the next plan via the pane-count mutex with no emitted event; plan-runner should surface mutex-busy rather than return silently.

## cam/pr-85-exponential-backoff-jitter — backoff exponencial-com-jitter no supervisor (jitter-only no cap=3); cap-raise adiado como CAM-171

- **Started**: 2026-07-03
- **Closed**: 2026-07-03
- **Branch**: cam/pr-85-exponential-backoff-jitter
- **Issue**: CAM-85
- **Outcome**: shipped (PR #124, v0.51.0, squash-merged + tagged local/remote; post-merge autonomo via sidecar 8316, CAM-85 stage:shipped)
- **Summary**: Trocou o backoff linear (NO_PROGRESS_BACKOFF_MS * streak) por exponencial-com-jitter via novo helper puro computeBackoffMs: min(MAX_BACKOFF_MS, base*2^(streak-1)) * (1 +/- JITTER_FRACTION). Os dois sites de retry (no-progress e dead-worker) roteiam por ele; randomFn injetavel (()=>0.5 = jitter zero nos testes). 2 stories (US-001 + a fix-round US-R1-001), 2836 pass, check:all verde, auditor APPROVE.
- **Decisions**: Fork de escopo resolvida em jitter-only-agora + follow-up, NAO subir o cap dentro deste PR. Racional: o auditor mostrou (verificado no codigo) que com cap=3 o loop bloqueia NO streak 3 antes de dormir, entao so streaks 1 e 2 chegam ao sleep e para eles 2^(streak-1)={1,2} da a MESMA sequencia {60s,120s} do linear; a unica mudanca observavel entregue foi o jitter. Realizar a janela de 240s do proprio exemplo do CAM-85 exige subir MAX_*_RETRIES 3->4, que e uma decisao de politica de escalacao (tolera 1 streak a mais antes de escalar pro humano; ~4min mais tarde em falha genuina) separavel da mudanca de forma. Operador estava fora do teclado no gate; procedi com best-judgment = o PRD aprovado (Opcao A), que e honesto (docstrings dizem que hoje so o jitter muda) e nao faz mudanca de politica sem sign-off. B preservada como CAM-171, nao vaporware.
- **Blockers encountered**: Pre-flight do plan achou 3 panes (%0 orch, %1 dashboard, %4 reviewer stale do ship do CAM-168): mesmo landmine mutex-busy do CAM-168; matei %4 antes de escrever phase:planning (proativo desta vez). Review round 1 FIXES_PENDING:1 (WARNING loop.ts:521): docstring do MAX_DEAD_WORKER_RETRIES ainda descrevia o linear removido; eu tinha identificado a mesma linha independentemente antes do reviewer. Loop auto-curou (implementer fix + re-review CLEAN round 2). Todas as ops gh com env -u GITHUB_TOKEN (token ambiente revogado). Sidecar 8316 (token .env injetado) fez o post-merge ci-gated sem stall.
- **Follow-ups**: CAM-171 (subir retry cap 3->4 para realizar a janela de 240s; avaliar trade-off de escalacao mais lenta, ou fechar wont-fix se jitter-only basta). Coerencia binario/sidecar: sidecar 8316 ainda roda o binario 0.50.0; a mudanca do CAM-85 vive em src/supervisor/loop.ts (que o sidecar executa), mas e comportamentalmente inerte no cap=3 (so jitter), entao rebuild pra 0.51.0 e baixo-valor ate o cap subir. Nenhum rebuild urgente.

## cam/pr-173-orch-pid-resolve — resolver o pid do orquestrador via pgrep -P para o SIGTERM do auto-recycle chegar no macOS

- **Started**: 2026-07-03
- **Closed**: 2026-07-03
- **Branch**: cam/pr-173-orch-pid-resolve
- **Issue**: CAM-173
- **Outcome**: shipped (PR #125, v0.52.0, squash-merged + tagged local/remote; post-merge autonomo via sidecar 8316, CAM-173 stage:shipped)
- **Summary**: Root cause P1 do auto-recycle nunca disparar no macOS: o watcher resolvia o pid do orquestrador via pgrep -f <sessionId>, mas o argv do claude inlined do orquestrador tem ~1384 bytes e excede a janela de argv que pgrep -f consegue casar no macOS, entao o lookup retornava vazio e o SIGTERM do recycle era descartado em silencio. Fix approach A (decidido pelo operador, nao re-litigado): o wrapper grava o proprio pid estavel em .cam-orch-pid (ORCH_PID_MARKER) e o watcher le o marker e resolve o claude child via pgrep -P <wrapper_pid> (lookup kernel pai-filho, imune a truncacao de argv, categoricamente diferente do string-match quebrado). O claude fica em FOREGROUND: rejeitei o & echo $! ; wait literal do texto do issue porque backgroundar um TUI redireciona stdin pra /dev/null / dispara SIGTTIN e mataria a interatividade. 5 stories, review CLEAN round 2, 2864 pass, check:all verde, auditor APPROVE. US-001: persiste o wrapper pid no marker (echo $ > .cam-orch-pid no buildOrchestratorPaneCommand; stop.ts remove no stop). US-002: resolve via pgrep -P com evento nao-silencioso de unresolved-pid. US-003: gitignora o marker nas 2 copias + re-embed src/vendor/_generated.ts (classe CAM-68). US-R1-001 (fix-round): exporta readWrapperPid/resolveChildViaPgrep com seam injetavel + testes unit diretos dos guards de parsing. US-R1-002 (fix-round): corrige comentario de header stale que ainda descrevia o pgrep -f. Oraculo real-process em test/integration/orch-recycle-pid-resolve.test.ts spawna wrapper+child reais e afirma que pgrep -P resolve o child.
- **Decisions**: Approach A foi decisao do operador (foreground + marker deterministico), nao re-litigada A vs B. Preservei o claude em foreground contra o literal do issue (& wait) porque backgroundar TUI quebra stdin/interatividade: launch-readiness acima de fidelidade literal ao texto do issue. plan_approval auto cascateou plan->implement sem pausa. Residual F-01 do auditor (option readSessionIdFn? orfa apos trocar pra pgrep -P) deixado no lugar: trivial, nenhum gate pega, reviewer passou CLEAN; nao vale um round extra.
- **Blockers encountered**: Pane %6 reviewer lingering ocupava o mutex de 2-panes: matei antes do dispatch (mesma landmine dos CAM-168/85). $BASHPID veio vazio no primeiro teste de captura de pid: diagnostico = bash 3.2.57 default do macOS nao tem $BASHPID; pivotei pra pgrep -P (validado empiricamente que retorna o unico child foreground). Monitores bash em background (run_in_background) foram mortos pelo ambiente 2x no meio do loop: troquei pro Monitor nativo do harness; o push do sidecar ([cam] ... DONE/verdict) provou ser o wake primario confiavel. Todas as ops gh com env -u GITHUB_TOKEN (token .env fine-grained perdeu Pull requests: write; cai no gho_ do keyring).
- **Follow-ups**: CRITICO (difere do CAM-85, que era inerte): rebuild+reinstall pra 0.52.0 e restart do sidecar sao necessarios pra o fix valer. O fix vive em src/commands/orch-recycle-watch.ts + run.ts que o binario sidecar executa e e comportamentalmente ATIVO; o sidecar 8316 roda 0.50.0 em memoria, entao auto-recycle segue morto no macOS ate rebuildar+reinstalar+restartar. Operator ceremony (requires:operator): prova live do SIGTERM chegando VIA watcher (nao kill direto como o teste do CAM-164) + respawn + rehydrate, numa cam run fresca com o 0.52.0 instalado. F-01 residual: remover a option readSessionIdFn? orfa em orch-recycle-watch.ts (trivial, opcional).

## operator-ceremony-cam-173-recycle — operator ceremony: live macOS auto-recycle validation (0.52.0)

- **Started**: 2026-07-03T17:26:31Z
- **Closed**: 2026-07-03T17:26:31Z
- **Branch**: main
- **Issue**: CAM-173 / G4 (CAM-168)
- **Outcome**: validated (operator ceremony)
- **Summary**: Fired the real cycle-close recycle trigger on binary 0.52.0 to validate macOS auto-recycle end to end (CAM-173 pid-resolve fix + CAM-168 G4). Preconditions verified live: watcher 24203 alive, .cam-orch-pid=24177 (wrapper), pgrep -P resolves the claude child, marker absent pre-fire. Wrote the cycle-close handoff, then armed .cam-orch-recycle via cam journal append --cycle-close. Expected chain: watcher resolves the orchestrator pid via pgrep -P (immune to macOS argv truncation) and SIGTERMs it, wrapper 24177 respawns a fresh orchestrator and delivers CAM_ORCH_REHYDRATE. The respawned session boot-with-rehydrate is the PASS proof; it confirms the empirical signals before declaring PASS.
- **Follow-ups**: Respawned session to confirm PASS and ask operator whether to close CAM-173 operator-story + G4 (CAM-168) as validated-live. Backlog: CAM-171 (retry cap 3->4), CAM-65 (reviewer pane lingering post-CLEAN), F-01 residual (orphan readSessionIdFn option in orch-recycle-watch.ts).

## operator-ceremony-cam-173-recycle-pass — operator ceremony PASS: macOS auto-recycle validated live (0.52.0)

- **Started**: 2026-07-03T17:32:37Z
- **Closed**: 2026-07-03T17:32:37Z
- **Branch**: main
- **Issue**: CAM-173 / G4 (CAM-168)
- **Outcome**: validated-live (PASS)
- **Summary**: Respawned orchestrator confirmed the macOS auto-recycle chain end to end on binary 0.52.0. Empirical signals: handoff consumed (.cam-orch-handoff.json renamed to .consumed.json); .cam-orch-recycle marker absent (the watcher removes it only after killFn SIGTERM on the pgrep -P-resolved pid, orch-recycle-watch.ts:302); prior session 6e539da2 frozen at 14:26 while this session a7c9ae0a booted with a non-empty CAM_ORCH_REHYDRATE; wrapper 24177 / sidecar 24202 / watcher 24203 all alive. The CAM-173 pgrep -P fix resolved the child pid despite the wrapper running under zsh -c (cmd != claude), which was exactly the pgrep -f <uuid> failure mode.
- **Decisions**: None; ceremony only, no code change. CAM-173 + CAM-168 were already stage:shipped; this closes the G4 live-validation follow-up.
- **Blockers encountered**: None functional. Honest caveat: .claude/cam-recycle-watcher.log is 0 bytes. That is NOT a failure signal: the watcher tick path emits nothing to stdout/stderr on a successful tick, so the redirect log is empty by design. The prior ceremony entry's expectation that the log would show the pgrep -P + SIGTERM lines was wrong (comments-do-not-prove-behaviour). PASS rests on the observable state transitions (marker consumed + respawn + rehydrate), not on log output.
- **Follow-ups**: CAM-173 + CAM-168 already stage:shipped (terminal). Next: CAM-171 (retry cap 3 -> 4). Still open: CAM-65 (reviewer pane lingering post-CLEAN), F-01 residual (orphan readSessionIdFn option in orch-recycle-watch.ts).

## cam-171-ship-plus-recycle-pgrep-defect — CAM-171 shipped (retry cap 3 to 4, v0.53.0); found CAM-173 recycle pgrep-blind defect on macOS

- **Started**: 2026-07-03T17:30:00Z
- **Closed**: 2026-07-03T19:14:48Z
- **Branch**: main
- **Issue**: CAM-171
- **Outcome**: PASS
- **Summary**: Shipped CAM-171 end to end fully autonomously: spec (inline, description was spec-complete) to /cam-plan to auditor APPROVE to implement US-001 (2864 tests pass) to review CLEAN round 1 to ci-gated ship to CI-merge to sidecar post-merge (tag v0.53.0, branch pruned, issue closed). The retry cap 3 to 4 finally realizes the 240s backoff window CAM-85 promised but shipped inert. Caps are still behaviorally inert until the sidecar (running 0.52.0 in-memory) is rebuilt to 0.53.0.
- **Decisions**: Bump (not wont-fix): an autonomous loop should ride out 3-7min transient rate-limits without a human, at the cost of tolerating ~1 extra streak (~4min) before escalating a real failure. All gh ops via env -u GITHUB_TOKEN (keyring gho_) because the .env PAT lost Pull-requests:write.
- **Blockers encountered**: DEFEITO no auto-recycle CAM-173, descoberto ao tentar o cycle-close handoff: claude 2.1.200 reescreve o proprio process-title em runtime, deixando o KERN_PROCARGS2 num estado que o `pgrep` PULA. O processo do orquestrador fica INVISIVEL ao `pgrep` em todo modo (-P, -f, -x, nome), enquanto `ps` o enxerga normal. Logo `pgrep -P <wrapper>` (o fix do CAM-173) volta vazio e o watcher nao SIGTERMa o orquestrador: recycle falha em silencio. Verificado empirico ~10x. Este cycle-close foi completado por `kill -TERM` direto no pid (o watcher/pgrep esta cego), nao pelo marker/watcher.
- **Follow-ups**: CAM-165: trocar a resolucao de pid do watcher pra ps-based (walk de ppid) ou pra um arquivo .cam-orch-child-pid gravado pelo wrapper no spawn; o spec atual do CAM-165 propoe pgrep -n que tambem falharia. Rebuild+reinstall 0.53.0 e restart do sidecar pra os caps 3 to 4 ficarem vivos. CAM-139 (drainer inter-ciclo) segue nao construido = nao existe autonomia inter-ciclos hoje.

## cam-165-ps-ppid-resolve-shipped — CAM-165 shipped (auto-recycle pid resolution via ps ppid-walk, v0.54.0); fix live pending sidecar restart

- **Started**: 2026-07-03T21:42:29Z
- **Closed**: 2026-07-03T21:42:29Z
- **Branch**: cam/pr-165-orch-recycle-ps-pid-resolve
- **Issue**: CAM-165
- **Outcome**: shipped (PR #127, v0.54.0, squash-merged + tagged local/remote; post-merge autonomo via sidecar; CAM-165 stage:shipped)
- **Summary**: Trocou a resolucao de pid do auto-recycle watcher de pgrep (CEGO pro processo do orquestrador no macOS: o claude 2.1.200 reescreve o proprio process-title em runtime, deixando o KERN_PROCARGS2 num estado que o pgrep pula em todo modo -P/-f/-x/nome) para ps ppid-walk (`ps -ax -o pid=,ppid=` filtrando ppid==wrapperPid; tabela de proc do kernel, imune ao rewrite). No recycle-tick o wrapper bash esta bloqueado na linha claude foreground, entao tem exatamente 1 child -> deterministico. US-001 (core ps + drop total do pgrep + oraculo de integracao title-rewriting que REPRODUZ o pgrep-cego + header/comment cleanup) e US-002 (remove eslint-disable no-constant-condition inertes em orch-recycle-watch.ts e retry/launcher.ts). Review CLEAN round 1, 2864 pass, check:all verde, auditor APPROVE. v0.53.0 -> 0.54.0.
- **Decisions**: Abordagem ps ppid-walk, NAO o `pgrep -n` que a idea original propunha (pgrep e cego em modo nenhum; nao e questao de escolher o candidato certo). Descartado wrapper-grava-child-pid (claude roda foreground; capturar $! exigiria backgroundar o TUI, rejeitado no CAM-173 por quebrar stdin). Oraculo de teste passou a usar um child que reescreve o proprio process.title pra reproduzir o failure mode (o `sleep` anterior dava FALSA confianca: nao reescreve title, entao pgrep -P funcionava no teste e falhava em producao). Re-spec via /cam-spec (a idea CAM-165 era pre-CAM-173 e propunha um fix que nao funciona). Todas as gh ops via env -u GITHUB_TOKEN (keyring gho_; .env PAT sem Pull-requests:write). Rebuild+reinstall 0.54.0 feito (caminho A escolhido pelo operador).
- **Blockers encountered**: Nenhum funcional. Ironia coberta: o auto-recycle seguia quebrado DURANTE este ciclo (sidecar 24202 + watcher 24203 rodando 0.52.0 em memoria), entao o cycle-close deste ship precisou de kill manual/restart, nao do watcher. Irrelevante pro ship em si (o fix vive no source buildado).
- **Follow-ups**: 1) RESTART LIMPO (operador): `cam stop && cam run` fresco pra a arvore (wrapper/sidecar/watcher) rodar 0.54.0 com o fix ps + os caps CAM-171 3->4 (inertes em 0.52.0). 2) CERIMONIA requires:operator: na sessao fresca 0.54.0, disparar um cycle-close real -> watcher resolve o pid via ps -> SIGTERM PELO watcher (nao kill manual) -> respawn -> rehydrate = prova live definitiva do fix. 3) Backlog: CAM-139 (drainer inter-ciclo, nao construido = sem autonomia inter-ciclos hoje), CAM-65 (reviewer pane lingering post-CLEAN).

## operator-ceremony-cam-165-recycle-live-0540 — operator ceremony fire: CAM-165 auto-recycle live-validation on 0.54.0 (ps ppid-walk)

- **Started**: 2026-07-03T21:49:49Z
- **Closed**: 2026-07-03T21:49:49Z
- **Branch**: main
- **Issue**: CAM-165 / G4 (CAM-168)
- **Outcome**: fired (PASS to be confirmed by the respawned session)
- **Summary**: Fired the real cycle-close recycle trigger on a fresh 0.54.0 tree to validate the CAM-165 pid-resolution fix (ps ppid-walk) live. Operator ran cam stop && cam run first. Preconditions verified live: binary 0.54.0; wrapper pid 98506 (= .cam-orch-pid); orchestrator claude 98511 is the SOLE child of 98506 (the pid pgrep is blind to due to the claude 2.1.200 process-title rewrite, which is exactly what ps ppid-walk resolves); watcher 98533 alive and .cam-watcher.pid=98533 (exit-4 arm-gate satisfied); sidecar 98532 alive; .cam-orch-recycle marker absent pre-fire; handoff written and schema-valid. Expected chain: cam journal append --cycle-close arms .cam-orch-recycle -> watcher resolves the orchestrator pid via ps -ax -o pid=,ppid= filtered by ppid==98506 and SIGTERMs it -> wrapper 98506 respawns a fresh orchestrator and delivers CAM_ORCH_REHYDRATE. The respawned boot-with-rehydrate is the PASS proof.
- **Decisions**: None; ceremony only, no code change. CAM-165 (PR #127, v0.54.0) and CAM-168 G4 already stage:shipped; this closes the live-validation follow-up.
- **Blockers encountered**: None expected. Honest caveat carried from the prior ceremony: a 0-byte .claude/cam-recycle-watcher.log is NOT a failure signal (the watcher tick path emits nothing on a successful tick). PASS rests on observable state transitions (handoff consumed + marker removed + respawn + rehydrate), never on log output.
- **Follow-ups**: Respawned session confirms PASS empirically and asks the operator whether to close the CAM-165 operator ceremony + CAM-168 G4 as validated-live. Backlog: CAM-139 (inter-cycle drainer, not built = no inter-cycle autonomy today), CAM-65 (reviewer pane lingering post-CLEAN), F-01 residual (orphan readSessionIdFn option in orch-recycle-watch.ts).

## cam-152-flip-worker-spawn-container — CAM-152 shipped: flip worker spawn through container (fail-closed worker_isolation, v0.55.0)

- **Started**: 2026-07-03
- **Closed**: 2026-07-04T00:56:33Z
- **Branch**: cam/pr-152-flip-worker-spawn-container
- **Issue**: CAM-152
- **Outcome**: shipped
- **Summary**: Routed all four worker spawns (implementer, reviewer, planner, auditor) into the long-lived cam-worker container via a shared dockerExecWrap chokepoint, gated on a fail-closed [loop] worker_isolation flag (default host). 6 stories, review CLEAN round 1, PR #128 squash-merged, v0.55.0. Makes the CAM-150 isolation substrate live and provides the container-active gate that CAM-139 needs.
- **Decisions**: Grill settled: (1) container persistent + ensure-up idempotent at boot (up/down/absent/stale), no teardown on cam stop; (2) all four workers wrapped incl planner+auditor, which required building a new plan-runner container preflight seam; (3) opt-in flag default host, so zero behavior change until operator flips + rebuilds; (4) fail-closed literal, no host fallback. plan_approval kept auto: operator participates only at spec.
- **Blockers encountered**: Post-merge pull-failed: an unpushed local-main commit (img cleanup, acde9da) diverged local main from the PR squash (e52d553), so the sidecar git pull refused. Recovered by hand: reset --hard origin/main (lossless, content subsumed by squash) then closeIssueOnMain, cam tag v0.55.0, prune branch.
- **Follow-ups**: 1. Post-merge resilience to a diverged local main (unpushed pre-branch commit subsumed by squash). 2. Live-validation ceremony (requires:operator): rebuild+reinstall 0.55.0, set worker_isolation=container, run a representative story GREEN inside the container under the firewall + confirm claude auth. 3. CAM-139 now unblocked but gated on container active (needs the ceremony first).

## cam-178-container-worker-uid-align — container worker uid alignment (fix /workspace EACCES)

- **Started**: 2026-07-04
- **Closed**: 2026-07-04
- **Branch**: cam/pr-178-container-worker-uid-align
- **Issue**: CAM-178
- **Outcome**: shipped
- **Summary**: Aligned the cam-worker container user uid/gid to the host at build time (Dockerfile HOST_UID/HOST_GID build-args + usermod/chown; worker-container.ts threads --build-arg through ensure-up), fixing the /workspace EACCES (bun uid vs host uid) that blocked all container workers. Shipped v0.56.0 (PR #129), review CLEAN round 1, CI green, auto-merged, post-merge clean.
- **Decisions**: Fix = build-time uid alignment (operator-chosen over run-as-host-uid-runtime or chown-workspace). First of 3 container-mode blockers found in the CAM-175 live-validation ceremony.
- **Blockers encountered**: None within CAM-178. Context: the CAM-175 ceremony this session proved CAM-152 container mode is non-functional for real workers; the -p auth smoke passed but hid two integration bugs (onboarding block + EACCES) surfaced only by the real worker dispatch.
- **Follow-ups**: CAM-179 (onboarding/trust seed) + CAM-176 (firewall wiring) still block container mode. After both ship + rebuild to 0.56.0, re-run CAM-175, then CAM-139. Also filed CAM-174 (post-merge resilience), CAM-177 (.dockerignore). CAM-160 specified but unshipped (ceremony planner could not write its PRD due to CAM-178, now fixed).

## cam-179-container-onboarding-trust-seed — CAM-179 shipped: bake claude onboarding + /workspace trust into worker image; live ceremony exposed CAM-178 build bug

- **Started**: 2026-07-04T10:33:00Z
- **Closed**: 2026-07-04T11:12:48.425Z
- **Branch**: cam/pr-179-container-onboarding-trust-seed
- **Issue**: CAM-179
- **Outcome**: shipped
- **Summary**: Baked a claude onboarding + /workspace folder-trust config into the cam-worker image (new .devcontainer/claude-config.json with 5 keys; Dockerfile COPY to /home/bun/.claude.json before the CAM-178 re-home block). One story US-001, review CLEAN round 1, shipped as PR #130, v0.57.0. The key insight from CAM-175 held: seeding top-level hasCompletedOnboarding alone does not suppress the per-project /workspace trust prompt; projects[/workspace].hasTrustDialogAccepted was the missing key.
- **Decisions**: Bake into the image (not runtime seed) via a versioned config file COPYd before the re-home block so the existing chown re-owns it. Verify prompt-suppression live in an operator ceremony, not via -p smoke (print mode hid this class of bug in CAM-175).
- **Blockers encountered**: The CAM-180 ceremony rebuild FAILED and exposed a P1 bug (CAM-183): the CAM-178 uid re-home block never builds on macOS. The collision guard renames the group NAME (groupmod -n) but never frees gid 20 (base dialout:20 vs host staff:20), so groupmod -g 20 bun fails. The cached image still has bun uid=1000, meaning the /workspace EACCES that CAM-178 supposedly fixed was never actually resolved on this host. CI has no Docker daemon so the real build was never run. Also lived: PR #130 sat OPEN+BEHIND under strict branch protection and needed a manual gh pr update-branch to merge (filed CAM-182).
- **Follow-ups**: CAM-183 (P1, fix the re-home groupmod gid collision; verify with a real macOS docker build) blocks all container-mode work and must go first. CAM-180 (verify CAM-179 onboarding) folds into a combined ceremony after CAM-183 lands and the image rebuilds. CAM-181 (auto-ship fires on review CLEAN without checking pending operator stories). CAM-182 (sidecar auto-recover OPEN+BEHIND). Then CAM-176 (firewall), CAM-175 re-run, CAM-139.

## cam-183-rehome-gid-collision — CAM-183 shipped: getent gid-collision branch fixes the container build on macOS; ceremony verified 178/183 + 179 config

- **Started**: 2026-07-04
- **Closed**: 2026-07-04
- **Branch**: cam/pr-183-rehome-gid-collision
- **Issue**: CAM-183
- **Outcome**: shipped
- **Summary**: Fixed the CAM-178 uid re-home block in .devcontainer/Dockerfile that never built on macOS (host gid=20 collides with the base gid-20 group; the old groupmod -n rename freed the NAME but not the gid, so groupmod -g 20 bun failed). Replaced with a getent branch: usermod -u -g by numeric gid when the group exists, else groupmod -g then usermod -u. 1 vertical-slice story (Dockerfile rewrite + deterministic Dockerfile-text test), auditor APPROVE, review CLEAN round 1, 2971 tests, shipped v0.58.0 (PR #131).
- **Decisions**: Combined operator ceremony PASSED empirically (first real docker build on this macOS host, gid=20): build exit 0, bun uid=501 gid=20, /workspace writable, file round-trips to host as 501:20; cam-worker:latest rebuilt+working. CAM-179 config verified bun-readable + 5 keys; live interactive zero-prompt deferred to CAM-175 as the definitive gate. No per-183 operator story filed (avoids the CAM-181 bug).
- **Blockers encountered**: Stale reviewer panes (CAM-167) wedged paneCountMutex at busy and blocked cam plan; killed after confirming stale via capture-pane. Ship: env -u GITHUB_TOKEN needed on all gh (PAT lacks PR:write); PR sat BLOCKED until CI green then auto-merged (ci-gated, branch not behind).
- **Follow-ups**: CAM-176 (firewall wiring) NEXT -> re-run CAM-175 (definitive 179 zero-prompt gate + real-story GREEN) -> CAM-139. Also open: CAM-180 (partially done), CAM-181, CAM-182, CAM-177.

## cam-176-wire-firewall-ensure-up — CAM-176 shipped: wire init-firewall.sh into the ensure-up container path, fail-closed

- **Started**: 2026-07-04T09:51:35-03:00
- **Closed**: 2026-07-04T14:02:55Z
- **Branch**: cam/pr-132-wire-firewall-ensure-up
- **Issue**: CAM-176
- **Outcome**: shipped
- **Summary**: Wired the existing default-deny egress firewall (.devcontainer/init-firewall.sh) into cam's ensure-up container path, which until now never ran the firewall (only the devcontainer postStartCommand did, and cam's docker run path never triggers it, so container mode was not egress-sandboxed). New src/supervisor/container-firewall.ts (buildFirewallExecArgv pure builder + applyContainerFirewall), wired into makeProductionEnsureContainerFn to run unconditionally after ensureWorkerContainer, fail-closed in runSidecar (typed FirewallError, log stderrTail, return before runSidecarLoop, no worker dispatches). 1 story US-001, auditor APPROVE, review CLEAN round 1, check:all green (3012 tests), shipped v0.59.0 (PR #132).
- **Decisions**: Wiring-only (allowlist owned by CAM-116, e2e by CAM-175). Separate applyContainerFirewall fn (keeps ensureWorkerContainer 4-branch machine pure). Apply unconditional on every ensure-up (idempotent script; netns rules drop on stop/start). exec form sudo bash /workspace/.devcontainer/init-firewall.sh mirrors the devcontainer and reuses the restricted NOPASSWD sudoers grant. Script exit code IS the readiness gate (self-verify curls). Fail-closed via typed FirewallError (clean return, avoids wrapper crash-loop). Test = pure argv builder + injectable spawnFn fakes; real-daemon deferred to CAM-175.
- **Blockers encountered**: Implementer sentinel poll ran the full 30min budget then timed out (pollOutcome:timeout, pane-died-retry), but the work was committed well before; supervisor self-healed by advancing to review (US-001 already passes:true). Recurring buffering fragility, slow but not blocking. Ship: env -u GITHUB_TOKEN needed on all gh (PAT lacks PR:write).
- **Follow-ups**: CAM-175 is next and the definitive container-mode gate: PRECONDITION rebuild+reinstall cam to 0.59.0 (running sidecar is 0.55.0 = no firewall wiring), then flip worker_isolation=container and run a real story GREEN in the container (firewall converges, egress allow/block, zero-prompt, /workspace writable). Then CAM-139. Also open: CAM-181, CAM-182, CAM-177, CAM-180 (mostly folded into 175). Optional nit: reviewer SUGGESTION on container-firewall.ts:40.

## cam/pr-185-container-config-chown-bypass — CAM-185 shipped: fix container-mode root-owned .claude volume (build-time + runtime), container mode product-complete

- **Started**: 2026-07-04
- **Closed**: 2026-07-04T22:13:19Z
- **Branch**: cam/pr-185-container-config-chown-bypass
- **Issue**: CAM-185
- **Outcome**: shipped
- **Summary**: Fixed container mode's root-owned /home/bun/.claude named volume, the last CAM-175 blocker. The claude-code-config named volume mounted root-owned (the image lacked a bun-owned /home/bun/.claude dir, so Docker created the mountpoint root, shadowing the build-time chown), causing two symptoms in real workers: every Bash tool call failed EACCES on mkdir session-env, and claude rewrote .claude.json dropping bypassPermissionsModeAccepted so the Bypass Permissions modal reappeared and hung the worker. Fixed at both layers: build-time (Dockerfile pre-creates the bun-owned dir + installs jq) so fresh volumes mount bun-owned, and runtime (new container-config.ts mirroring container-firewall.ts, wired unconditionally into ensure-up, fail-closed in the sidecar) that self-heals existing volumes by chowning the dir and re-asserting the 5 CAM-179 keys on every ensure-up. 3 stories, auditor APPROVE, review CLEAN round 1, 3070 tests, shipped v0.60.0 (PR #133).
- **Decisions**: Operator chose build-time + runtime (root-cause for fresh volumes + self-heal for existing). Runtime module mirrors the CAM-176 firewall pattern exactly (pure argv builder + non-throwing orchestrator union + typed error thrown by the caller + instanceof fail-closed arm). Applied a SHIP-GATE (not operator-requested): did not let auto-ship merge on host-green alone because CI is macos-only with no Docker daemon (the CAM-178 trap). Verified the fix on the REAL production ensure-up path (makeProductionEnsureContainerFn from branch source against the live daemon, no fakes) on both stale (self-heal) and fresh (build-time) volumes before shipping: dir 501:20, bun mkdir OK, bypass=true + 5 keys, firewall allow-anthropic+github/block-example, jq-1.6 in image. CAM-175 already proved state to clean-worker (worker %14), so a full re-dispatch was not re-run.
- **Blockers encountered**: US-003 (wiring + fail-closed + tests) took ~25min on the host wrestling the file-size ratchet gate; the worker raises the budget itself (memory orch-no-hardkill-on-filesize-story) and converged, no intervention. Ship: env -u GITHUB_TOKEN needed on all gh (PAT lacks PR:write). To run the in-session container verification, swapped the sidecar in-place rather than cam stop (which would kill the orchestrator tmux session).
- **Follow-ups**: CAM-139 (autonomous meta-loop) is now UNBLOCKED (hard-precondition container active+validated is met): the natural next major work, likely needs /cam-spec first. Installed cam + sidecar are still 0.59.0; container-mode dev needs rebuild+reinstall to 0.60.0 (build-release.sh --install) before ensure-up carries the fix. CAM-186 (10 in-container test fails vs host) is a scoped follow-up, now unblocked. Also open: CAM-181, CAM-182, CAM-177, CAM-180.

## cam/pr-186-in-container-test-harness — CAM-186 shipped: on-demand in-container test harness; suite green on v0.60.0 (stale 10-fail baseline was 0 real fails)

- **Started**: 2026-07-04
- **Closed**: 2026-07-05T01:53:05.996Z
- **Branch**: cam/pr-186-in-container-test-harness
- **Issue**: CAM-186
- **Outcome**: shipped
- **Summary**: Delivered the on-demand in-container test harness (scripts/test-in-container.ts: ensure-ups cam-worker + docker-exec bun test against /workspace; exit non-zero iff FAILURES) and re-baselined the suite on v0.60.0. The reported 2957 pass / 10 fail vs 3012 (from the pre-jq/pre-185 CAM-175 ceremony) was STALE: on v0.60.0 it is Host 3102/0/0 vs Container 3064 pass / 34 skip / 0 REAL fail. The spec contingency path was hit (jq + CAM-185 ownership already resolved the failures). 34 skips all documented via test.skipIf(!probe). Shipped v0.61.0 (PR #134).
- **Decisions**: Spec grill Q1-Q6 (operator-approved): (B) classify+guard+fix-cheap-gaps, (i) green = 0 failures + documented skips (no tmux added to the worker image, the worker never uses tmux at runtime), (a) dedicated on-demand harness that brings the container up itself (no worker_isolation flip committed; not a CI gate since macos CI has no Docker = CAM-178 trap; pointer added to docs/adr/0003), and US-001 captures the baseline in the loop. 34 skips: 20 pre-existing tmux + 6 tmux (US-001) + 8 US-002 (procps ps absent x1; bun 1.2.x macrotask scheduling differs from bun 1.3 host x7).
- **Blockers encountered**: US-002 (container story: image rebuild + 3098 in-container tests) hit the 30-min sentinel timeout AFTER writing passes=true and git-add-staging but BEFORE committing; the loop read the uncommitted passes=true and spawned a premature reviewer. It self-healed: the reviewer reviews the working-tree diff and caught two real CRITICALs (check:all RED at the file-size gate, and a parseBunOutput false-green matching a marker bun never emits in non-TTY docker-exec) -> FIXES_PENDING -> round-1 fixers (US-R1-001 budget bump, US-R1-002 regex + real bun fixture) committed all staged work via git add -A -> review round 2 CLEAN. Auto-ship did NOT fire after CLEAN (loop idle, reviewer pane lingering held the 3-pane mutex); orchestrator killed the pane and ran /cam-ship by hand. My own slip: re-arming the sidecar in-place with nohup logging into .claude/.cam-sidecar.out dirtied the tree and failed the plan-preflight clean-tree once. env -u GITHUB_TOKEN needed on all gh (PAT lacks PR:write).
- **Follow-ups**: CAM-139 (autonomous meta-loop) is the natural next major work: container mode is product-complete and its suite is now green (needs /cam-spec first if stage:idea; confirm scope with the operator). CAM-187 (P3, filed this cycle): the loop advances on an uncommitted passes=true after a worker timeout, and the 30-min sentinel ceiling is too short for container stories. Investigate why auto-ship did not fire after review CLEAN despite plan_approval=auto (may relate to CAM-181). Also open: CAM-182, CAM-177, CAM-180. Running sidecar/installed cam are 0.60.0; rebuild to 0.61.0 only for a fresh container-mode dispatch.

## cam/pr-139-inter-cycle-auto-drain — CAM-139 shipped: armed the unattended inter-cycle auto-drain (meta_loop=auto, opt-in); auto-ship-after-CLEAN no-fire bug reproduced 2x

- **Started**: 2026-07-05
- **Closed**: 2026-07-05T12:15:43Z
- **Branch**: cam/pr-139-inter-cycle-auto-drain
- **Issue**: CAM-139
- **Outcome**: shipped
- **Summary**: Armed the unattended inter-cycle auto-drain (meta_loop=auto, opt-in, default off): the sidecar dispatches the next plannable issue's plan and chains plan->implement->review->ship->merge via existing primitives, hard-gated on container isolation active + plan_approval=auto, with a runtime kill-switch (cam drain) and a judgment point that parks + escalates on a blocked cycle. 5 stories, review round 1 CLEAN, check:all EXIT 0 (3166 pass), shipped v0.62.0 (PR #135).
- **Decisions**: CAM-139 was already stage:specified (grill done in a prior session) so it went straight to cam plan 139 (no /cam-spec). US-001 extend meta_loop enum with 'auto'; US-002 runtime kill-switch (cam drain + DRAIN_STOP_MARKER, wired into cam stop); US-003 fail-closed hard-precondition gate (container active + plan_approval=auto or refuse); US-004 auto-dispatcher wired into the sidecar idle-tick; US-005 judgment point (park on MAX_ROUNDS_DEBT, escalate once, dedup across ticks). ADR docs/adr/0007. The auto-drain is opt-in and fail-closed; the merge does not auto-activate it.
- **Blockers encountered**: Auto-ship did NOT fire after review CLEAN again (2nd reproduction: CAM-186 + CAM-139) despite plan_approval=auto: the loop went idle/active:false and a reviewer pane lingered holding the 3-pane mutex; the orchestrator killed the pane and ran /cam-ship by hand (ci-gated). This is exactly the failure point where CAM-139's own auto-drain will stall (drainer cannot chain to merge if auto-ship never fires after CLEAN). env -u GITHUB_TOKEN needed on all gh (PAT lacks PR:write).
- **Follow-ups**: START-HERE next cycle: fix the auto-ship-after-CLEAN no-fire bug (reproduced 2x, blocks the auto-drain end-to-end, likely CAM-181; stage:idea -> needs /cam-spec then /cam-plan). To exercise the auto-drain: rebuild+reinstall to 0.62.0, flip meta_loop=auto, satisfy the container + plan_approval gate. 2 reviewer perf/efficiency SUGGESTIONs were non-blocking and not structurally captured (optional file). Backlog: CAM-181 (elevated), CAM-187, CAM-182, CAM-177.

## cam/pr-181-auto-ship-terminal-anchor — CAM-181 shipped: auto-ship-after-CLEAN gate fixed (over-fire A + no-fire B unified) v0.63.0; no-fire reproduced 3x under the 0.60.0 sidecar, shipped by hand

- **Started**: 2026-07-05
- **Closed**: 2026-07-05T15:06:16Z
- **Branch**: cam/pr-181-auto-ship-terminal-anchor
- **Issue**: CAM-181
- **Outcome**: shipped
- **Summary**: Fixed the auto-ship-after-CLEAN gate: BUG A (over-fire, the literal CAM-181) and BUG B (no-fire, reproduced 3x) unified at the same callsite. Re-anchored auto-ship from the transient review->CLEAN edge to the terminal complete branch gated on lastVerdict==='CLEAN' (excludes pending-operator PRDs for free, fixing A) with a persisted review.autoShipDispatchedAt fire-once marker (robust across re-invocation and sidecar restart, fixing B). 2 stories (US-001 code+marker+5 tests, US-002 ADR 0008), auditor APPROVE, review round-1 CLEAN, 3172 pass, check:all green. Shipped v0.63.0 (PR #136).
- **Decisions**: CAM-181 was stage:idea; ran /cam-spec grill this session and amplified scope to A+B (operator-approved), then /cam-plan drove autonomous implement+review. Grill: anchor on terminal complete not the edge (Q1); persisted marker not in-memory blockedCycleEmitted because the side-effect opens a PR and must survive sidecar restart, diverging from CAM-68 for a principled reason (Q2); pane teardown deferred to CAM-188 since the /cam-ship slash command bypasses the pane mutex so a lingering pane never blocks auto-ship (Q3); wrote ADR 0008 (Q4).
- **Blockers encountered**: Auto-ship no-fire reproduced a 3RD time this cycle (CAM-186 + CAM-139 + CAM-181) because the running sidecar is 0.60.0, pre-fix: review CLEAN, loop went idle/active:false, reviewer pane lingered; the orchestrator killed the pane and ran /cam-ship by hand (ci-gated). Expected, not a regression: this PR content IS the fix, dormant until rebuild. env -u GITHUB_TOKEN needed on all gh (PAT lacks PR:write).
- **Follow-ups**: START HERE: rebuild+reinstall the sidecar to 0.63.0 (build-release.sh --install), then verify auto-ship fires autonomously after a CLEAN (acceptance proof only observable post-rebuild; the fix cannot self-validate on the 0.60.0 sidecar that shipped it). Then CAM-139 auto-drain is unblockable end-to-end (flip meta_loop=auto, satisfy the container+plan_approval gate). Backlog: CAM-188 (pane teardown, NEW), CAM-187, CAM-182, CAM-177.

## cam/pr-188-teardown-worker-pane-terminal-exit — CAM-188 shipped: teardown lingering worker/reviewer pane on all terminal exits (v0.64.0); implementer switched to sonnet-5

- **Started**: 2026-07-05
- **Closed**: 2026-07-05T16:37:56.843Z
- **Branch**: cam/pr-188-teardown-worker-pane-terminal-exit
- **Issue**: CAM-188
- **Outcome**: shipped
- **Summary**: Shipped the pane-teardown hygiene fix: on every terminal exit of runSupervisorLoop (complete/awaiting-operator/blocked/max-iterations) the single reused worker/reviewer pane is now killed via kill-pane, restoring the 2-pane invariant so the operator CLI fallbacks (cam next/ship/review/issue/spec) stop being spuriously refused by paneCountMutex and the CAM-139 auto-drain can chain. 1 story US-001, review round 1 CLEAN, 3180 pass, check:all green, v0.64.0 (PR #137). Operator-directed follow-up: implementer model switched claude-sonnet-4-6 -> claude-sonnet-5 on main (commit 2c9d817).
- **Decisions**: Grill (operator-approved): kill-pane not respawn-pane -k (respawn keeps the pane => mutex stays busy; only kill-pane restores count==2, and CAM-57 ensureWorkerPane recreates it on next dispatch). Teardown on ALL 4 terminal states, not complete-only (operator needs the CLI fallbacks most in blocked/await-operator). Single finishTerminal(status) wrapper folding notifyTerminal + teardown, replacing ~16 paired callsites so no return can skip teardown; teardownWorkerPaneFn injected (default no-op), real closure wired in host.ts. Teardown-only scope: surfacing reviewer SUGGESTIONs (already persisted in review-report.json, only lost from scrollback) split out to CAM-189. 2-layer test: unit spy + real-tmux integration (3->2->recreate).
- **Blockers encountered**: Auto-ship-after-CLEAN lingering-pane reproduced a 4th time (running sidecar is 0.63.0, pre-CAM-188): CAM-181 auto-ship marker DID fire autonomously (autoShipDispatchedAt set = CAM-181 acceptance PROVEN on 0.63.0) but the reviewer pane %2 lingered holding the 3-pane mutex and the injected /cam-ship never completed the PR; orchestrator killed %2 by hand and ran /cam-ship manually (ci-gated). This is exactly what CAM-188 fixes, dormant until rebuild. env -u GITHUB_TOKEN needed on all gh (PAT lacks PR:write).
- **Follow-ups**: START HERE: rebuild+reinstall to 0.64.0 (build-release.sh --install) to activate the pane teardown in the running sidecar, then verify a full cycle auto-ships WITHOUT manual pane-kill (the teardown acceptance is only observable post-rebuild). Implementer now sonnet-5 (read from project.toml at dispatch, effective next implement without rebuild). CAM-189 (surface SUGGESTIONs) filed P3. Backlog: CAM-187 (loop advances on uncommitted passes=true after timeout), CAM-182, CAM-177, CAM-180. 1 non-blocking review SUGGESTION (integration test builds closure vs argv-mirror) left uncaptured.

## cam/pr-187-commit-existence-gate — CAM-187 shipped: commit-existence gate + isolation-aware sentinel timeout ceiling (v0.65.0)

- **Started**: 2026-07-05
- **Closed**: 2026-07-05T19:46:00Z
- **Branch**: cam/pr-187-commit-existence-gate
- **Issue**: CAM-187
- **Outcome**: shipped
- **Summary**: Hardened the autonomous loop story-complete invariant: story confirmed DONE only when prd.json passes:true AND a commit carrying the story ID exists on the branch (main..HEAD scope, bracketed feat:[US-XXX] convention). Operator stories exempt. Companion fix: isolation-aware sentinel timeout ceiling (container 60min, host 30min). 3 stories + 3 R1 fixers (bracketed regex, git log scope, real-git integration test), review round 2 CLEAN, 3205 pass, v0.65.0, PR #138.
- **Decisions**: (Q1) Gate unconditional in readWorkerOutcome, injected as commitExistsForStory(id) callback for testability. (Q2) passes:true-without-commit = not-done, re-dispatches, bounded by MAX_DEAD_WORKER_RETRIES anti-storm. (Q3) Isolation-aware ceiling in-scope same PR. (E1) requires:operator exempt. (E2) Anchor on exact bracketed token [US-XXX], scoped git log. (E3) Gate unconditional. Planner model switched to fable-5 on main (79a4fd3) this session.
- **Blockers encountered**: None. CAM-188 teardown + CAM-181 auto-ship PROVEN on 0.64.0: reviewer pane killed autonomously, /cam-ship injected via send-keys without manual pane-kill (first clean autonomous ship in 4+ cycles). env -u GITHUB_TOKEN still required on gh pr create/merge (PAT lacks PR:write).
- **Follow-ups**: START HERE: wait for CI green + auto-merge of PR #138, then cam tag on main post-merge. Backlog: CAM-182 (merge-watch auto-recover BEHIND), CAM-189 (surface SUGGESTIONs), CAM-177, CAM-180.

## cam/pr-182-merge-watch-behind-autorecover — CAM-182 shipped: merge-watch auto-recovers OPEN+BEHIND (bounded gh pr update-branch, cap 2) + durable stalled marker; cleanest fully-autonomous cycle to date (v0.66.0, PR #139)

- **Started**: 2026-07-05
- **Closed**: 2026-07-05T22:31:50Z
- **Branch**: cam/pr-182-merge-watch-behind-autorecover
- **Issue**: CAM-182
- **Outcome**: shipped
- **Summary**: Shipped CAM-182: the sidecar merge-watch now auto-recovers a PR stuck at OPEN+BEHIND under strict branch protection by running gh pr update-branch (bounded cap 2, only when auto-merge is armed) instead of polling silently to the 4h timeout, and durably surfaces non-recoverable merge-watch terminals (behind-unrecovered, dirty, ci-red, closed, timeout) via a merge-watch-stalled event plus a .claude/.cam-ship-stalled.json marker the orchestrator reads on boot. 3 stories, review round 1 CLEAN, check:all EXIT 0 (3236 pass), v0.66.0.
- **Decisions**: Scope split at grill: GAP1 (auto-recover, the action) stays in CAM-182; GAP2 durable escalation is the minimal event+marker+boot-read for CAM-182's own non-recoverable terminals, with general unification of all merge-watch outcomes deferred to CAM-170 as consumer of the merge-watch-stalled event (CAM-170 is a different bug: poll-command errors, not stuck-but-successful polls). update-branch runs under env -u GITHUB_TOKEN (PAT lacks PR:write); read-only poll keeps the token. Cap only spent when main advances again (post-update state is BLOCKED/UNSTABLE not BEHIND). Marker is a separate file from consume-on-read .cam-merge-watch.json; boot-read consumes automatically when a later watch merges the same PR.
- **Blockers encountered**: None. Cleanest cycle to date: plan, auditor APPROVE, 3 stories, review round 1 CLEAN, auto-ship via injected /cam-ship, auto-merge, and post-merge all ran with zero manual intervention (PR #139 merged CLEAN with no BEHIND, unlike PR #138 which needed a manual gh pr update-branch at this session boot). Dogfood irony: the running sidecar (pid 31482) is pre-CAM-182 so this fix is dormant until rebuild.
- **Follow-ups**: Rebuild+reinstall the sidecar to 0.66.0 (build-release.sh --install) to activate CAM-182 auto-recover in the running process. Next candidates: CAM-189 (surface reviewer SUGGESTIONs, P3), CAM-170 (now consumer of merge-watch-stalled; stage:idea, needs /cam-spec), CAM-177 (.dockerignore), CAM-180 (rebuild worker image), CAM-139 (autonomous meta-loop, unblocked).

## cam/pr-149-ship-runner-deterministic — CAM-149 shipped: deterministic ship runner (ship phase is a TS state machine, PR body templated from the PRD, LLM removed from the ship path); dogfood-shipped itself (v0.67.0, PR #140)

- **Started**: 2026-07-05
- **Closed**: 2026-07-06T00:45:08Z
- **Branch**: cam/pr-149-ship-runner-deterministic (merged+pruned)
- **Issue**: CAM-149
- **Outcome**: shipped
- **Summary**: Moved the entire ship phase out of markdown into deterministic TS: runShipPhase (src/supervisor/ship-runner.ts) runs branch guard, PRD-complete, commits-ahead, quality gates (bun run check:all), version bump, cycle-close finalize and push as a fail-fast state machine; runShipPrStep (src/release/ship-pr.ts) does gh pr create + ci-gated auto-merge + artifact comment; the PR title/body are composed purely from the PRD snapshot (composePrTitle/composePrBody, src/release/pr-body.ts). No LLM participates in the ship path. cam ship and cam-ship.md are now thin phase:shipping signal-writers. 6 stories, review round 1 CLEAN, v0.67.0, PR #140.
- **Decisions**: ADR 0009 records the pipeline-determinism decision (considered alternative: LLM-authored PR prose via a worker pane; chosen: deterministic template). PRD snapshot captured in memory BEFORE finalize git-rms prd.json. bump is non-idempotent so a mid-sequence failure escalates to the operator (recovery-runbook) and never auto-resumes. GITHUB_TOKEN stripped on gh mutations (keyring OAuth fallback).
- **Blockers encountered**: None on the ship. Two boot-time corrections: (1) operator believed a PR 149 had already merged; hard evidence (gh pr list empty for the head, main lacked ship-runner.ts, the last consumed.json was CAM-182's) proved it had not. (2) I mis-read a single strings-grep token as the binary lacking the ship-runner; a multi-token sweep proved the rebuild had landed (see memory binary-capability-multi-token-check).
- **Follow-ups**: Sidecar already runs 0.67.0 with the deterministic ship runner (no rebuild needed next cycle). Backlog: CAM-189 (surface reviewer SUGGESTIONs, P3), CAM-170 (surface merge-watch poll errors + consumer of the CAM-182 merge-watch-stalled event, stage:idea needs /cam-spec), CAM-177 (.dockerignore), CAM-180 (rebuild worker image), CAM-139 (autonomous meta-loop, unblocked).

## cam/pr-190-issue-list-derived-backlog — CAM-190 shipped: deterministic cam issue list as the single backlog source; orchestrator derives backlog live (boot + on-demand) and nextActions becomes ephemeral-only, killing stale-backlog propagation across respawns (v0.68.0, PR #141)

- **Started**: 2026-07-06
- **Closed**: 2026-07-06T02:55:28Z
- **Branch**: cam/pr-190-issue-list-derived-backlog (merged+pruned)
- **Issue**: CAM-190
- **Outcome**: shipped
- **Summary**: Made cam issue list the single deterministic source of the actionable backlog (open issues grouped by stage; shipped excluded since a shipped issue keeps status:open) and wired the orchestrator to derive the backlog live at boot and on-demand instead of trusting a hand-authored nextActions snapshot; nextActions is now ephemeral-only with a hard no-backlog rule. 5 stories, review round 1 CLEAN, v0.68.0, PR #141.
- **Decisions**: Root cause was found by verifying the reviewer and handoff code against runtime, not the issue premise: the handoff nextActions was fully LLM free-form with no deterministic re-derivation, copied forward verbatim across respawns (CAM-139 shipped in the morning still showed as unblocked backlog in the evening handoff). The fix was reframed to subsume CAM-74: one deterministic cam issue list command (reuses readBacklogFromMain, stage-based filter) used by both the terminal glance and the orchestrator boot and on-demand derivation. Greeting shows counts only, never per-issue enumeration. Decomposed into 5 stories: pure list.ts derivation, runIssueList core, CLI surface, boot and persona wiring, nextActions ephemeral-only doc-gate.
- **Blockers encountered**: None. Ship clean: gates green, v0.68.0 tagged and pushed, branch pruned, no stall marker.
- **Follow-ups**: ACTIVATION: CAM-190 changes the binary (cam issue list), the persona and the boot prompt; the running cam, sidecar and wrapper stay on 0.67.0 until a rebuild-reinstall plus cam stop and cam run, so the live orchestrator keeps the old boot behavior until then. SPEC NIT: the CAM-190 spec said sort and column by priority, but issues have no priority field (canonical order is rank from CAM-108); implement against rank. Remaining specified backlog filed and specced this session: CAM-189, CAM-170, CAM-177 (derive the live list via cam issue list once the rebuilt binary has it). CAM-180 is an operator ceremony (not autonomizable); CAM-139 already shipped.

## cam/pr-118-domain-docs-writer — CAM-118 shipped: deterministic CONTEXT.md/ADR writer plus cam spec --write-docs stdin channel; wedge-audit day, 6 hardening issues filed (v0.70.0, PR #143)

- **Started**: 2026-07-06
- **Closed**: 2026-07-06T14:57:00Z
- **Branch**: cam/pr-118-domain-docs-writer
- **Issue**: CAM-118
- **Outcome**: shipped
- **Summary**: Shipped the CAM-107 follow-up: pure render/merge helpers (src/domain-docs/render.ts), ref-only writeDomainDocsOnMain (one atomic commit-tree to main), cam spec --write-docs stdin-JSON entrypoint, and the /cam-spec persist step. 4 stories, review round 1 CLEAN, PR #143 squash-merged, v0.70.0 tagged by the sidecar post-merge automation (first fully autonomous post-merge). Session opened with the cycle wedged: image-stale false-positive (Dockerfile mtime touched by branch switch) hot-looped the implement preflight 55887 times, then a cam run restart orphaned the in-flight PRD at phase idle. Recovery: docker build --no-cache plus cam next.
- **Decisions**: Chain audit produced 6 issues on main (wedge auto-resume and evented refusals; meta_loop-aware orch boot; epic deterministic-CLI-or-pane; Node 18 in-container knip gap; gate tools unpinned; send-keys push loss with the busy-composer mechanism). Ship failed twice: unpinned bunx knip floated to a release flagging the pre-existing cam self-spawn (pinned 6.24.0 + ignoreBinaries), then the GATES manifest test I had not swept (updated). CAM-191 nudged with cam ship (3rd reproduction). Operator forbids Co-Authored-By trailers: branch history rewritten pre-merge, squash verified clean, preference saved to persistent memory.
- **Blockers encountered**: CAM-182 auto-recover fired live for the first time (PR BEHIND, update-branch attempt 1); my trailer force-push consumed attempt 2, cap exhausted but merge landed. Two send-keys reports stalled in the orch composer while mid-turn (evidence for the push-loss issue spec).
- **Follow-ups**: START HERE: rebuild-reinstall the binary to 0.70.0 (build-release.sh --install) and restart cam run BEFORE any /cam-spec (installed 0.68.0 lacks --write-docs); then check for a meta-loop auto-dispatched cycle in flight and narrate. Derive the backlog live via cam issue list.

## cam/pr-202-no-flaky-test-evasion — CAM-202 shipped: no-flaky-test-evasion guard (red gate is a hard-stop for workers)

- **Started**: 2026-07-06
- **Closed**: 2026-07-06
- **Branch**: cam/pr-202-no-flaky-test-evasion (merged+pruned)
- **Issue**: CAM-202
- **Outcome**: shipped
- **Summary**: PR #144, v0.71.0. Red-gate guard in readWorkerOutcome (src/supervisor/result.ts): a story marked passes:true whose recorded gate has a failing test is refused (US-001), plus the no-flaky-evasion hard-stop rule encoded in subagent-implementer.md and subagent-reviewer.md (US-002/003). The rule self-validated on its own ship: the US-002 worker hit a real flaky test (test/dashboard.test.ts 'k after j', a genuine pre-existing flake, likely the same one a CAM-66 worker tried to dismiss) and FIXED it deterministically with a waitForAccentLine poll instead of dismissing it, plus a knip --bun fix; that is what made the host check:all pass where CAM-66 had gone red. 3 stories, review CLEAN round 1.
- **Decisions**: Operator directive 2026-07-06 (memory feedback-no-flaky-test-evasion): a worker may NEVER dismiss a failing test as flaky/pre-existing/environmental/unrelated nor re-run to confirm flakiness; red gate is a hard-stop, fix the root cause or HALT+escalate. This session was triggered by a CAM-66 worker evading the same failure the CAM-66 skipIf had masked. Sequence agreed with operator: CAM-202 (no-flaky) then CAM-203 (targeting/rank bug) then CAM-201 (toolchain parity) then CAM-66 replan; operator wants everything automatic (Renovate automerge-all).
- **Blockers encountered**: Root incident: CAM-66 shipped RED because a worker masked a brittle Ink assertion via it.skipIf(bun<1.3); the container runs bun 1.2.23 while host/CI run 1.3.x, so both in-loop gates (implementer AND reviewer, both containerized) skip version-gated tests while the ship host check:all catches them. That is CAM-201's scope (filed+specified+ranked). Two plumbing bugs derailed the first attempt to plan CAM-201: (a) specifyIssueOnMain leaves rank:None so an unranked specified issue is never plan-selected; (b) /cam-plan <id> writes plan_issue but runPlanPhase.selectIssueFn ignores it and picks top-ranked, so /cam-plan CAM-201 planned CAM-66 instead. Both filed as CAM-203. Fixed the queue with cam triage (WSJF ranks: CAM-202=1, CAM-160=2, CAM-203=3, CAM-201=4, CAM-66=7). Manual sidecar re-establish is fiddly: killing the sidecar leaves a stale .cam-supervisor.lock (pid of dead sidecar) that blocks the fresh sidecar's implement supervision, and the plan-worker (auditor) pane lingers and trips the 2-pane mutex; fix is rm .claude/.cam-supervisor.lock + tmux -L cam kill-pane on the lingering pane. CAM-191 (auto-ship loses phase:shipping on CLEAN) still live on 0.71.0: re-arm with cam ship when CLEAN-without-ship.
- **Follow-ups**: REMAINING ARC (rank order, all specified+ranked): CAM-160 (rank 2, trivial gitignore) then CAM-203 (rank 3, targeting/rank fix) then CAM-201 (rank 4, toolchain parity: pin bun+Node via .bun-version/.tool-versions single source, CI bun-version-file, Dockerfile build-arg, Renovate app + automerge-all gated on green CI, a check:all guard forbidding version-conditional test skips but allowing platform/capability skips, a fail-closed preflight asserting container bun==.bun-version, and a sidecar auto-rebuild of the image on mismatch; closes CAM-198/192/180; 2 ADRs already written docs/adr/0010,0011) then CAM-66 replan (abandon the two dead cam/pr-66 branches, replan fresh on the fixed container). GUARD IS NOW LIVE only after the 0.71.0 rebuild+restart. Operator participation is spec-only; loop is otherwise autonomous. Watch every implementer/reviewer for evasion until habitual. When CAM-201 ships, its preflight+auto-rebuild only activates after another rebuild+restart to the CAM-201 version, and then the container finally moves to bun 1.3.x.

## cam/pr-160-templates-gitignore-worker-plan-logs — CAM-160 shipped: ignore cam-worker-out/cam-plan-out logs in templates/.gitignore + regenerate embed (v0.72.0, PR #145)

- **Started**: 2026-07-06
- **Closed**: 2026-07-06T19:18:31Z
- **Branch**: cam/pr-160-templates-gitignore-worker-plan-logs
- **Issue**: CAM-160
- **Outcome**: shipped
- **Summary**: Trivial gitignore hygiene: added .claude/.cam-worker-out-*.log and .claude/cam-plan-out-*.log ignore globs to templates/.gitignore so cam-init-seeded downstream projects avoid the clean-tree false-halt, and regenerated the embedded templates copy (src/vendor/_generated.ts). 1 story, review CLEAN round 1, 3404 pass / 0 fail, v0.72.0, PR #145 merged + tagged + pruned.
- **Decisions**: The first plan BLOCKed on a correct auditor finding (F-01): the embed-regeneration oracle targeted src/templates/embedded.ts, but that file is a hand-written runtime wrapper that only re-exports templatesContents. The real embedded artifact is src/vendor/_generated.ts (codegen of scripts/generate-embedded-vendor.ts; gate `bun run embed-vendor:check`). Verified the artifact roles against the live tree, not memory. The plan-runner has no BLOCK-to-re-plan loop (CAM-151 Half B unshipped), so it halted and handed the BLOCK back; re-ran /cam-plan CAM-160 and the planner self-corrected to APPROVE, then drove implement/review/ship autonomously.
- **Blockers encountered**: Two operator unblocks. (1) The re-plan stalled at phase:planning with no fresh planner because the prior BLOCKed run's auditor pane (%2) lingered as a 3rd pane, keeping paneCountMutex busy (plan-runner.ts:670 returns mutex-busy each tick); killed it by hand (tmux -L cam kill-pane) to restore count==2, and the planner spawned within 12s. This is CAM-167 (still open): CAM-188 teardown covers only runSupervisorLoop terminals, not the plan-runner BLOCK/timeout terminals. APPROVE does not hit this because the pane is immediately reused as the implementer slot; only the halting terminals leak it. (2) CAM-191 reproduced: review CLEAN set autoShipDispatchedAt but lost phase:shipping (loop idle, no PR); re-armed via /cam-ship. Ship + ci-gated auto-merge + tag + prune then ran fully autonomously.
- **Follow-ups**: CAM-167 (plan-runner BLOCK/timeout pane teardown, post-CAM-188 residual) and CAM-191 (auto-ship loses phase:shipping on CLEAN) both reproduced live this cycle and are the top autonomy-friction items. Binary and sidecar stay 0.71.0 (post-merge tags but does not reinstall); CAM-160's change only affects downstream cam init, so no rebuild is needed for this repo. Arc continues by rank: CAM-203 (auto-drain planning in flight at close) then CAM-201 then CAM-66 replan.

## cam/pr-204-plan-block-replan-loop — CAM-204 shipped: deterministic plan-runner BLOCK->re-plan loop

- **Started**: 2026-07-06T20:42:00Z
- **Closed**: 2026-07-06T21:47:00Z
- **Branch**: cam/pr-204-plan-block-replan-loop
- **Issue**: CAM-204
- **Outcome**: shipped
- **Summary**: On auditor audit-blocked, the plan-runner now feeds the plan-verdict-report.json findings back into a fresh planner (cap N=2 rounds), escalates durably on non-convergence, and tears down planner/auditor panes on every plan terminal. Implements CAM-151 Half B, which was marked shipped but never delivered. 5 stories + 1 review-fix round, review CLEAN. v0.73.0, PR #146.
- **Decisions**: Plan non-convergence is a hard-stop (escalated), never proceed-with-debt, asymmetric with the review loop MAX_ROUNDS_DEBT: an unsound PRD poisons every downstream story it spawns. ADR + glossary written via cam spec --write-docs. Filed and specified without an interactive grill (fix was well-understood).
- **Blockers encountered**: CAM-191 auto-ship wedge (review CLEAN + autoShipDispatchedAt set but phase went idle with no PR); re-armed via /cam-ship.
- **Follow-ups**: Binary rebuild pending to activate in the running sidecar (installed cam was v0.71.0).

## cam/pr-205-deterministic-init-tests — CAM-205 shipped: deterministic runInit tests (flaky-timeout root-cause fix)

- **Started**: 2026-07-06T22:55:00Z
- **Closed**: 2026-07-06T23:15:00Z
- **Branch**: cam/pr-205-deterministic-init-tests
- **Issue**: CAM-205
- **Outcome**: shipped
- **Summary**: Stubbed runInit's three real subprocess spawns (command -v claude, claude --version, bun smoke-script) via an injectable spawnFn seam, so test/init.test.ts is deterministic and no longer times out at 5000ms under check:all concurrent load. Root-cause fix for the flake that hard-stopped the CAM-203 ship gate. 1 story, review CLEAN. v0.74.0, PR #147.
- **Decisions**: First real application of the CAM-202 no-flaky-evasion rule: the red gate was NOT re-run to force green; the root was fixed. Filed as a SEPARATE issue (not silently fixed on CAM-203's branch) per surgical-changes discipline.
- **Blockers encountered**: CAM-191 auto-ship wedge again; re-armed via /cam-ship.

## cam/pr-203-plan-target-and-wsjf-fallback — CAM-203 shipped: honor explicit plan targets + WSJF fallback for rank:None

- **Started**: 2026-07-06T21:48:00Z
- **Closed**: 2026-07-06T23:35:00Z
- **Branch**: cam/pr-203-plan-target-and-wsjf-fallback
- **Issue**: CAM-203
- **Outcome**: shipped
- **Summary**: Honor explicit /cam-plan <id> targets end-to-end (invalid target fails loud, never a silent no-op) and make freshly-specified rank:None issues plannable via a single-sort-key WSJF fallback in selection. 4 stories, review CLEAN. v0.75.0, PR #148.
- **Decisions**: The auditor correctly BLOCKed the planner twice on an intransitive two-tier comparator (a genuine Array.sort total-order violation); resolved as a single comparable-scalar key. The issue SPEC was clean: the contradiction was planner-introduced in the PRD, not the spec, so /cam-spec was neither needed nor possible (specified issues cannot be re-spec'd). Blind re-plan converged on the 3rd attempt.
- **Blockers encountered**: Ship gate first hard-stopped on the unrelated CAM-205 flaky init timeout (halted per CAM-202, not evaded). Re-shipped after merging main (CAM-205 fix) into the branch, resolving a file-size-budget.json _ref conflict (numeric budgets auto-unioned), re-review CLEAN, and re-arming the ship past the CAM-191 wedge.
- **Follow-ups**: Binary rebuild to activate the selection change in the running sidecar. File the re-spec-gap follow-up (no supported path to re-spec a stage:specified issue).

## cam/pr-201-toolchain-parity — CAM-201 shipped: bun+Node toolchain parity, container claude-off-PATH regression fixed live

- **Started**: 2026-07-07
- **Closed**: 2026-07-07
- **Branch**: cam/pr-201-toolchain-parity
- **Issue**: CAM-201
- **Outcome**: shipped (PR #149, CI green, v0.76.0)
- **Summary**: Boot found CAM-201 code-complete (9 stories, 2x CLEAN) but the operator's cam run had wedged the container reviewer on image-stale and been cam-stopped. Diagnosed a four-layer container cascade: stale image (US-R3-001 touched the Dockerfile so mtime exceeded image Created), then the pre-CAM-201 binary only ensures the container at boot (removing the container mid-session left the reviewer exec-ing a missing container), then CAM-207 firewall re-entrancy (dnsmasq port 53 already-in-use on a reused container), then the root blocker: US-003 regressed claude off the container PATH. The round-3 reviewer independently caught the regression. Fixed via US-R3-002 (ENV PATH=/usr/local/lib/nodejs/bin), verified live (docker exec cam-worker env claude prints 2.1.197), re-reviewed round 4 CLEAN, shipped.
- **Decisions**: Operate via host (the documented default; container was a reverted CAM-175 temp ceremony) until container mode is validated. The claude-off-PATH fix landed on-branch as US-R3-002 because it is a self-introduced US-003 regression, not a separate pre-existing defect. In-place binary swap to the CAM-201 build (which adds per-cycle ensure) to unblock the loop. worker_isolation reverted to host in project.toml.
- **Blockers encountered**: Four container layers peeled: stale image (rebuilt --no-cache to move Created past mtime), missing container after mid-session rm (exposed 0.75.0 boot-only ensure, an orchestrator misstep, recovered), firewall port-53 re-entrancy on reused container (fresh container fixed it), claude off PATH (US-003 moved npm global to /usr/local/lib/nodejs/bin with only node/npm/npx symlinked). Root cause of the whole session: running the pre-CAM-201 binary. Auto-ship wedged (CAM-191); shipped via manual cam ship.
- **Follow-ups**: CAM-207 (sidecar dies on firewall-init failure, dnsmasq port 53; pre-existing, covers the re-entrancy). Post-merge housekeeping: closed CAM-192/198/180 (subsumed by CAM-201). Filed CAM-208 (auto-drain host-mode hot-spin), CAM-209 (Node tarball SHASUMS256), and the deterministic-CLI-completeness thread under the CAM-197 epic: CAM-210 (cam issue close/abandon CLI, functions already exist) and CAM-211 (--help guard on every command incl. the stray-sidecar safety bug + undocumented --file-local flags). Operator pivoted next-session priority to that CLI thread over the formal Specified queue; stay worker_isolation=host until the backlog is organized. Container-mode re-enable checklist: image already rebuilt with the ENV PATH fix (claude resolves), address CAM-207 before flipping back.

## cam/pr-210-issue-close-abandon-cli — CAM-210 shipped: cam issue close/abandon deterministic CLI (Layer-1 of CAM-197)

- **Started**: 2026-07-07
- **Closed**: 2026-07-07
- **Branch**: cam/pr-210-issue-close-abandon-cli
- **Issue**: CAM-210
- **Outcome**: shipped
- **Summary**: Exposed `cam issue close <id>` and `cam issue abandon <id>` as deterministic positional CLI subcommands wrapping the already-existing on-main mutations closeIssueOnMain/abandonIssueOnMain, plus a symmetric already-closed idempotency guard and a CAM_ISSUE_RESULT machine handback line. 3 agent stories, review CLEAN round 1, PR #150, v0.77.0. First concrete Layer-1 instance of the CAM-197 deterministic-CLI-exposure epic.
- **Decisions**: close sets stage:shipped and abandon sets status:abandoned (orthogonal axes; close moves stage, abandon moves status). The already-closed guard keys strictly on entry.stage==='shipped'; both shared callers (ship-pr.ts, post-merge.ts) were verified SAFE (they inspect result.ok and tolerate a failed close as warning-only). The CAM_ISSUE_RESULT machine handback line was added to close/abandon but intentionally NOT retrofitted onto the sibling --file-local/list paths (tracked as a follow-up). PRD kept lean at 3 stories, well under the review-convergence danger zone.
- **Blockers encountered**: The sidecar was dead at boot (a recycle-attach does not respawn it, only a fresh cam run session-create does); started a standalone sidecar. A wrong redirect of the manual sidecar log to a non-gitignored path dirtied the working tree and failed the plan-runner clean-tree preflight; fixed by redirecting to the gitignored .claude/cam-supervisor.log. Auto-ship wedged on review-CLEAN (CAM-191, unfixed in the installed 0.76.0), so the ship was re-armed manually via cam ship. The CAM-208 drain log spam under meta_loop=auto plus worker_isolation=host is cosmetic and does not block the planning/shipping branches.
- **Follow-ups**: Retrofit the CAM_ISSUE_RESULT machine line onto the sibling --file-local/list deterministic paths, and expose the /cam-spec spec-persist step as a deterministic CLI (both filed to main this session; derive via cam issue list). Continue the CAM-197 Layer-1 CLI-exposure thread. Rebuild plus reinstall to 0.77.0 so the new close/abandon subcommands are usable in the running binary.

## cam/pr-213-spec-persist-cli — CAM-213 shipped: cam spec --persist deterministic CLI (Layer-1 of CAM-197)

- **Started**: 2026-07-07T16:47:00Z
- **Closed**: 2026-07-07T17:29:37Z
- **Branch**: cam/pr-213-spec-persist-cli
- **Issue**: CAM-213
- **Outcome**: shipped
- **Summary**: Exposed `cam spec --persist <id>` as a deterministic in-process CLI that reads {spec, wsjf, blockedBy?} as JSON from stdin and calls specifyIssueOnMain (mirroring cam spec --write-docs), with a CAM_SPEC_RESULT=<id> sha=<sha> / =ERROR reason=<r> machine handback, and rewrote the /cam-spec final persist step (both .claude and templates copies) to pipe JSON into it instead of the inline TS snippet. 2 stories plus 1 round-1 fix, review CLEAN round 2. PR #151, v0.78.0. Completes the spec-persist half of the /cam-spec CLI-ification (the --write-docs half already existed); Layer-1 instance of the CAM-197 epic.
- **Decisions**: Handback: CAM_SPEC_RESULT=<id> sha=<sha> on success, =ERROR reason=<reason> on failure (mirrors the CAM_ISSUE_RESULT reason= convention from CAM-210 and the write-docs sha=). invalid-json is a persist-specific reason token (JSON.parse fails before specifyIssueOnMain runs). --persist does NOT re-validate: specifyIssueOnMain already validates spec+wsjf+integrity and enforces every guard; --persist only marshals stdin and maps the discriminated outcome, exactly like runSpecWriteDocs. Kept persist and write-docs as TWO separate commands (decision A), not folded into one payload, since --write-docs is already a tested CLI and folding would couple two on-main commits and exceed the issue scope. This CAM-213 spec was itself persisted via the OLD throwaway-bun-script anti-pattern because cam spec --persist did not exist yet: it is exactly what CAM-213 built.
- **Blockers encountered**: CAM-191 auto-ship wedge on review-CLEAN again (active:false / phase:idle / no PR); re-armed via manual cam ship. CAM-208 cosmetic drain log spam under meta_loop=auto + worker_isolation=host, ignored.
- **Follow-ups**: Rebuild+reinstall to 0.78.0 BEFORE the next /cam-spec: the on-main /cam-spec command now pipes into cam spec --persist, which is absent from the installed 0.77.0 binary, so the next persist would break until rebuilt. Continue the CAM-197 Layer-1 CLI-exposure thread (CAM-212 next: retrofit the CAM_ISSUE_RESULT machine line onto the sibling --file-local/list paths). Derive the live queue via cam issue list.

## cam/pr-212-issue-result-retrofit — CAM-212 shipped: cam issue --file-local CAM_ISSUE_RESULT retrofit + list machine-line-free (Layer-1 of CAM-197)

- **Started**: 2026-07-07T18:18:02Z
- **Closed**: 2026-07-07T18:46:00Z
- **Branch**: cam/pr-212-issue-result-retrofit
- **Issue**: CAM-212
- **Outcome**: shipped
- **Summary**: Retrofit the CAM_ISSUE_RESULT machine handback line onto `cam issue --file-local` mirroring the CAM-210 close/abandon convention (success CAM_ISSUE_RESULT=<id> via process.stdout.write after the existing `filed <id> on main (<sha>)` printHint; failures CAM_ISSUE_RESULT=ERROR reason=<token>, token from the createLocalIssueOnMain discriminated union {diverged|detached-head|missing-main|guardrail-failed} plus invalid-json for the stdin JSON.parse failure and exception for the catch block), and regression-lock `cam issue list` as deliberately machine-line-free. 2 stories, review CLEAN round 1, ci-gated merge. PR #152, v0.79.0. Concrete Layer-1 instance of the CAM-197 deterministic-CLI-exposure epic, after CAM-210 (close/abandon) and CAM-213 (spec-persist).
- **Decisions**: list handback (operator-approved grill option 1): `cam issue list` emits NO CAM_ISSUE_RESULT line. CAM_ISSUE_RESULT is a mutation-outcome contract (the id of the single acted-on issue, or ERROR reason=), scoped to create/close/abandon; list is a read with no id, so forcing CAM_ISSUE_RESULT=OK would pollute the contract. Locked by an explicit AC + regression test so a future reviewer does not flag list as forgotten. --file-local mirrors close/abandon exactly: success prints the printHint then process.stdout.write(CAM_ISSUE_RESULT=<id>); reason token from the createLocalIssueOnMain union, plus invalid-json (emitted before the create runs) and exception (catch block). Machine line always via process.stdout.write, never the human printHint/printError channels.
- **Blockers encountered**: CAM-191 auto-ship wedge on review-CLEAN again (active:false / phase:idle / no PR); re-armed via manual cam ship. CAM-208 cosmetic drain log spam under meta_loop=auto + worker_isolation=host, ignored.
- **Follow-ups**: Continue the CAM-197 Layer-1 thread; derive the next concrete instance live via cam issue list. Rebuild+reinstall to 0.79.0 only if the running binary needs the new --file-local machine line (not a gate on the next spec/plan/loop, since CAM-212 touched no command markdown). CAM-191 (auto-ship wedge) and CAM-208 (drain spam) remain unfixed.

## cam/pr-191-auto-ship-last-write — CAM-191 shipped: auto-ship phase:shipping is the last state-file write on the terminal complete path (outer-loop-owned)

- **Started**: 2026-07-07T20:08:58Z
- **Closed**: 2026-07-07T20:52:09Z
- **Branch**: cam/pr-191-auto-ship-last-write
- **Issue**: CAM-191
- **Outcome**: shipped
- **Summary**: Fixed the auto-ship-on-CLEAN wedge. On a terminal complete+CLEAN return in auto mode, the phase:shipping signal written by autoShipFn inside runSupervisor (loop.ts:850) was destroyed before the next sidecar tick could read it, by a deterministic 3-writer clobber chain on .claude/cam-loop.local.md: autoShipFn writes phase:shipping, then onProgress unlinks the file on complete (host.ts:713-719), then clearActive recreates it as phase:idle (loop.ts:1905). Result: CLEAN-without-ship, marker set, no PR. Fix: moved the whole auto-ship decision (CLEAN check + autoShipDispatchedAt marker + setPhase shipping) out of runSupervisor into runSidecarLoop AFTER clearActive, symmetric with the auto-chain flipActive block, so phase:shipping is the last state-file write and survives teardown; dropped the autoShipFn param from runSupervisor; gated strictly on complete (never awaiting-operator); exported makeClearActive; added a real-writer regression test that fails against pre-fix code. 2 stories, review CLEAN round 1, ci-gated merge. PR #153, v0.80.0.
- **Decisions**: Outer-loop-owned (grill A/A1, operator-approved): auto-ship decision moved fully to runSidecarLoop after clearActive so phase:shipping is the LAST write, surviving the onProgress unlink and clearActive idle-rewrite. autoShipFn param dropped from runSupervisor (single owner, no split-brain); fire-once preserved via the prd.json marker plus the once-per-complete property of the active-tick-only outer block. Rejected teaching clearActive+onProgress to preserve shipping (two fragile special-cases). ADR 0013 records this and SUPERSEDES the callsite of ADR 0008 (CAM-181) while preserving 0008 anchoring semantics (complete-gated, persisted marker, await-operator elimination). Regression lock: integration test with REAL setPhase/clearActive/onProgress writers on a real temp state file, must fail against pre-fix code.
- **Blockers encountered**: Dogfood irony: this session's own ship hit the very CAM-191 wedge it fixes, because the running sidecar (pid 77460, 0.79.0) predates the fix: review CLEAN + autoShipDispatchedAt marker set + phase clobbered to idle + no PR. Re-armed manually via phase:shipping (cam ship), then ci-gated merge went green. CAM-208 cosmetic drain log spam under meta_loop=auto + host mode, ignored.
- **Follow-ups**: Rebuild+reinstall to 0.80.0 to activate the fix in the running sidecar; until then the next cycle auto-ship still wedges and needs manual re-arm. After rebuild, auto-ship should work end-to-end (the point of CAM-191). Derive the next priority live via cam issue list.

## cam/pr-208-auto-drain-host-gate — CAM-208 shipped: gate meta_loop=auto dispatcher arming on worker_isolation=container (host-mode no-op with one boot warn instead of 2s hot-spin)

- **Started**: 2026-07-07T21:05:00Z
- **Closed**: 2026-07-07T21:34:00Z
- **Branch**: cam/pr-208-auto-drain-host-gate
- **Issue**: CAM-208
- **Outcome**: shipped
- **Summary**: Fixed the meta-loop auto-drain hot-spin: with meta_loop=auto plus worker_isolation=host, buildMetaLoopFn (src/commands/sidecar.ts) armed the auto-dispatcher on meta_loop alone, so every ~2s idle tick evaluateDrainPreconditions returned container-not-active and both warned to stderr and appended a meta-loop-dispatch{refused} event, spamming logs and console. Fix: gate the meta_loop==='auto' branch on readWorkerIsolation; in host mode emit one boot-time warn and return undefined so the dispatcher is never armed (the loop seam guard then never calls it). 1 story (US-001), review CLEAN round 1, ci-gated merge. PR #154, v0.81.0.
- **Decisions**: Guard location (grill Q1 option A, operator-approved): do NOT arm the dispatcher in host mode (return undefined from buildMetaLoopFn), rather than silencing per-tick (B) or backing off (C), because host mode is a permanent config mismatch where auto-chaining is structurally impossible, so cut at the root. Observability (grill Q2 option A2): emit exactly one boot-time warn instead of total silence, so auto+host is not a silent no-op. Asymmetry preserved: host (permanent, read at boot) does not arm; container with Docker preflight not-ready (transient) keeps the per-tick refuse in evaluateDrainPreconditions, so the gate is boot-time static, not moved into the precondition. No new ADR (0007 already covers container-gating; this is an implementation refinement); added meta_loop, worker_isolation, and auto-drain glossary terms to CONTEXT.md.
- **Blockers encountered**: None in the cycle. Notable positive milestone: the auto-ship ran end-to-end with NO wedge (phase:shipping survived teardown, PR, CI, merge, tag, and close all autonomous), the first production validation of the CAM-191 fix. It is live because this session restarted the sidecar 0.79.0 to 0.80.0 at boot; prior cycles (CAM-191, CAM-212, CAM-213) had to manually re-arm ship because the running sidecar predated the fix.
- **Follow-ups**: Rebuild+reinstall to 0.81.0 (operator committed) then restart the sidecar (pid 51172) to activate the CAM-208 fix and stop the residual auto-drain spam: the running 0.80.0 sidecar still has the bug, and the spam resumed at idle post-merge. Not a gate on the next spec/plan/loop; purely cosmetic. Derive the next priority live via cam issue list.

## cam/pr-170-merge-watch-poll-error — CAM-170 shipped: surface merge-watch gh poll failures (discriminated GhPollFn, persisted consecutive-error counter, edge-triggered merge-watch-poll-error at threshold N)

- **Started**: 2026-07-07T21:41:51Z
- **Closed**: 2026-07-07T22:29:55Z
- **Branch**: cam/pr-170-merge-watch-poll-error
- **Issue**: CAM-170
- **Outcome**: shipped
- **Summary**: Made muted merge-watch poll failures loud and diagnosable instead of spinning silently to the 4h timeout. US-001 added the merge-watch-poll-error event kind + detail type and a persisted consecutiveNullPolls counter on MergeWatchState (mirroring pollCount). US-002 changed GhPollFn from PrStatus-or-null to a discriminated result (PrStatus on a successful poll, or an error result carrying the gh stderr), threaded the counter through the pure stepMergeWatch with an edge-triggered emit at exactly N=3, and propagated the signature to the production gh pr view wrapper and every test fake. 2 stories, review CLEAN round 1, ci-gated merge. PR #155, v0.82.0.
- **Decisions**: Emit-once implemented as a transition to exactly N (=== N), not a >= N test, so ticks past the threshold do not re-emit; a successful poll resets consecutiveNullPolls to 0 and re-arms the single emit. The counter increments ONLY on the discriminated error result, never on a successful not-merged (OPEN) poll, made explicit by the discriminated return. poll-error is advisory mid-watch and distinct from the terminal merge-watch-stalled (CAM-182): a run that fails consecutively then recovers (e.g. after a token rotation) emits merge-watch-poll-error but not merge-watch-stalled, and proceeds to MERGED normally. No token auto-rotation or re-read, and no new early terminal (out of scope).
- **Blockers encountered**: None affecting cycle correctness. Two self-inflicted false alarms worth recording. (1) I briefly diagnosed the boot-restarted standalone cam sidecar as not driving the plan phase because cam-supervisor.log was frozen; the plan-runner logs to cam-worker-events.jsonl, not supervisor.log, so a frozen supervisor.log during planning is expected and the loop was healthy (captured in memory supervisor-log-vs-events-jsonl-liveness). (2) A monitor script broke early on a false PR-exists positive: gh pr list with -q '.[0]|"..."' on an empty array returns the literal string 'PR#null null'; fixed with '.[0].number // empty'.
- **Follow-ups**: Second consecutive fully-autonomous ship after CAM-208; CAM-191 auto-ship and the CAM-208 host-mode drain gate are both validated live on the 0.81.0 sidecar this session restarted at boot (killed stale 0.80.0 pid 51172). Intra-cycle plan->implement->review->ship auto-chaining confirmed to work in host mode; only the inter-cycle meta-loop drain stays container-gated. Rebuild to 0.82.0 is optional (not a correctness gate). Continue the WSJF specified queue; derive the next priority live via cam issue list.

## cam/pr-177-dockerignore-worker-image — CAM-177 shipped: allowlist .dockerignore for the cam-worker image build context

- **Started**: 2026-07-07T22:38:00Z
- **Closed**: 2026-07-07T23:02:14Z
- **Branch**: cam/pr-177-dockerignore-worker-image
- **Issue**: CAM-177
- **Outcome**: shipped
- **Summary**: Added a repo-root allowlist .dockerignore so the cam-worker (.devcontainer) image build stops tarring the whole repo (4.9G seen in CAM-175) to the docker daemon. Four ordered lines (star; !.devcontainer; .devcontainer/star; !.devcontainer/claude-config.json) preceded by a header comment documenting the ignore-all-but-one rule and that a future Dockerfile COPY needs a matching allow line; golden-fixture test at test/dockerignore.test.ts. 1 story (US-001), review CLEAN round 1, ci-gated merge. PR #156, v0.83.0.
- **Decisions**: Single story: the .dockerignore + golden-fixture test as one deliverable, with the docker-build behavioral proof as an AC WITHIN US-001 rather than a separate operator-requires story; the implementer ran that proof live (docker on host, exit 0). Allowlist idiom requires BuildKit last-match-wins and the .devcontainer dir must be un-ignored (!.devcontainer) before re-including the nested claude-config.json, hence the 4-line form. With -f .devcontainer/Dockerfile the Dockerfile is read directly (not from context), so excluding it via star is fine.
- **Blockers encountered**: None. THIRD consecutive fully-autonomous ship (CAM-208 -> CAM-170 -> CAM-177): plan -> audit APPROVE -> implement -> review CLEAN r1 -> auto-ship -> CI -> merge -> tag -> close -> prune, zero manual intervention. Restarted the sidecar at boot (killed stale 0.81.0 pid 29249, launched 0.82.0 pid 60210) to match the operator rebuild; CAM-208 host-gate boot warn fired, no drain spam.
- **Follow-ups**: Rebuild to 0.83.0 is optional (CAM-177 added only a .dockerignore + test, no runner/command change). Continue the WSJF specified queue; derive the next priority live via cam issue list. Final gate: typecheck ok, 3715 pass / 0 fail.

## cam/pr-66-dashboard-truncate-loop-ghost — CAM-66 shipped: truncate long story titles in the list + harden the Loop-header ghost (dashboard polish)

- **Started**: 2026-07-07T23:09:00Z
- **Closed**: 2026-07-07T23:56:18Z
- **Branch**: cam/pr-66-dashboard-truncate-loop-ghost
- **Issue**: CAM-66
- **Outcome**: shipped
- **Summary**: Two dashboard render fixes from dogfood. US-001 truncates long story titles in the Stories list rows with a trailing ellipsis at a fixed width (the full title is still readable in the CAM-50 per-story detail subview, so no PRD schema change). US-002 hardens the Loop section header against ghosting/duplication under resize/reflow storms. Pure src/ui/Dashboard.tsx + src/commands/dashboard.ts change, 2 non-operator stories, review CLEAN round 1, ci-gated merge. PR #157, v0.84.0.
- **Decisions**: Operator picked CAM-66 in sequence (rank 7, top of the WSJF specified queue after CAM-177). Already stage:specified, so no grill. Planner made 2 autonomous stories; auditor APPROVED round 1 and runPostAuditAction auto-chained active:true + phase:implementing in host mode with no manual cam next. US-001 approach (operator-chosen at spec time): truncate the list row rather than change the PRD schema, since the detail subview already shows the full title.
- **Blockers encountered**: None in the cycle. Significant milestone: this was the CAM-66 REPLAN. CAM-66 previously shipped RED because a worker masked a version-gated Ink assertion via it.skipIf(bun<1.3) (container bun 1.2.23 vs host/CI 1.3.x skipped the test in-loop while the ship host check:all caught it). It was abandoned and requeued behind the CAM-202 (no-flaky-evasion) / CAM-203 (plan-targeting + rank) / CAM-201 (toolchain parity) arc. This replan shipped CLEAN round 1 with 3728 pass / 0 fail and no evasion, the live validation that the arc closed the root cause.
- **Follow-ups**: FOURTH consecutive fully-autonomous ship (CAM-208 -> CAM-170 -> CAM-177 -> CAM-66): plan -> audit APPROVE -> implement -> review CLEAN r1 -> auto-ship -> CI -> merge -> tag -> close -> prune, zero manual intervention. Sidecar pid 60210 (0.82.0) drove it end-to-end; not restarted at boot since it already matched. Rebuild to 0.84.0 is optional (CAM-66 was a pure UI change, no runner/command behavior change). Continue the WSJF specified queue; next candidates by rank are CAM-83 (8), CAM-92 (9), CAM-115 (10). Derive the next priority live via cam issue list.

## cam/pr-83-dashboard-session-cost-elapsed — CAM-83 shipped: session-cumulative token cost and total session elapsed in the dashboard Loop header

- **Started**: 2026-07-08T00:00:00Z
- **Closed**: 2026-07-08T00:54:49Z
- **Branch**: cam/pr-83-dashboard-session-cost-elapsed
- **Issue**: CAM-83
- **Outcome**: shipped
- **Summary**: Dashboard session-cost observability (P2, supports CAM-71 prolonged autonomous use). US-001 tracks the sidecar session start and renders total session elapsed in the Loop header. US-002 accumulates the session-cumulative worker-token total from the event log and renders it in the header. Cost is shown in tokens, not USD, since the price varies by model tier the cam does not know. Two non-operator/autonomous stories touching DashboardData plus src/ui/Dashboard.tsx (and supervisor session-start tracking), review CLEAN round 1, ci-gated merge. PR #158, v0.85.0.
- **Decisions**: Operator picked CAM-83 in rank sequence (rank 8, top of the WSJF specified queue after CAM-66) and had rebuilt the binary to 0.85.0 at boot. Already stage:specified, so no grill. Planner produced 2 non-operator stories matching the issue spec exactly (US-001 sessionStartTs at startup plus render elapsed; US-002 accumulate totalTokens from the EventLog plus render). Auditor APPROVED round 1 and runPostAuditAction auto-chained active:true plus phase:implementing in host mode with no manual cam next. Did NOT restart the sidecar at boot: running pid 60210 is 0.82.0 and the rebuild to 0.85.0 was on-disk only; assessed as not a correctness gate because 0.83 (.dockerignore) and 0.84 (dashboard UI) touched neither the plan-runner nor the supervisor loop, and the implementer edits branch source not the compiled binary. pid 60210 drove the cycle end-to-end.
- **Blockers encountered**: None in the cycle. US-002 raised the test-file-size budget for test/dashboard.test.ts itself during implement (worker has Write; normal self-raise per the orch-no-hardkill-on-filesize-story convention, not a disfunction). Test count moved 3728 to 3778 (US-001) to 3749 (US-002), all 0 fail; the net fluctuation between the two per-story reports is benign.
- **Follow-ups**: FIFTH consecutive fully-autonomous ship (CAM-208 to CAM-170 to CAM-177 to CAM-66 to CAM-83): plan to audit APPROVE to implement to review CLEAN r1 to auto-ship to CI to merge to tag to close to prune, zero manual intervention. Sidecar restart to 0.85.0 is optional (not a correctness gate; CAM-83 added dashboard/supervisor behavior but the running sidecar drives via its own compiled code, which is behaviorally identical for orchestration). Continue the WSJF specified queue; derive the next priority live via cam issue list. Final gate: typecheck ok, 3749 pass / 0 fail.

## cam/pr-92-narrate-report-helper — CAM-92 shipped: dedupe notifyOrchestrator blocks in loop.ts behind private helpers

- **Started**: 2026-07-07
- **Closed**: 2026-07-08
- **Branch**: cam/pr-92-narrate-report-helper
- **Issue**: CAM-92 (#159)
- **Outcome**: shipped (PR #159, v0.86.0)
- **Summary**: Extracted private narrateReport()/notifyBlocked()/blockedResult helpers in src/supervisor/loop.ts, deduping the CAM-78 inline notifyOrchestrator blocks (3 report-narration sites + 7 blocked-terminal template lines) to a single source, and lowered the loop.ts file-size ceiling to 1928. Review round 1 CLEAN, 3748 tests pass / 0 fail.
- **Decisions**: The PRD was self-contradictory and had burned 10 consecutive implementer sessions (all BLOCKED_AMBIGUITY): AC1-3 dedup collapses the formatWorkerReportSummary( call-site count in loop.ts from 3 to 1, but a pre-existing CAM-94 static-grep test (AC7) pinned it at 3 and AC4 forbade touching existing supervisor tests. Operator authorized a surgical prd.json amendment relaxing AC4 to permit deleting the superseded AC7 test (its intent already covered by the runtime AC2/AC5 tests plus the new AC1-3 oracles). A static source-text-count test is brittle against a legitimate dedup; runtime behavior tests survive it.
- **Blockers encountered**: 10-session BLOCKED_AMBIGUITY wedge from the contradictory AC, resolved by the operator-authorized PRD amendment (not an 11th implementer attempt). Auto-ship succeeded in host mode; merge-watch recovered a BEHIND PR via gh pr update-branch before the squash, so the CAM-121 clobber hazard (CAM-214 filed on main mid-cycle) did not bite.
- **Follow-ups**: CAM-214: harness circuit-breaker for repeated identical BLOCKED_AMBIGUITY on the same story ID with an unchanged PRD (halt + escalate instead of re-spinning).

## cam/pr-115-review-suggestion-followups — CAM-115 shipped: follow-ups dos SUGGESTIONs do review do CAM-106

- **Started**: 2026-07-08
- **Closed**: 2026-07-08
- **Branch**: cam/pr-115-review-suggestion-followups
- **Issue**: CAM-115 (#160)
- **Outcome**: shipped
- **Summary**: Enderecou as 4 SUGGESTIONs nao-bloqueantes diferidas do review do CAM-106: selectPlannableFromFile passa a retornar null e propagar erro real (em vez de engolir pra undefined), alinhamento do seam de fonte-de-verdade com a prosa do cam-plan, remocao do clock/ClockFn orfao em ship-finalize.ts, e limpeza dos review findings stale no verdict CLEAN. Version 0.86.0 para 0.87.0, tag v0.87.0.
- **Decisions**: Review round 1 achou 1 CRITICAL: US-001 fez selectPlannableFromFile passar a THROW em erro de leitura/parse e guardou a fn OBSERVE de producao, mas deixou a fn AUTO/DISPATCH desprotegida; no idle tick de meta_loop=auto+container (loop.ts:1811, sem try/catch) um backlog corrompido crasharia o sidecar long-lived, o exato vetor que US-001 queria fechar. Corrigido em US-R1-001 (guard no caller AUTO/DISPATCH), round 2 CLEAN.
- **Blockers encountered**: O plan de CAM-115 travou no primeiro disparo: o clean-tree preflight (git status --porcelain, untracked-sensitive) recusou porque .claude/.cam-sidecar-session.json estava untracked e nao-gitignored, revertendo phase pra idle sem marker durável nem notify (pareceu que o sinal nunca disparou). Diagnostico via Explore confirmou o gap de surfacing. Mitigado removendo o arquivo runtime (recriável no proximo cam run boot); o fix definitivo (gitignore + surfacing) foi filado como CAM-215.
- **Follow-ups**: CAM-215 (idea): gitignore do .cam-sidecar-session.json + marker durável/boot-read/notify pro plan-preflight-failed analogo a ship-stalled/plan-escalated + tratar o fallback silencioso plan-target-invalid->top-specified. Proxima acao do operador: /cam-spec CAM-215 (idea->specified) entao /cam-plan.

## cam/pr-215-plan-preflight-failed-surfacing — CAM-215 shipped: durable plan-preflight-failed marker + notify + boot-read, gitignore runtime trigger

- **Started**: 2026-07-08
- **Closed**: 2026-07-08
- **Branch**: cam/pr-215-plan-preflight-failed-surfacing
- **Issue**: CAM-215 (#161)
- **Outcome**: shipped
- **Summary**: Closed the silent plan-preflight-failure gap. Added a durable .claude/.cam-plan-preflight-failed.json marker (shape { step, detail, writtenAt }, no issueId) written when a plan preflight fails, an explicit preflight-failed arm in runPostAuditAction that fires notifyFn and returns a distinct result kind, Option B removal (any non-preflight-failed plan result clears the marker), and orchestrator boot step 9 that surfaces it. Also gitignored the three untracked runtime artifacts (the .cam-sidecar-session.json trigger, the latent .cam-ship-stalled.json sibling, and the new marker). 5 auto stories, review CLEAN round 1, ci-gated merge, v0.87.0 to v0.88.0, PR #161.
- **Decisions**: Grill decisions: (1) removal semantics Option B (marker present iff the last plan attempt died in preflight) over mirroring plan-escalated convergence-only removal, since preflight-failed is issue-agnostic; (2) dropped issueId from the schema (preflight failure is an environment problem, not an issue problem); (3) full detail in the durable marker, first-line plus (+N more) truncation on the volatile notify and boot surfaces; (4) folded in the latent .cam-ship-stalled.json gitignore gap (identical bug class, one line); (5) mirror plan-escalated conventions (writtenAt, writer-seam clock split, distinct PostAuditActionResult kind). ADR 0014 records: clean-tree preflight stays untracked-strict, false-refusals resolve via gitignore plus surfacing, never by loosening to -uno.
- **Blockers encountered**: None in the cycle. PR #161 went BEHIND before merge; merge-watch recovered it via gh pr update-branch (attempt 1/2) and squash-merged clean. Installed cam binary is 0.85.0 (behind main 0.88.0) but drove plan/implement/review fine since the plan-runner and supervisor are behaviorally stable.
- **Follow-ups**: (1) plan-target-invalid to top-specified silent fallback: planning an idea-stage issue silently plans the top-specified issue instead (bit in the CAM-115 session where /cam-plan on CAM-215-as-idea planned CAM-115); NOT covered by CAM-215 as filed, candidate to file. (2) Doc drift: subagent-orchestrator.md self-handoff section references cam journal append --cycle-close, but journal.ts parses only --force; recycle is armed by the orch-recycle-watch context backstop (CAM-163), not a journal flag. Candidate to file.

## cam/pr-217-journal-cycle-close-help — CAM-217 shipped: document --cycle-close in JOURNAL_HELP + exit-3 in the agent doc

- **Started**: 2026-07-08
- **Closed**: 2026-07-08
- **Branch**: cam/pr-217-journal-cycle-close-help
- **Issue**: CAM-217 (#162)
- **Outcome**: shipped
- **Summary**: Narrowed doc and help-text fix, no runtime change. US-001 documented --cycle-close and the exit-code contract (exit 1 invalid/duplicate JSON, exit 3 handoff absent, exit 4 no live watcher) in JOURNAL_HELP plus a static test. US-002 added the exit-3 refuse-to-arm case to the subagent-orchestrator.md Self-handoff lifecycle section (both dual copies plus embed). Review CLEAN round 1, 2 stories, v0.88.0 to v0.89.0, PR #162.
- **Decisions**: The filed premise (recycle drift, --cycle-close broken, recycle only via context-backstop) was FALSE. The flag and the recycle arm live in index.ts (parseJournalArgs at index.ts:1258, arm block at index.ts:1367-1399 that checks handoff-present then watcher-alive then writes ORCH_RECYCLE_MARKER), NOT in the pure library src/commands/journal.ts (which only knows --force). cam journal append --cycle-close works as documented, tested in test/commands/journal-append.test.ts, shipped in CAM-162. Operator approved narrowing CAM-217 to the sole real gap: JOURNAL_HELP omitted --cycle-close, which caused the original misdiagnosis (grepping the pure lib alone). Meta-lesson: verify CLI flags against the dispatcher index.ts, not just the pure library.
- **Blockers encountered**: None. Both follow-ups filed from the CAM-215 session narrative (CAM-216, CAM-217) turned out to describe pre-fix behavior or the wrong file; the spec-stage Explore grounding caught both before any wasted implementation. CAM-216 (plan-target-invalid silent fallback) was abandoned as already fixed by CAM-203; CAM-217 was narrowed to the help-doc gap.
- **Follow-ups**: None material. This cycle closes the CAM-215/216/217 family (silent and misleading paths in the plan and handoff flow): CAM-215 shipped the plan-preflight-failed marker, CAM-216 was already solved by CAM-203 (abandoned), CAM-217 fixed the JOURNAL_HELP discoverability gap.

## cam/pr-120-jscpd-dedup-ratchet-down — CAM-120 shipped: jscpd dedup ratchet back to 4 via shared arg-parse + check-script helpers

- **Started**: 2026-07-08
- **Closed**: 2026-07-08
- **Branch**: cam/pr-120-jscpd-dedup-ratchet-down
- **Issue**: CAM-120 (#163)
- **Outcome**: shipped
- **Summary**: Reversed the jscpd threshold regression (4.0 to 5.0) introduced by the CAM-107 ship. 3 auto stories: US-001 extracted shared ratchet-diff/spawn helpers between check-coverage.ts and check-file-sizes.ts; US-002 extracted a shared subcommand arg-parse helper in index.ts (spec/plan/issue); US-003 ratcheted the .jscpd.json threshold back down to 4. All 3 GREEN (typecheck ok, 3802 pass / 0 fail). Review CLEAN round 1. Shipped v0.89.0 to v0.90.0, PR #163, CI pass 1m53s, squash-merged ci-gated.
- **Decisions**: Fully autonomous cycle (meta_loop=auto): plan approved by auditor round 1, sidecar drove implement->review->ship with no operator gating.
- **Blockers encountered**: Post-merge failed with pull-failed: local main carried an unpushed direct commit (notify.resend_recipient config, filed with CAM-218) that the plan runner branched from; the squash-merge of #163 diverged origin/main from local main so post-merge git pull broke. Root cause is a direct commit to local main left unpushed before the loop cut the branch (the no-direct-main-commit-mid-loop class). Recovery by orchestrator: git reset --hard origin/main (the unpushed commit's content was preserved intact inside the #163 squash, verified), manual git tag v0.90.0 at the merge SHA + push (cam tag no-op'd because the installed binary is stale at 0.89.0 and reads its baked-in version, not src/version.ts), close CAM-120 stage:shipped via commit-tree + push, then this journal append.
- **Follow-ups**: Installed cam binary is stale at 0.89.0: rebuild+reinstall to 0.90.0 so cam tag reads the shipped version. Consider hardening post-merge to reconcile a diverged local main automatically (reset to origin/main when the local-ahead commits are content-subsumed by the squash), tracked-adjacent to CAM-174.

## cam/pr-128-cam108-review-suggestions — CAM-128 shipped: resolve the 3 non-blocking SUGGESTIONs from the CAM-108 review

- **Started**: 2026-07-08
- **Closed**: 2026-07-08
- **Branch**: cam/pr-128-cam108-review-suggestions
- **Issue**: CAM-128 (#164)
- **Outcome**: shipped
- **Summary**: 3 auto stories resolving the non-blocking SUGGESTIONs from the CAM-108 review (PR #87): US-001 unified the triage warnings source between the no-op and commit paths; US-002 made the never-read RunTriageOptions.clock optional; US-003 refactored runKahn out of the biome noExcessiveCognitiveComplexity suppression and dropped rank.t. All GREEN (typecheck ok, 3804 pass / 0 fail). Review CLEAN round 1. v0.90.0 to v0.91.0, PR #164, ci-gated squash-merge, CI green.
- **Decisions**: Fully autonomous (meta_loop=auto): auditor approved round 1, sidecar drove implement->review->ship with no operator gating. Binary was rebuilt+reinstalled to 0.90.0 earlier this session, fixing the stale-binary cam-tag no-op from CAM-120.
- **Blockers encountered**: None. Post-merge completed fully automatically (pull + tag v0.91.0 + close CAM-128 + prune), unlike CAM-120 whose post-merge broke on pull-failed from an unpushed direct-to-main commit; here local main was fully pushed when the branch was cut, so the divergence root cause was absent.
- **Follow-ups**: CAM-219 filed this session (P3, defer to release hardening): build-release hermetic init smoke emits a false-positive 'Resend not configured' warning; fix = add --plan-approval operator to the smoke invocation at build-release.sh:114.

## cam/pr-125-journal-archive — CAM-125 shipped: deterministic GC of journal.md (cam journal archive) at cycle close

- **Started**: 2026-07-08
- **Closed**: 2026-07-08
- **Branch**: cam/pr-125-journal-archive
- **Issue**: CAM-125
- **Outcome**: shipped
- **Summary**: Added `cam journal archive [--threshold N]`: a deterministic GC that moves the oldest third of journal.md entries to journal.archive.md on main when the entry count exceeds a configurable threshold (default 50), via the same commit-tree-to-main plumbing the journal writer uses. Auto-invoked on the --cycle-close path so the journal self-bounds. Shipped fully autonomous (meta_loop=auto): plan converged auditor-APPROVE, 4/4 non-operator stories, review CLEAN round 1, ship ci-gated merged clean at v0.92.0.
- **Decisions**: Archive threshold is configurable (default 50) and the move is a pure oldest-third slice, keeping the newest two-thirds hot in journal.md. US-004 retired the old manual archive rule from the templates + agent files so the deterministic path is the single source of truth.
- **Follow-ups**: Installed cam binary still at 0.90.0 (shipped code 0.92.0); a rebuild+reinstall gives cam-tag version-parity and lands the archive feature in the installed binary. Non-blocking (post-merge auto-tag works).

## cam/pr-189-suggestion-followups — CAM-189 shipped: surface reviewer SUGGESTIONs as auto-filed idea follow-ups before cycle close

- **Started**: 2026-07-08
- **Closed**: 2026-07-08
- **Branch**: cam/pr-189-suggestion-followups
- **Issue**: CAM-189 (#166)
- **Outcome**: shipped
- **Summary**: Makes review SUGGESTIONs durable instead of losing them when review-report.json is overwritten or the pane is torn down. 3 auto stories. US-001 carried SUGGESTION findings through the reviewer CLEAN exit report (both no-oracle and with-oracle CLEAN templates stopped forcing an empty findings array) plus re-embed. US-002 added the suggestion fingerprint (stable short hash of normalized file/line/text), the follow-up builder, and dedup helpers. US-003 files SUGGESTION follow-ups at the terminal review verdict via createLocalIssueOnMain (on-main commit-tree, no claude spawn), dedups against the open backlog and within the batch, pushes a one-line pane summary, and is a silent no-op on zero SUGGESTIONs. All GREEN (typecheck ok, 3900 pass / 0 fail). Review CLEAN round 1. v0.92.0 to v0.93.0, PR #166, ci-gated squash-merge, CI green.
- **Decisions**: Fully autonomous (meta_loop=auto): auditor APPROVE round 1, sidecar drove implement to review to ship with no operator gating. Verdict CLEAN now means 'no blocking findings', not 'no findings'; decide.ts terminal detection keys off TERMINAL_VERDICTS (the verdict string), never findings length, with a regression test so a future refactor cannot start gating on findings emptiness. The auto-file path is deterministic in the sidecar (no claude spawn), uses the on-main commit-tree path, and treats a diverged main as skip-and-warn.
- **Blockers encountered**: None for the ship. Post-merge completed fully automatically (pull, tag v0.93.0, close CAM-189); local main was fully pushed when the branch was cut, so no divergence.
- **Follow-ups**: The running sidecar binary predates CAM-189 (loop-binary-branch-coherence), so it did not auto-file this cycle's own 2 review SUGGESTIONs; the orchestrator preserved them manually via cam issue as CAM-220 (doc-gate for the reviewer CLEAN-findings test covers only the dev and embedded copy, not the raw template copy; non-blocking, transitively covered by embed-vendor:check) and CAM-221 (suggestion-filing crash path reuses the sidecar-exit event kind instead of a dedicated kind; cosmetic). Rebuild+reinstall the sidecar to 0.93.0 so the CAM-189 auto-file path is live on future cycles and cam-tag has version-parity. Out of scope in the issue: non-blocking WARNING findings surviving a CLEAN are a separate follow-up.
