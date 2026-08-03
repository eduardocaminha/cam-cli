# Politica de admissao de alvo (imposto recorrente por ciclo)

Decisao do operador, 2026-08-03, derivada de medicao.

## A regra

Um item interno (defeito da propria maquina do loop, infraestrutura de teste,
gate) so ganha um ciclo se cobra **imposto recorrente por ciclo**: custo que
reincide em todo ciclo enquanto nao for consertado. Item interno que custa uma
vez, ou que custa pouco por ciclo, fica no backlog sem promocao, por mais real
que o defeito seja.

## Por que ela existe

Medicao de 2026-06-01 a 2026-08-02, 199 PRs merged na main: 45 produto, 12
lancamento, 94 loop interno, 48 teste/infra. Interno mais teste somam 71 por
cento de toda a capacidade. A fatia de produto caiu de 47 por cento (semana de
29/06) para 7 por cento (semana de 27/07).

No mesmo periodo a serie de custo piorou, com changepoint convergente em
23-24/07 a partir de tres sinais independentes: intervalo mediano entre ships
de 1,4h para 4,0h, worker rounds por ciclo de 2 para 7, duracao de sessao de
worker de 6,6 para 14,5 min, tokens por ciclo de 11,6M para 41,1M, ships por
semana de 88 para 14. O ganho de eficiencia de 03/07 (47,8M para 11,7M tokens
por ciclo) foi inteiramente devolvido.

A conclusao que a regra codifica: trabalho interno nao e ilegitimo, mas nao se
auto-justifica por ser um defeito real. Sem criterio de admissao, o loop fila
os proprios achados mais rapido do que fecha, e a composicao do backlog empurra
a selecao de alvo para dentro.

## Como aplicar

Antes de promover um item interno, responder com numero: quanto ele custa por
ciclo hoje? Sem numero, nao passa. O denominador e obrigatorio: custo por
ocorrencia vezes frequencia medida, nunca custo por ocorrencia sozinho.

Exemplos medidos que PASSAM (2026-08-03):

- CAM-488: check:all executa a suite inteira 3 vezes; o worker roda por story
  (mediana 7 por ciclo) e o reviewer tambem. 22 por cento do orcamento de
  review em redundancia pura.
- CAM-489: orcamento de rounds injetado por PRD (7 e 9 contra a constante 3);
  ate 4h de opus por ciclo.

Exemplo medido que NAO passa: morte precoce de worker, defeito real e
reproduzivel, com frequencia de 0,79 por cento dos dispatches (10 timeouts em
1261 dispatches em 51 dias), custando cerca de 90 minutos de parede em 7
semanas, comprados com 62,9M tokens. Custo alto por ocorrencia nao e o mesmo
que imposto recorrente.

## Relacao com a triagem do pen

Complementar, nao substituta. `memory/project_suggestion_triage.md` governa a
promocao demand-driven de sugestoes do reviewer. Esta politica governa a
admissao de qualquer item interno a um ciclo, venha do pen ou nao.
