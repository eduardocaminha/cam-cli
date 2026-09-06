# Entrega do control plane multiprojeto

> Plano canônico da v0.435.0. Esta documentação não autoriza, por si só, as
> entregas posteriores.

## Objetivo

Gateship é o control plane persistente e determinístico que permite a um
operador acompanhar vários projetos sem perder o contexto de cada repositório.
O agente conversacional externo continua sendo a interface primária para
investigar, refinar e invocar comandos tipados. O runtime continua dono do
estado da execução, verificação, review, shipping e cleanup.

## Arquitetura da Central de controle

A Central de controle organiza o estado agregado por função:

- `/overview`: Agora, a visão imediata do que requer atenção e do estado dos
  projetos.
- `/overview/runs`: Execuções, histórico e estado operacional das runs entre
  projetos.
- `/overview/queues`: Filas, admissões e bloqueios de execução por projeto.
- `/overview/insights`: Insights derivados de evidências e observações, sempre
  como sinais separados e advisory.

`/projects` fica reservado ao gerenciamento de projetos. O contexto de um
projeto usa `/projects/:projectId/runs`, `/projects/:projectId/work` e
`/projects/:projectId/settings`. `/settings` é a configuração global.

A seleção de projeto é um contexto de navegação, não um escopo oculto de API.
Ela persiste quando o operador visita a Central e é atualizada ao abrir uma
rota válida do projeto. Uma seleção removida ou inválida é descartada sem
inventar um projeto padrão.

## Métricas e evidências

As métricas devem responder perguntas operacionais concretas, como atenção
pendente, projetos ativos, backlog, execuções concluídas, atividade e custo
conhecido. Cada sinal mantém sua origem, cobertura e limitações. Não existe
score composto, nível de maturidade ou número que substitua a leitura dos
fatos.

Evidências são tipadas por origem: check determinístico, julgamento humano ou
avaliação de modelo. Diagnósticos, coortes e ideias derivadas continuam
advisory: podem gerar uma proposta revisável, mas não aprovam, iniciam,
corrigem ou bloqueiam uma execução.

## Envelope de adaptação autônoma

Uma adaptação técnica durante a execução é válida somente quando permanece
contida no contrato aprovado e preserva, de forma observável:

- o objetivo da issue;
- o comportamento aceito;
- o risco e seus limites;
- a verificação aprovada.

Mudança que altera objetivo, comportamento, risco, exclusões, evidência exigida
ou comando de verificação retorna ao operador como proposta. O agente não
reescreve silenciosamente a especificação.

## Concorrência e ciclo de entrega

Execuções são seriais dentro do mesmo repositório. Paralelismo é permitido
somente entre projetos independentes. O serviço inicia cada run em worktree
fresca de `origin/main`, executa a verificação explícita, recebe review
independente e mecanicamente somente leitura e só então pode fazer shipping
conforme o contrato.

## Limites

Esta entrega rejeita terminal web, Kanban genérico, página global de agentes,
event explorer como superfície principal, merge decidido por IA e memória
genérica. Também não adiciona paralelismo no mesmo repositório, daemon novo,
banco novo, broker ou serviço separado.

A densidade operacional de ferramentas externas e seu onboarding ou
distribuição são referências competitivas registradas apenas no radar. Nomes
de terceiros não entram na interface, nos catálogos ou no fluxo operacional de
Gateship.

Esta issue altera somente documentação. Ela formaliza a entrega da v0.435.0,
mas não aprova as entregas posteriores por conta própria.
