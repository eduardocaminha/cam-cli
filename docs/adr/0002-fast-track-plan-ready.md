# ADR 0002: Duas portas para plan-readiness (grilled OR born-ready)

- **Status**: aceito (implementado em CAM-144)
- **Data**: 2026-06-30
- **Revisao**: revisa ADR 0001 secao Epico B/CAM-107 ("grill e o gate humano singular")

## Contexto

ADR 0001 (CAM-107, Epico B) estabeleceu o grill como o unico gate para promover uma issue de `stage:idea` para `stage:specified`. A logica: sem grill profundo, o planner nao tem spec de qualidade suficiente para gerar um plano acionavel.

Na pratica, surgiu uma segunda classe de issues que nasce especificada sem precisar de grill:

- Issues **derivadas** (`specSource: derived`): criadas a partir de um pai ja-grillado, como sub-tarefas, follow-ups ou decomposicoes. A spec do pai ja passou pelo grill; a filha herda o rigor.
- Issues **de operador** (`specSource: operator`): especificadas diretamente pelo operador com `cam issue --fast-track`, onde o operador assume a responsabilidade pela completude da spec.

Forcar essas issues pelo ciclo completo de grill seria burocracia sem ganho de rigor, atrasaria trabalho derivado legitimo e contradiz o design do grill como gate proporcional ao risco.

A decisao de CAM-107 estava correta para o caso geral (ideias brutas); ela precisava de complemento, nao de abolicao.

## Decisao

Opcao Y: aceitar `stage:specified` no `/cam-plan` a partir de dois caminhos distintos, discriminados pelo campo `specSource`:

1. **Porta 1 (grillado)**: `specSource: "grill"` (ou campo ausente, para compatibilidade retroativa). Issue passou pelo `/cam-spec`; grill e o gate humano singular (ADR 0001 intacto para este caminho).
2. **Porta 2 (born-ready)**: `specSource: "derived"` ou `specSource: "operator"`. Issue pode ser filed diretamente como `stage:specified` via `cam issue --fast-track`, sem passar pelo grill.

O `specSource` e o discriminador canonico: o `/cam-plan` (Step 2) e o `subagent-planner` leem este campo para decidir como usar a spec (verbatim para `grill`; proposta de escopo para `derived`/`operator`). O campo `derivedFrom` carrega o id da issue pai quando `specSource: "derived"`.

Guardrails duros para a Porta 2:

- `--fast-track` so aceita `stage:specified`. Nao existe `--fast-track --stage idea`; a combinacao e rejeitada com erro.
- WSJF inheritance (`derived`): `wsjf` e herdado do pai quando o filho nao fornece scores proprios (hard binding, nao sugestao); sobrescrita requer flags explicitosno CLI.
- O `/cam-plan` Step 2 emite um sinal explicito ("non-grilled spec") quando `specSource != "grill"`, visivel ao operador antes de qualquer commit de plano.
- O subagent-auditor permanece obrigatorio nos dois caminhos; um plano derivado de spec nao-grillada ainda passa pelo gate de auditoria.

## Consequencias

- **Velocidade para trabalho derivado**: follow-ups e sub-tarefas de uma issue grillada podem virar PRD sem aguardar um novo ciclo de grill, cortando latencia de dias para minutos.
- **Risco de rigor-skip mitigado por tres camadas**: (1) guardrails duros no CLI impedem uso inadvertido; (2) o sinal explicito no `/cam-plan` garante visibilidade operacional; (3) o auditor bloqueia planos ruins independentemente do caminho de origem.
- **ADR 0001 permanece valido para o caminho principal**: a regra "grill e o gate singular" continua verdadeira para issues de idea-origin; esta decisao apenas abre um segundo caminho paralelo e explicitamente sinalizado.
- **`specSource` entra no schema canonico**: campo obrigatorio em toda issue `stage:specified` filed via `--fast-track`; ausencia implica `"grill"` (compatibilidade retroativa).
- **Auditabilidade preservada**: o campo `specSource` e `derivedFrom` ficam no JSON da issue e no PRD, rastreando a origem de cada spec para futura inspecao.

## Alternativas descartadas

- **Opcao X: `grillExempt` flag que mantinha `stage:idea`**: o flag seria interpretado pelo `/cam-plan` como excecao ad-hoc sem semantica clara. `stage:idea` continuaria significando "nao-especificado", o que contradiria a condicao de PRD-readiness (`stage:specified`). Rejeitada: semantica quebrada, discriminador fraco.
- **WSJF inheritance overridable (soft binding)**: permitir que o filho sobrescreva silenciosamente o WSJF do pai sem flag explicito abria espaco para manipulacao de prioridade sem rastreabilidade. Rejeitada: o hard binding com override-explícito preserva auditabilidade e forca intencionalidade.
- **Guardrails suaves (warnings, nao erros)**: avisar mas nao bloquear `--fast-track --stage idea` causaria inconsistencia de estado (issue idea mas filed como specified). Rejeitada: hard error e o unico contrato confiavel.
- **Grill obrigatorio para todos os casos**: correto em principio, mas impraticavel para trabalho derivado (sub-tarefas de uma issue ja-grillada passariam pelo mesmo gate do pai, dobrando o custo sem dobrar o rigor). Rejeitada: burocracia sem ganho proporcional.
