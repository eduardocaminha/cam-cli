# Faixa direta (trabalho interno sem o loop)

Decisao do operador, 2026-08-03, derivada de medicao.

## A regra

Mudanca que tem **verificacao automatica capaz de ficar verde** nao precisa do
loop (plan, auditor, implementer, rounds de review). Vai por faixa direta:
sessao normal do Claude Code, edita, roda `bun run check:all`, abre PR.

O criterio de entrada nao e tamanho. E este, e a pergunta se responde antes de
comecar:

> Existe um teste ou gate que fica verde quando isso estiver pronto?

- **Sim**: faixa direta. O gate e o criterio de aceite.
- **Nao** (por exemplo "o usuario deveria conseguir X"): loop completo, porque
  o criterio exige julgamento sobre intencao.

Quem nao consegue apontar qual verificacao vai ficar verde nao qualifica. Essa
exigencia e o que impede a faixa direta de virar porta dos fundos.

## As tres obrigacoes

1. **Entrada**: apontar, antes de editar, qual verificacao fica verde.
2. **Saida**: `bun run check:all` inteiro e verde antes do push. Sempre. A faixa
   direta pula a cerimonia de LLM, nunca os gates deterministicos.
3. **Proibido**: afrouxar teste, expectativa ou budget para o gate passar.
   Conserta a causa, ou devolve para o loop. Isso vale mesmo quando o hook de
   allowlist nao esta ativo, e sessao interativa nao e barrada por ele.

Compensacao pelo que se perde: os achados de julgamento do reviewer (por
exemplo "faltou teste de regressao", "esse comentario descreve um
comportamento que nao existe mais") nao aparecem sozinhos. Uma olhada humana
no diff cobre isso. Uma, nao sete rodadas.

## Por que ela existe

Medicao de 2026-06-01 a 2026-08-02, 199 PRs merged: trabalho interno mais
teste e infraestrutura somam 71 por cento de toda a capacidade, e o backlog de
idea e 88,5 por cento cam trabalhando em cam. Ships por semana cairam de 88
para 14.

O ciclo do CAM-488 (2026-08-03) tornou o custo concreto. O trabalho de produto
levou cerca de 2 horas e a verificacao levou cerca de 5,5 horas, das quais
cerca de 3 nao produziram nada acionavel:

- Duas rodadas de review rodaram completas reencontrando o mesmo achado, sem
  poder gerar conserto, porque o orcamento estourado emite debito em vez de fix
  story (CAM-489).
- Uma fix story nasceu impossivel por construcao: apontava para `prd.json`, que
  e write-blocked para sessao de worker. O proprio texto do achado ja dizia que
  precisava de outro ator.
- O restante foi erro de aritmetica do orquestrador ao elevar o orcamento.

Nenhuma dessas perdas veio de rigor de review. Vieram da maquinaria em volta.

## O que a faixa direta nao cobre

- Mudanca cujo criterio de pronto depende de julgamento sobre intencao.
- Mudanca em superficie que o operador declarou sensivel (nome do binario,
  contrato publico, politica de release).
- Qualquer coisa que exija reescrever criterio de aceite ja registrado.

## Limite de seguranca

A rede deterministica e grossa: `bun run check:all` sao 14 gates e mais de 5900
testes. Foi ela, e nao o reviewer, que pegou o defeito real do ciclo de
2026-08-03, quando o colapso das execucoes redundantes revelou que o gate
`skip-ratchet` da main estava verde por motivo espurio (a primeira execucao da
suite criava o arquivo que a terceira encontrava, mascarando um skip ambiental
em CI).

O dia em que a faixa direta comecar a receber trabalho cujo criterio nao e
checavel por maquina, o sistema volta a shipar rapido sem verificar, que e o
estado que os guards existem para impedir.
