# Agentes sao ferramentas intercambiaveis do pipeline

Decisao do operador em 2026-08-12, tomada durante a entrevista de spec do CAM-521.

## A decisao

Agentes de codigo sao ferramentas do nosso pipeline, nao fundacao dele. Devemos poder
usar qualquer agente que quisermos, em qualquer papel, com um unico filtro duro: o
agente precisa suportar autenticacao por assinatura. Claude e codex sao os dois
primeiros suportados, nao os dois unicos.

Isso vale independentemente de merito comparado. A decisao NAO esta condicionada a
medir se um agente entrega resultado melhor que outro. A CAM-541 mede qualidade do
implementer com codex e continua util, mas ela deixou de governar se codex e ou nao
suportado.

## O que isso obriga

**O contrato do pipeline sao os artefatos, e eles sao neutros de backend.**
`prd.json`, `worker-report.json`, `review-report.json`, `plan-verdict-report.json`,
`scope-proposal.json` e `handoff.json` sao a lingua franca entre papeis. Nenhum deles
pode carregar suposicao sobre qual agente o produziu.

**Ciclo heterogeneo tem que funcionar.** Planner em claude produzindo um PRD que o
implementer em codex consome, reviewer em codex julgando codigo que a claude escreveu.
Essa e a configuracao normal, nao um caso de borda: hoje mesmo o `project.toml` roda
planner, auditor e reviewer em claude e o implementer em codex.

**O especifico de backend fica confinado em tres pontos, e so nesses tres:**

1. argv de spawn (qual binario, quais flags, como a persona e selecionada),
2. classificacao do stream de saida (quais nomes de evento existem),
3. deteccao de termino (qual evento e terminal, qual exit code significa o que).

Tudo acima desses tres pontos e agnostico e nao pode ganhar ramo por backend. Quando
uma mudanca exigir um quarto ponto de especificidade, isso e sinal de que a abstracao
esta errada, nao de que o backend novo e excentrico.

## Consequencias ja mapeadas

O seam `BackendAdapter` (`src/supervisor/backend-adapter.ts`, ADR-0047) ja implementa o
ponto 1 e ja e por papel. Os pontos 2 e 3 existem apenas para claude: o caminho headless
e claude-only por construcao (`src/supervisor/loop.ts:1295` recusa qualquer backend que
nao seja claude, com o argumento de que headless fala o protocolo stream-json da Claude).
Fechar isso e a CAM-548.

Duas capacidades hoje sao derivadas de detalhe de implementacao da claude e precisam ser
reexpressas de forma neutra, ou declaradas explicitamente como degradadas por backend:
teto de token (hoje le transcript `.jsonl` da claude; o codex publica `usage` no proprio
evento terminal, entao a rota neutra e derivar do stream e nao de arquivo) e contabilidade
de custo em dolar (a claude publica `total_cost_usd`, o codex publica so contagem de token).

A persona continua sendo um arquivo markdown em `.claude/agents/`. Isso e nome de diretorio,
nao acoplamento: o codex ja consome o mesmo arquivo, removendo o frontmatter e passando o
corpo por `-c model_instructions_file=`. Se o diretorio for renomeado algum dia, e por
coerencia de marca e nao por dependencia tecnica.

## Fronteira

Subscription-only continua sendo a linha dura, com fundamento legal e nao apenas economico
(item 6 de `memory/project_definicoes_web_headless.md`). Um agente que so opere por API key
de plataforma nao entra, por melhor que seja. Sempre executar o binario real do fornecedor,
nunca reimplementar cliente de API falando com o fornecedor por token de assinatura.
