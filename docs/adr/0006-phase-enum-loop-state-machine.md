# ADR 0006: Maquina de estados do loop via enum LoopPhase

- **Status**: aceito (implementado em CAM-151)
- **Data**: 2026-07-01

## Contexto

Antes de CAM-151, o sidecar usava um campo booleano `active` como unica gate do loop: `active:true` despachava o implementer, `active:false` mantinha o loop em espera. Essa representacao nao distinguia fases dentro do loop (planejar vs implementar vs rever vs aguardar operador), o que tornava o roteamento implicito no codigo do sidecar. O planner e o auditor rodavam como Task subagents dentro do fluxo LLM do `/cam-plan` (descrito em ADR 0004), sem sinalizacao de estado legivel pelo sidecar.

Tres gates definem quando uma decisao merece um ADR:

1. **Dificil de reverter**: substituir o campo `active: bool` pelo enum `LoopPhase` como fonte de verdade afeta (a) o template `vendor/cam-loop.local.md.tmpl` (campo `{{PHASE}}`), (b) todos os leitores do arquivo de estado (`parseStateFile`, `makeReadLoopPhase`), (c) `renderStateFile` (agora deriva `active` de `phase`), (d) os escritores (`runNext`, `runPlan`, `makeSetPhaseFn`, `runPostAuditAction`), e (e) o loop externo do sidecar (`runSidecarLoop`, que agora tem uma branch `phase:planning` ao lado das branches `idle` e `implementing`). Reverter exigiria reescrever todos esses pontos e restaurar a representacao bool.

2. **Surpreendente sem contexto**: o campo `active` ainda existe no arquivo de estado (por retrocompatibilidade com arquivos antigos), mas e agora um campo DERIVADO, calculado por `phase === 'implementing'`. Um leitor que ve `active: true` no arquivo e assume que e a gate primaria esta errado: a gate primaria e `phase`. Back-compat: quando `phase` esta ausente (arquivo legado), `parseStateFile` deriva `phase` do campo `active` antigo.

3. **Trade-off genuino**: o enum introduz uma maquina de estados explicita, o que e mais testavel e extensivel, mas exige que TODOS os escritores do arquivo de estado sejam atualizados para escrever `phase` em vez de (ou alem de) `active`. O risco de divergencia entre escritores era real durante a transicao; foi mitigado por `noUncheckedIndexedAccess` + testes de valor-de-fase em cada story.

## Decisao

O campo `LoopPhase` (`idle | planning | implementing | awaiting-operator | shipping`) em `src/commands/status.ts` e a **fonte de verdade unica** do estado do loop. O campo `active: bool` e derivado como `phase === 'implementing'` e mantido somente por retrocompatibilidade de leitura.

A maquina de estados tem cinco transicoes principais:

1. **Idle**: `phase: idle` (ou arquivo ausente). O sidecar aguarda. Nenhum worker e despachado.

2. **Planning**: `cam plan N` (CLI) ou `/cam-plan N` (slash) escreve `phase: planning + plan_issue: <id>`. O sidecar detecta `loopPhase === 'planning'` e chama `runPlanPhaseFn` (wired para `runPlanPhase` em `plan-runner.ts`). O controle de fluxo (pre-flight, planner, auditor) e deterministico em TypeScript; o LLM orquestrador nao participa mais.

3. **APPROVE + auto**: `runPostAuditAction` e chamado com a acao `proceed-branch`. Ele (a) faz checkout do branch feature, (b) commita `prd.json`, e (c) chama `setPhaseFn('implementing')`. Isso escreve `phase: implementing` no arquivo de estado. Na proxima tick, `active` deriva para `true` e o sidecar despacha o primeiro implementer.

4. **pause-operator e audit-blocked**: dois caminhos distintos pos-auditoria sem criacao de branch.

   - **pause-operator** (modo aprovacao manual): `runPostAuditAction` recebe `action.kind === 'pause-operator'` e retorna `{ kind: 'awaiting-operator-approval' }` sem chamar `escalateFn`. Em seguida, `exitPhaseAfterPlan` transiciona `phase: awaiting-operator`. O loop fica parado ate o operador aprovar e re-invocar `/cam-plan`.

   - **audit-blocked** (auditor rejeita): `runPostAuditAction` recebe `planResult.kind === 'audit-blocked'`, chama `escalateFn` (em `sidecar.ts`: envia mensagem de escalacao ao orquestrador via `sendEscalation`) e retorna `{ kind: 'escalated' }`. Em seguida, `exitPhaseAfterPlan` transiciona `phase: idle`. O re-plan automatico apos BLOCK e um forward reference (B-2/CAM-153): no estado atual o operador precisa re-invocar `/cam-plan` manualmente.

   Em ambos os caminhos `phase: planning` e abandonado (nunca mantido): `exitPhaseAfterPlan` garante que toda saida de `runPostAuditAction` que nao seja `branch-created` transiciona para fora de `planning`.

5. **Implementing**: enquanto `phase: implementing`, o sidecar despacha o implementer (e depois o reviewer) via o loop existente em `loop.ts`. Quando `decideNextAction` retorna `complete` ou `awaiting-operator`, o sidecar escreve `phase: idle` (ou `awaiting-operator`) e para.

O `cam-plan.md` (tanto `.claude/commands/` quanto `templates/commands/`) foi reduzido a um stub de sinal: apenas documenta como escrever `phase: planning` e narra. O controle de fluxo foi removido do markdown e vive exclusivamente em `runPlanPhase`.

## Consequencias

- **Retrocompatibilidade**: arquivos de estado legados (sem campo `phase`) continuam funcionando: `parseStateFile` deriva `phase` do campo `active` antigo (`active:true` -> `implementing`, `active:false` -> `idle`).
- **Escritores precisam usar phase, nao active**: qualquer novo escritor do arquivo de estado DEVE escrever `phase` e NUNCA `active` diretamente. O campo `active` no template e gerado automaticamente por `renderStateFile`.
- **Re-plan automatico pendente**: BLOCK do auditor nao dispara re-plan automatico (B-2/CAM-153). O operador deve re-invocar `/cam-plan` manualmente.
- **Fase `shipping` reservada**: o valor `shipping` no enum esta reservado para um futuro runner deterministico de ship (analogia com `planning` -> `runPlanPhase`). Nao e usado ainda.
- **Naming**: o tipo e `LoopPhase` (nao `Phase`) para evitar colisao com o tipo `Phase` de `src/config/models.ts` (orchestrator/planner/auditor/implementer/reviewer/ship).

## Alternativas descartadas

- **Manter active:bool como fonte de verdade e adicionar campos auxiliares**: manter `active` como gate e adicionar campos `planningIssue`, `isPlanning` separados. Rejeitada: criaria dois campos concorrentes para o mesmo conceito de estado; o sidecar precisaria reconciliar divergencias entre eles.

- **Arquivo de estado separado por fase**: escrever um arquivo `cam-plan-state.json` para a fase de planejamento e manter `cam-loop.local.md` so para `active`. Rejeitada: fragmenta o estado em dois arquivos sem ganho; o sidecar ja le `cam-loop.local.md` em cada tick, adicionar um segundo arquivo de poll adicionaria latencia e complexidade.

- **Phase como campo opcional em prd.json**: registrar o estado de fase em `prd.json`. Rejeitada: `prd.json` e o contrato do PRD (stories, passes, review); misturar estado de runtime de loop com o contrato do PRD viola a separacao de responsabilidades.
