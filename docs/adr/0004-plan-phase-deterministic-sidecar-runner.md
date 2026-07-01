# ADR 0004: Plan phase como runner deterministico no sidecar

- **Status**: aceito (implementado em CAM-117)
- **Data**: 2026-07-01

## Contexto

A fase de planejamento do cam (executada via `/cam-plan`) era orquestrada pelo LLM orquestrador: o operador aprovava o escopo, e o orquestrador invocava o planner e o auditor como Task subagents (`Task(subagent_type=...)`), interpretando seus outputs e decidindo o proximo passo em linguagem natural. Esse modelo levava os mesmos problemas do loop de implementacao pre-CAM-55: sem limite deterministico de tentativas, sem isolamento de falha por pane, e a logica de roteamento ficava implicita no prompt do orquestrador.

Tres gates definem quando uma decisao merece um ADR:

1. **Dificil de reverter**: mover o ciclo planner/auditor para um runner deterministico em TypeScript (`src/supervisor/plan-runner.ts`) afeta o ponto de dispatch do planner e do auditor (de Task subagent para pane tmux), o formato do sinal de conclusao (sentinel / report file em vez de conteudo retornado ao orquestrador), e a logica de pos-auditoria (commit do PRD, criacao de branch, flip de `active:true`). Reverter exigiria reescrever `plan-runner.ts`, restaurar o fluxo de Task subagent no `cam-plan.md` e remover o wiring deterministico em `sidecar.ts`. Multiplos modulos e a convencao operacional seriam afetados.

2. **Surpreendente sem contexto**: o padrao documentado em `scripts/cam/patterns.md` ("Pane worker vs Task subagent") estabelece que o planner e o auditor sao Task subagents dentro do fluxo interativo do `/cam-plan`. No runner deterministico, ambos passam a rodar como panes tmux interativos, exatamente como o implementer e o reviewer. Para quem le `plan-runner.ts` sem este ADR, o dispatch via `respawn-pane -k` parece inconsistente com o padrao estabelecido. A justificativa e que o dispatcher agora e o sidecar deterministico (nao o LLM orquestrador), o que inverte o criterio de escolha: quando o sidecar e o driver, pane e correto pelos mesmos motivos que o implementer usa pane.

3. **Trade-off genuino**: o runner deterministico perde a flexibilidade do LLM para orquestrar o fluxo de planejamento (interpretacao de erros nao previstos, reformulacao de perguntas ao operador, etc.). Em troca, ganha as mesmas garantias deterministicas do loop de implementacao: limite de tentativas via timeout (`plannerTimeoutMs`, `auditorTimeoutMs` em `RunPlanPhaseOptions`, default `DEFAULT_PLAN_TIMEOUT_MS` = 30 min), isolamento de falha via pane kill/respawn, sinal de conclusao via arquivo de report (nao via scrollback parsing), e logica de roteamento pos-auditoria em TypeScript puro (`decidePostAuditAction`).

## Decisao

A fase de planejamento e um **runner deterministico em TypeScript** (`src/supervisor/plan-runner.ts`). O LLM participa somente nos dois pontos de julgamento: o planner (escreve as user stories) e o auditor (emite veredicto APPROVE ou BLOCK). Todo o resto (pre-flight, dispatch, polling de conclusao, acao pos-auditoria) e codigo deterministico.

O runner executa tres fases em sequencia:

1. **Pre-flight** (`runPlanPreflight`): verifica arvore git limpa, branch de origem resolvida, gh disponivel, e poda branches `cam/` ja mergeados. Falha em qualquer verificacao obrigatoria encerra o runner sem spawnar panes.

2. **Ciclo planner/auditor** (interno ao `runPlanPhase` via helpers `pollPlannerDeath` / `pollAuditorReport`): o planner e spawned como pane tmux interativo; o runner polls ate detectar o sinal de conclusao (prd.json escrito ou pane morto). Em seguida o auditor e spawned no mesmo pane; o runner polls pelo veredicto (APPROVE ou BLOCK) via `plan-verdict-report.json`. O LLM de cada pane e configuravel via `[models]` em `project.toml` e injetado via frontmatter rewrite antes do spawn.

3. **Acao pos-auditoria** (`runPostAuditAction`): quando o veredicto e APPROVE, o runner (a) faz commit do `prd.json` no branch atual, (b) cria o branch `cam/<issue-id>-<slug>` via `git checkout -b`, e (c) escreve `active: true` no estado do sidecar (`cam-loop.local.md`). Essa sequencia e o hand-off incremental para o loop de implementacao em `loop.ts`: o sidecar detecta `active: true` na proxima tick e despacha o implementer.

A divisoria "pane vs Task subagent" de `patterns.md` e refinada: Task subagent e correto quando o LLM orquestrador e o driver (fluxo interativo com operador presente). Pane e correto quando o sidecar deterministico e o driver. O planner e o auditor usam pane no runner porque o sidecar e quem os despacha.

## Consequencias

- **Dependencia de tmux no plano**: `cam plan` agora exige uma sessao tmux ativa com o sidecar rodando. O runner faz dispatch via `respawn-pane -k` no pane de worker, igual ao implementer. Invocar o runner fora de uma sessao cam nao e suportado.
- **LLM sem loop de reformulacao**: se o planner ou o auditor travar ou encerrarem com erro, o runner reporta `BLOCK` sem tentativa de reformulacao. O operador precisa re-invocar `/cam-plan` manualmente. O BLOCK->re-plan loop automatico e um forward reference (CAM-151).
- **plan_approval gate ausente**: a decisao de aprovar o escopo antes de spawnar o planner permanece no LLM orquestrador (Step 6 do `cam-plan.md`). A gate deterministica `decidePostAuditAction` roda apenas pos-auditoria. Um gate de `plan_approval` configuravel via `project.toml` e um forward reference (CAM-151).
- **Conflito de trabalho em progresso**: o runner nao detecta branches `cam/` ativos com commits nao mergeados ao criar um novo branch. Deteccao de in-progress-work conflict e um forward reference (CAM-151).
- **Sinais de conclusao distintos por fase**: o planner sinaliza conclusao escrevendo `scripts/cam/prd.json` (lido via `readPlannerReportFn`); o auditor sinaliza conclusao escrevendo `scripts/cam/plan-verdict-report.json` (lido via `readPlanVerdictFn`). Em ambos os casos o runner le o arquivo como sinal primario; morte do pane e fallback. `scripts/cam/worker-report.json` e o canal do implementer e do reviewer, nao do planner ou do auditor.

## Alternativas descartadas

- **Task subagents para planner/auditor no sidecar**: manter o dispatch como Task subagents mas mover a logica de orquestracao para o sidecar. Rejeitada: Task subagents retornam resultado ao chamador LLM, nao ao sidecar deterministico; o sidecar nao tem acesso ao valor de retorno de um Task. Implementar esse canal exigiria um mecanismo ad-hoc equivalente ao report file, sem ganho sobre o modelo de pane.

- **LLM-orquestrador como driver do ciclo (modelo pre-CAM-117)**: manter o orquestrador como driver do ciclo planner/auditor via Task subagents, com logica de roteamento no prompt. Rejeitada pelos mesmos motivos que rejeitaram o loop de implementacao LLM-driven (CAM-55): sem limite deterministico, sem isolamento de falha, logica de roteamento implicita e nao testavel.

- **Runner em script bash**: implementar o runner como script bash (sem TypeScript). Rejeitada: o runner precisa de composicao de tipos (`PlanRunnerResult`, `PostAuditActionResult`), injecao de dependencias para testabilidade, e acesso ao mesmo `spawnFn` / `SpawnFn` usado pelo sidecar. Bash nao tem esses mecanismos; TypeScript e a linguagem do projeto.
