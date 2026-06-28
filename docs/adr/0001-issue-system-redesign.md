# ADR 0001: Redesign do issue-system (camadas idea/grill, reprioritizacao, cam-plan unico)

- **Status**: aceito (design); implementacao em 4 epicos (CAM-106 a CAM-109)
- **Data**: 2026-06-26
- **Metodo**: sessao de grill (grill-with-docs do Matt Pocock, emulada) com o operador

## Contexto

O `cam issue` salvava ideias num schema solto (`priority` misturando inteiros e strings `P0`-`P3` e `undefined`) e qualquer issue, por mais informal, podia virar PRD pelo `/cam-plan`. O operador quer: (1) duas camadas (capturar ideia leve vs especificar a fundo), (2) reprioritizacao automatica do backlog com analise de dependencias a cada nova issue especificada, (3) gate: so issue bem-especificada (nao ideia) vira plano acionavel pelo loop.

## Decisao

Maquina de estados explicita por issue e split LLM/deterministico em todo julgamento.

1. **Ciclo de vida** (Epico A, CAM-106): `stage = idea -> specified -> planned -> shipped`; `status = open | abandoned` (`blocked` e COMPUTADO do grafo, nunca manual); `blockedBy[]` fonte unica (`blocks` derivado); `wsjf{value,timeCriticality,riskReduction,jobSize}`; `rank` derivado; `spec`. Gate de PRD-readiness: `/cam-plan` so aceita `stage === specified`.
2. **Camada 2 = grill** (Epico B, CAM-107): vendoriza `grill-with-docs`, expoe `/cam-spec`, promove `idea -> specified` (ou `abandoned`/merge). Produz a spec + propoe `blockedBy` + estima WSJF + mantem CONTEXT.md/ADR (modelo de dominio duravel, fonte de self-improvement). E o gate humano profundo no modo `operator`.
3. **Reprioritizacao** (Epico C, CAM-108): per-issue e o proprio grill (sem agente separado); `subagent-triager` read-only reconcilia conflitos cross-issue; ranking DETERMINISTICO em TS = topological sort de Kahn + WSJF desc por camada; gate de grafo (aciclico, referencial, sem self-ref, direcao unica; ciclo rejeita e escala). Trigger pos-`specified` + `cam triage`; aplica autonomo, narra o diff, operador sobrescreve.
4. **cam-plan = prd-to-plan** (Epico D, CAM-109): mata o menu MVP/launch-ready; plano unico proporcional a spec, foco launch-ready, vertical-slicing (tracer bullets, nao horizontal). Config `[plan] plan_approval = operator | auto` (espelha `[ship] merge_mode`); auditor nos dois modos, `BLOCK` sempre trava. `plan_approval` e o gate humano estrategico.

Sequencia (topo-sort do proprio desenho): A -> B -> (C || D).

## Consequencias

- O `priority` ad-hoc e substituido por `rank` derivado; migracao: issues fechadas -> `shipped`, abertas -> `idea`.
- O tempo humano concentra no grill (spec profunda) e no `plan_approval`; tudo depois (implement/review/ship/merge/post-merge) ja e autonomo.
- A camada CONTEXT.md/ADR acumula o modelo de dominio e o porque das decisoes (este ADR e a primeira entrada).
- Conecta com CAM-71 (autonomia end-to-end) e CAM-102 (a politica por capacidade do hook ja libera o triager read-only).

## Alternativas descartadas

- **Tags em vez de `stage`**: fracas (free-form, sem invariante); o gate de PRD-readiness ficaria convencao, nao codigo.
- **`blocked` como status manual + `blocks` armazenado**: duas fontes de verdade que divergem; preferido computar/derivar.
- **Agente per-issue separado do grill**: redundante (o grill ja tem o contexto mais quente da issue).
- **Ranking por LLM**: alucina ordem; o LLM propoe arestas/scores, o codigo deterministico ordena e valida.
- **Manter o fork MVP vs launch-ready no cam-plan**: 99% das vezes a escolha e launch-ready; o menu so dispersa o esforco do planner.

## Implementacao Epico A (CAM-106)

Concluido em 2026-06-26 na branch `cam/CAM-106-issue-schema-state-machine`.

Entregou:

- Novo schema de `IssueEntry` (src/issues/types.ts): `stage` (idea | specified | planned | shipped), `status` (open | abandoned), `blockedBy[]`, `wsjf{value,timeCriticality,riskReduction,jobSize}`, `rank` (derivado), `spec`.
- Helpers de grafo (src/issues/graph.ts): `isBlocked`, `deriveBlocks`, `checkReferentialIntegrity`. (`isAcyclic` e `topSortKahn` sao Epico C e ainda nao implementados.)
- Gate-as-code (src/issues/select.ts): `selectPlannableIssue` filtra `stage === 'specified'` e `status === 'open'`, ordena rank asc (menor rank = maior prioridade), entao id asc.
- Schema JSON canonico em `scripts/cam/issues.schema.json` e `templates/scripts/cam/issues.schema.json` (byte-identicos). O schema descreve um unico `IssueEntry` (nao o array `issues.local.json` legado).
- Script de migracao idempotente (`scripts/cam/migrate-issues-schema.ts`): issues fechadas para `shipped`, abertas para `idea`. Executado em producao no CAM-90 US-005: `issues.local.json` foi deletado e substituido por `scripts/cam/issues/CAM-NNNN.json` (um arquivo JSON por issue, 4 digitos com padding, campo `id` sem padding). A documentacao operacional foi atualizada no CAM-90 US-008.
- `cam-plan` Step 2 reescrito para delegar ao gate (`selectPlannableIssue`), com sincronizacao nas tres copias: `.claude/commands/cam-plan.md`, `templates/commands/cam-plan.md`, e `src/vendor/_generated.ts` (via `bun run embed-vendor`).
