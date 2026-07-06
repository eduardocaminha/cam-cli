# ADR 0009: Ship phase como runner deterministico no sidecar

- **Status**: aceito (implementado em CAM-149)
- **Data**: 2026-07-05

## Contexto

A fase de shipping do cam (executada via `/cam-ship` ou `cam ship`) era orquestrada pelo LLM
orquestrador: `templates/commands/cam-ship.md` continha uma sequencia de 9 passos em prosa
(verificar PRD completo, `git status`, `bun run check:all`, bump de versao, cycle-close finalize,
push, `gh pr create`, branch por merge_mode, fechar a issue) que o orquestrador lia e executava
a mao, comando por comando. Esse era o mesmo padrao de logica-em-markdown ja identificado em
CAM-49/72/86/104: nenhum limite deterministico de tentativas, roteamento implicito no texto do
prompt, e o corpo do PR era redigido livremente pelo LLM a partir do diff e do PRD.

As stories US-001 a US-005 desta PRD ja haviam movido toda essa logica para TypeScript
deterministico: `composePrTitle`/`composePrBody` (US-001, `src/release/pr-body.ts`) templatam o
titulo e o corpo do PR a partir de um snapshot do PRD, sem LLM; `runShipPhase` (US-002,
`src/supervisor/ship-runner.ts`) executa a sequencia pre-PR (branch guard, PRD-complete,
commits-ahead, gates, bump, finalize, push); `runShipPrStep` (US-003, `src/release/ship-pr.ts`)
executa `gh pr create`, o auto-merge best-effort, o comentario do artefato do reviewer, e a
ramificacao ci-gated vs immediate; o sidecar (US-004, `loop.ts`) despacha `runShipPhaseFn` quando
`phase === 'shipping'` e o gatilho CLEAN->ship passou a ser o marcador persistido
`autoShipDispatchedAt` (ADR 0008); e `cam ship` (US-005, `src/commands/ship.ts`) passou a escrever
`phase:shipping` no arquivo de estado em vez de injetar `/cam-ship` via `send-keys`.

O que restava era `cam-ship.md` (ambas as copias, `templates/` e `.claude/`): o texto ainda descrevia
os 9 passos completos com comandos `gh`/`jq`/`git`, redundante com o codigo TS ja implementado e
uma fonte de divergencia (drift) entre o que o markdown descreve e o que o runner realmente executa.

Tres gates definem quando uma decisao merece um ADR:

1. **Dificil de reverter**: mover todo o controle de fluxo de ship (verificacao de PRD, gates,
   bump, finalize, push, `gh pr create`, ramificacao por merge_mode, fechamento de issue) de
   prosa em markdown interpretada pelo orquestrador LLM para um pipeline TS deterministico
   (`runShipPhase` + `runShipPrStep`) muda o artefato de registro da autoria do PR (agora um
   composer puro sobre o snapshot do PRD, nunca prosa gerada pelo LLM), o sinal de conclusao
   (escrita de `phase:shipping` no arquivo de estado em vez de assumir conclusao a partir do
   scrollback do pane apos um slash command), e remove por completo os pontos de julgamento do
   orquestrador no caminho de ship. Reverter exigiria restaurar o markdown passo-a-passo, reintroduzir
   o dispatch via `send-keys` em `ship.ts` e em `cam-ship.md`, e remover o wiring do runner
   deterministico em `loop.ts`.

2. **Surpreendente sem contexto**: "zero LLM numa fase" ate entao era reservado para transicoes de
   estado puras (checagens de idle). Um leitor razoavelmente esperaria que a fase de shipping, que
   produz um PR (uma tarefa tipicamente associada a julgamento: resumir mudancas, decidir a
   redacao), ainda precisasse de um LLM. A decisao declara explicitamente que o corpo do PR e
   templado deterministicamente a partir do snapshot do PRD (`composePrTitle`/`composePrBody`),
   nao redigido livremente: nenhum passo de julgamento e pulado, apenas automatizado.

3. **Trade-off genuino**: a alternativa considerada (PR autorado por LLM via um pane de worker)
   foi descartada em favor de um template deterministico. O trade-off e real: um corpo de PR
   templado e menos nuancado que um resumo em prosa lido do diff real pelo LLM, mas e
   deterministico, reproduzivel, testavel por unidade, e nunca omite ou alucina uma story. Isso
   espelha o trade-off da ADR 0004 (o runner de planejamento perde a flexibilidade do LLM para
   reformular, ganha garantias deterministicas) e concretiza a fase `shipping` que a ADR 0006
   havia reservado no enum `LoopPhase` sem uso ainda.

## Decisao

A fase de shipping e um **runner deterministico em TypeScript** (`runShipPhase`,
`src/supervisor/ship-runner.ts`), despachado pelo sidecar quando `phase === 'shipping'` e
`autoShipDispatchedAt` ainda nao foi gravado (ADR 0008). Nenhum LLM participa do caminho de
ship: o titulo e o corpo do PR sao compostos por funcoes puras (`composePrTitle`/`composePrBody`,
`src/release/pr-body.ts`) a partir de um snapshot do PRD capturado em memoria antes de
`finalizeFn` remover `prd.json` do disco.

O runner executa oito passos fixos em sequencia, falhando rapido no primeiro erro:

1. Branch guard: recusa quando o branch atual e `main`.
2. PRD-complete check: toda story com `requires != 'operator'` tem `passes: true`.
3. Commits-ahead-of-main check: `git log main..HEAD` nao esta vazio.
4. Quality gates via `runGatesFn` (comando padrao: `bun run check:all`).
5. Version bump via `bumpFn` (`runShipBump`, `src/release/ship-bump.ts`). Nao idempotente: uma
   falha aqui escala para o operador, nunca reexecuta.
6. Cycle-close finalize via `finalizeFn` (`finalizeCycleClose`, `src/commands/ship-finalize.ts`).
7. `git push origin <branch>`.
8. PR-create + merge-mode step via `runShipPrStepFn` (`runShipPrStep`, `src/release/ship-pr.ts`,
   US-003): `gh pr create`, auto-merge best-effort, comentario do artefato do reviewer, e a
   ramificacao ci-gated (enriquece `.cam-merge-watch.json` e delega o pos-merge ao sidecar) vs
   immediate (fecha a issue inline).

Os dois caminhos de dispatch (CLI `cam ship`, US-005; e o slash command `/cam-ship`, esta story)
escrevem `phase:shipping` no arquivo de estado do loop e retornam. `cam-ship.md` (ambas as copias,
`templates/` e `.claude/`) foi reduzido a um stub de sinal, mirrando o formato do `cam-plan.md`
(ADR 0006): descreve o caminho CLI, o caminho do slash command, e narra a sequencia de passos do
runner apenas como texto informativo. As instrucoes passo-a-passo de `gh`/`jq`/`git` foram
removidas por completo do markdown.

### Alternativa considerada: PR autorado por LLM via worker pane

Uma alternativa avaliada foi despachar um pane de worker apos o push, com um prompt pedindo ao
LLM para ler o diff e o PRD e redigir o titulo e o corpo do PR, capturando o resultado via um
arquivo de report (espelhando o padrao do implementer/reviewer), e injetando o texto em
`gh pr create --body-file`.

Rejeitada por tres motivos:

- Reintroduziria um ciclo completo de spawn + poll de pane LLM-driven numa fase que, de outra
  forma, nao tem nenhum ponto de julgamento externo, adicionando latencia, superficie de falha de
  isolamento (morte de pane, timeout), e custo de token a cada ship.
- O snapshot do PRD ja contem todo fato que um corpo de PR precisa (projeto, descricao, numero da
  issue, lista de stories, notas). Um resumo livre do LLM adiciona cor narrativa, mas nenhuma
  informacao nova, e corre o risco de omitir ou descrever incorretamente uma story.
- Um composer deterministico e trivialmente testavel por unidade (`composePrTitle`/`composePrBody`
  em `pr-body.test.ts`), enquanto um corpo de PR autorado por LLM nao e: uma regressao de fraseado
  seria invisivel a qualquer gate existente.

## Consequencias

- **Corpos de PR templados**: os corpos de PR sao agora boilerplate estruturado (secoes Summary /
  Stories completed / Testing / Notes derivadas do `PrdSnapshot`), perdendo a cor narrativa livre
  que um resumo de LLM poderia oferecer, em troca de determinismo e testabilidade total.
- **cam-ship.md deixa de ensinar a sequencia de comandos**: o markdown nao documenta mais a
  sequencia `gh`/`jq`/`git` passo-a-passo. `docs/recovery-runbook.md` permanece a referencia
  canonica para cenarios de recuperacao manual (ex: reativar auto-merge, corrigir um ratchet antes
  de reabrir o ship).
- **Mudancas futuras de comportamento de ship vao no codigo TS**: qualquer alteracao ao controle de
  fluxo de ship e feita em `ship-runner.ts`/`ship-pr.ts`, coberta por
  `ship-runner.test.ts`/`ship-pr.test.ts`. `cam-ship.md` deixa de ser um lugar onde desenvolvedores
  editam para mudar o comportamento de ship; as duas copias (`templates/` e `.claude/`) so mudam
  para melhorar a narracao do sinal escrito, exigindo edicao simultanea (self-hosting).
- **Fase `shipping` deixa de estar reservada**: a ADR 0006 reservava o valor `shipping` no enum
  `LoopPhase` sem uso. Esta ADR fecha essa lacuna: `shipping` agora e despachado por
  `runShipPhaseFn` em `loop.ts` (US-004), simetrico a `planning` -> `runPlanPhase` (ADR 0004).

## Alternativas descartadas

- **PR autorado por LLM via worker pane**: descrita acima. Rejeitada pelo custo de latencia,
  isolamento e testabilidade frente a um ganho apenas de cor narrativa.

- **Manter o markdown passo-a-passo com apenas o corpo do PR reduzido**: manteria o restante da
  prosa (verificacao de PRD, gates, bump, finalize, push, merge-mode) como instrucoes que o
  orquestrador ainda interpretaria, mesmo com o codigo TS ja implementando tudo isso desde
  US-002/US-003/US-004. Rejeitada: deixaria duas fontes de verdade divergentes (o markdown e o
  runner), o mesmo risco de drift que motivou a ADR 0004 e a ADR 0006.

- **Remover `cam-ship.md` por completo**: descontinuar o arquivo em vez de reduzi-lo a um stub.
  Rejeitada: o arquivo ainda funciona como o ponto de entrada do slash command injetado pelo
  orquestrador, e o caminho CLI (`ship.ts`) e o caminho slash compartilham o mesmo contrato de
  escrita do sinal. O precedente do `cam-plan.md` (ADR 0006) e manter um stub fino em vez de
  apagar o comando.
