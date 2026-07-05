# ADR 0007: Inter-cycle unattended drain via deterministic auto-dispatcher

- **Status**: aceito (implementado em CAM-139 / US-004)
- **Data**: 2026-07-05

## Contexto

O loop autonomo do cam (CAM-55) encadeia plan->implement->review->ship->merge dentro de um
unico ciclo (um PRD, uma branch, um PR). Entre ciclos, o loop ficava parado: apos o merge, o
proximo issue precisava de uma invocacao manual de `/cam-plan` pelo operador.

Tres gates definem quando uma decisao merece um ADR:

1. **Dificil de reverter**: introduzir o auto-dispatcher altera o comportamento do sidecar idle-tick
   (um tick que antes era silencioso agora pode escrever `phase:planning` e `plan_issue` em
   `cam-loop.local.md`), adiciona um novo `WorkerEventKind` ('meta-loop-dispatch') ao esquema de
   eventos, e reusa o seam `runMetaLoopObserveFn` (ADR-0004, ADR-0006) para uma segunda funcao
   com semantica de escrita em vez de so leitura. Reverter exigiria remover o kind do esquema,
   restaurar o seam como somente-observe, e reverter os gates de precondition.

2. **Surpreendente sem contexto**: o seam `runMetaLoopObserveFn` em `loop.ts` e reutilizado tanto
   para o modo observe (sem mutacao) quanto para o modo auto (com mutacao de fase). O nome do seam
   e o nome do campo `RunSidecarLoopOptions.runMetaLoopObserveFn` nao indicam mutacao. Sem este ADR,
   um leitor de `sidecar.ts` esperaria que qualquer fn nesse seam fosse apenas observacao. A
   decisao de reutilizar o seam em vez de criar um novo foi consciente: o dispatcher e uma extensao
   do observer (auto EXTENDS observe, nao substitui), e criar um segundo seam em `loop.ts` violaria
   a promessa de que "loop.ts needs NO change".

3. **Trade-off genuino**: o auto-dispatcher ganha ciclos autonomos sem interacao humana, mas perde
   a revisao do operador antes de cada ciclo. O safety net e duplo e explicito: (a)
   `worker_isolation === 'container'` + preflight Docker ready (o codigo roda em sandbox isolado),
   (b) `plan_approval === 'auto'` (o operador optou explicitamente por aprovacao automatica de PRDs).
   Se qualquer um falhar, o dispatcher recusa fail-closed e emite um evento 'refused'. O LLM so
   entra nos pontos de julgamento: backlog vazio (fila drenada) e ciclo bloqueado (preflight falho
   ou kill-switch ativo).

## Decisao

O dispatcher autonomo entre ciclos e um **runner deterministico em TypeScript** implementado como
`makeProductionMetaLoopDispatchFn` em `src/commands/sidecar.ts`, wired no seam
`runMetaLoopObserveFn` do loop quando `meta_loop === 'auto'`.

Em cada idle-tick o dispatcher executa as seguintes verificacoes em ordem:

1. **Kill-switch** (`isDrainStopSet`): se o marcador `.cam-drain-stop` estiver presente, para sem
   despachar. Emite 'meta-loop-dispatch {stopped:true}' uma vez (deduplicado em closure). A sessao
   cam continua viva; o operador pode remover o marcador com `cam drain --clear`.

2. **Preconditions fail-closed** (`evaluateDrainPreconditions`, US-003): verifica (a) isolamento
   container ativo e (b) `plan_approval=auto`. Qualquer falha emite 'meta-loop-dispatch
   {refused:true, reason}' + aviso em stderr e retorna sem despachar.

3. **Safe-boundary guards** (silenciosos): (a) `prd.json` ausente (nenhum ciclo em curso),
   (b) arquivo de merge-watch ausente, (c) `phase` idle ou ausente. Qualquer falha pula o tick
   silenciosamente.

4. **Selecao** (`selectPlannableFromFile`): le o backlog da branch main (invariante CAM-86/CAM-133).
   Selecao e deterministica: rank asc, numeric-id-suffix como tiebreak.

5. **Drenado**: se `selectPlannableFromFile` retornar null, emite 'meta-loop-observe {drained:true}'
   (reutilizando o tipo do observe) + drain-notify via Resend se configurado. Este e um **ponto de
   julgamento**: o LLM nao e chamado, mas o operador recebe a notificacao e pode agir.

6. **Despacho**: escreve `phase:planning` + `plan_issue:<id>` em `cam-loop.local.md` via
   `makeSetPhaseFn`. Emite 'meta-loop-dispatch {dispatched:true, issueId, rank}'. O plan runner
   (ADR-0004) pega o estado no proximo tick e encadeia o ciclo completo.

O LLM entra apenas nos pontos de julgamento (judgment point):
- Backlog vazio: o operador recebe notificacao e decide o proximo passo.
- Ciclo bloqueado (precondition falha / kill-switch): o operador investiga e desbloqueia.

Inter-cycle unattended drain: a deterministic runner chains cycles; the LLM enters only at
judgment points (empty queue, blocked cycle); hard-gated on the container + plan_approval=auto
safety net.

Todo o resto (selecao de issue, escrita de fase, encadeamento plan->implement->review->ship->merge)
e codigo deterministico em TypeScript.

## Consequencias

- **Ciclos sem intervencao humana**: quando `meta_loop=auto` e os dois safety nets estao ativos, o
  cam encadeia ciclos autonomamente ate o backlog drenar. O operador recebe notificacao por email
  (Resend) na drenagem.

- **Kill-switch disponivel**: `cam drain --stop` escreve o marcador; o dispatcher para no proximo
  tick sem matar a sessao. `cam drain --clear` retoma.

- **Deduplicacao em closure**: o estado de observe (wouldSelect / drained) e o flag
  `killSwitchStoppedEmitted` sao mantidos em closure (nunca em disco, invariante CAM-68). Se o
  sidecar reiniciar, o estado e resetado e os eventos sao emitidos novamente na primeira transicao.

- **Seam compartilhado**: `loop.ts` nao foi alterado. O dispatcher e um superset do observer:
  tambem le o backlog e usa `observeDecide` para deduplicacao. O unico seam e `runMetaLoopObserveFn`.

- **GRAPH-REWIRE nao necessario**: CAM-110 ja estava em stage:shipped no momento da implementacao.
  Trocar CAM-132->CAM-139 em `blockedBy` nao tinha efeito de desbloqueio precoce, e nao existe
  primitiva `edit-blockedBy` no cam. Registrado aqui em vez de editar o backlog.

## Alternativas descartadas

- **Novo seam em loop.ts (`runMetaLoopDispatchFn`)**: criaria dois seams para operacoes com
  semantica similar. Rejeitado: o dispatcher e extensao do observer; um segundo seam aumentaria
  a surface de `RunSidecarLoopOptions` sem ganho arquitetural.

- **Dispatcher como LLM-driven (orquestrador decide o proximo issue)**: violaria a separacao
  deterministico-vs-julgamento do CAM-55 (ADR-0004). O ponto de julgamento e a selecao do proximo
  issue via WSJF/rank, que e deterministico. Rejeitado pelos mesmos motivos que o loop LLM-driven
  foi rejeitado.

- **Auto-drain sem safety nets (host mode + plan_approval=operator permitidos)**: criaria ciclos
  nao sanboxados e com aprovacao humana pendente rodando de forma nao supervisionada. Rejeitado
  por falha nos dois gates de seguranca (container + auto).
