# ADR 0008: Auto-ship ancorado no estado terminal complete com marcador persistido

- **Status**: aceito (implementado em CAM-181 / US-001)
- **Data**: 2026-07-05

> **Nota de atualizacao (2026-07-09)**: o callsite de `autoShipFn` descrito nesta decisao
> (dentro do branch `complete` de `runSupervisor`) foi movido para `runSidecarLoop`,
> posicionado depois de `clearActive`, para sobreviver ao teardown terminal. Ver ADR 0013
> para o detalhe e o motivo da mudanca de local. A semantica de ancoragem (disparo apenas em
> `complete` mais CLEAN, marcador persistido `autoShipDispatchedAt`, fire-once cross-restart)
> permanece valida.

## Contexto

O auto-ship do cam despacha `/cam-ship` automaticamente quando o ciclo review termina com
veredicto CLEAN. Antes do CAM-181, o despacho era acionado na transicao `review -> CLEAN`: o
loop chamava `autoShipFn` imediatamente apos registrar o veredicto CLEAN ao final de uma rodada
de review.

Essa ancoragem apresentava dois problemas:

1. **Gate await-operator redundante**: a transicao `review -> CLEAN` e alcancavel mesmo quando
   existem stories `requires: 'operator'` ainda pendentes (o review ocorre independentemente
   do estado das stories de operador). O codigo anterior precisava de uma verificacao extra:
   "ha stories de operador pendentes? Se sim, nao fazer ship." Essa verificacao era acoplamento
   implicito entre a logica de ship e a logica de operator-stories.

2. **Sem protecao contra re-despacho apos reinicio**: o flag de deduplicacao vivia apenas em
   memoria (equivalente ao `blockedCycleEmitted` de CAM-139 US-005, em
   `src/commands/sidecar.ts:820-891`). Se o sidecar reiniciasse (ex: `cam stop` seguido de
   `cam run`, ou uma troca in-place do binario), o loop re-entraria no estado `review -> CLEAN`
   e despacharia um segundo `/cam-ship` sobre um PR que ja havia sido criado.

Tres gates definem quando uma decisao merece um ADR:

1. **Dificil de reverter**: mover o callsite de `autoShipFn` da transicao `review -> CLEAN`
   para o branch `complete` em `loop.ts` altera o contrato observavel do loop (o ship e
   despachado em um tick diferente), adiciona o campo `prd.review.autoShipDispatchedAt` ao
   schema de `PrdSnapshot` em `decide.ts`, e adiciona uma escritura em `prd.json` antes do
   dispatch. Reverter exigiria desfazer as tres mudancas de forma coordenada.

2. **Surpreendente sem contexto**: o branch `complete` em `loop.ts` e o ponto de saida do loop;
   um leitor esperaria que so logica de finalizacao ocorresse ali, nao um dispatch de ship.
   Adicionalmente, o marcador e escrito em `prd.json` (estado persistido) em vez de um flag
   em closure (estado em memoria), uma escolha que contraria o precedente de `blockedCycleEmitted`
   (CAM-139 US-005). Sem este ADR, a divergencia do precedente parece arbitraria.

3. **Trade-off genuino**: um marcador persistido garante idempotencia atraves de reinicios mas
   adiciona um campo ao schema que o supervisor deve gerenciar. Um flag em memoria seria mais
   simples, mas perderia o estado em qualquer reinicio, causando o re-despacho descrito acima.

## Decisao

O auto-ship e ancorado no branch terminal `complete` de `runSupervisor` (`src/supervisor/loop.ts`),
com duas condicoes de disparo:

1. `prd.review.lastVerdict === 'CLEAN'`: o veredicto da rodada de review mais recente e CLEAN.
2. `prd.review.autoShipDispatchedAt === undefined`: o marcador de disparo ainda nao foi gravado.

Antes de chamar `autoShipFn`, o loop escreve o campo `autoShipDispatchedAt` em `prd.json` via
`writePrd`. Isso garante que, se o sidecar reiniciar entre a escrita e o dispatch, o segundo
boot encontra o marcador presente e nao re-despacha.

O branch `complete` em `decide.ts` so e alcancado quando todas as stories (incluindo as de
`requires: 'operator'`) tem `passes: true`. O gate await-operator, que no codigo anterior era
verificado explicitamente no callsite do auto-ship, deixa de ser necessario: ele cai como
consequencia direta da ancoragem no branch `complete`.

### Divergencia do precedente in-memory (CAM-139 US-005)

O precedente mais proximo de deduplicacao no loop e `blockedCycleEmitted` em
`src/commands/sidecar.ts:820-891` (CAM-139 US-005): um boolean em closure que impede o
escalation de ciclo bloqueado de ser emitido mais de uma vez por ciclo.

A divergencia e intencional e justificada pela semantica diferente dos dois eventos:

- **Blocked cycle** (`blockedCycleEmitted`): o reinicio do sidecar deve re-emitir o escalation
  se o ciclo ainda esta bloqueado (o operador precisa ser notificado novamente). O reset em
  reinicio e o comportamento correto.

- **Auto-ship dispatch** (`autoShipDispatchedAt`): o dispatch e idempotente pelo lado do
  `/cam-ship` (o comando detecta um PR existente e nao cria um segundo), mas o efeito colateral
  de chamar `gh pr create` duas vezes e criacao de PR duplicado ou erro de CLI. O marcador
  deve sobreviver ao reinicio para garantir disparo unico end-to-end.

Em resumo: `blockedCycleEmitted` e correto como flag em closure porque re-notificar e o
comportamento desejado apos reinicio. `autoShipDispatchedAt` requer persistencia porque o
dispatch e um efeito externo nao idempotente.

## Consequencias

- **Gate await-operator eliminado**: o callsite de `autoShipFn` em `loop.ts` nao verifica
  stories de operador. A garantia vem da semantica do branch `complete` em `decide.ts`.

- **Schema de prd.json ampliado**: `PrdSnapshot.review` em `decide.ts` carrega o campo opcional
  `autoShipDispatchedAt?: string` (timestamp ISO). O campo e escrito exatamente uma vez por ciclo
  e nao e removido pelo finalize (e parte do historico do ciclo).

- **Idempotencia atraves de reinicios**: `cam stop` seguido de `cam run` no estado `complete +
  CLEAN` re-entra no branch `complete`, encontra o marcador presente, e nao re-despacha o ship.
  Troca in-place do binario (sem `cam stop`) tem o mesmo comportamento porque o marcador vive
  em `prd.json`, nao na memoria do processo.

- **Campo a ser gerenciado no finalize**: `cam ship --finalize` e `finalizeCycleClose` devem
  estar cientes de que `prd.json` sera removido (git rm) ao fechar o ciclo. O campo nao precisa
  de limpeza explicita: o finalize remove o arquivo inteiro.

## Alternativas descartadas

- **Manter o callsite na transicao `review -> CLEAN` com gate explicito de operator-stories**:
  preservaria o comportamento original mas deixaria o acoplamento implicito entre ship e
  operator-stories, e nao resolveria o problema de re-despacho apos reinicio sem adicionar
  um marcador persistido de qualquer forma.

- **Flag em closure em vez de campo em prd.json** (seguindo o precedente `blockedCycleEmitted`):
  mais simples de implementar, mas nao sobreviveria a reinicio do sidecar nem a troca in-place
  do binario, que sao cenarios reais de operacao. O disparo duplo de `/cam-ship` em um PR ja
  criado e um efeito colateral inaceitavel.

- **Verificar existencia do PR via `gh pr view` antes de chamar `autoShipFn`**: adicionaria
  latencia de rede e acoplamento a API do GitHub no loop interno do sidecar, que e um processo
  deterministico sem dependencias de rede. Rejeitado por violacao da separacao de
  responsabilidades: o sidecar nao deve ter conhecimento do estado externo do PR.
