# Migracao de nomenclatura para gateship: deletar antes de renomear

Decisao do operador em 2026-08-12, tomada durante a entrevista de spec do CAM-521.

## A decisao

O produto e gateship, o binario e gship, e o nome antigo tem que sair de tudo. Isso
inclui o que a decisao anterior tinha deixado de fora: os identificadores `CAM_*` e os
ids de issue `CAM-NNN`. A regra que governa a adocao e uma so: passar a usar tudo novo,
desde que o app nao quebre.

Mas a migracao tem ORDEM obrigatoria, e a ordem e o ponto principal desta pagina.

**Primeiro classificar o que morre, depois renomear o que sobra.** O epico web e headless
(CAM-521, CAM-545, CAM-546, CAM-522 e o daemon) deleta superficie grande, e uma fracao
dos identificadores atuais existe apenas por causa de tmux, pane e sentinela de scrollback.
Renomear antes de classificar e pagar para renomear cadaver, e e exatamente a inversao que
a Premissa do projeto proibe: encolher a superficie antes de policia-la.

Enquanto a classificacao nao existir, `CAM_*` continua em uso e isso nao e divida a
consertar com urgencia. E estado transitorio deliberado.

## Emenda ao CAM-493

O CAM-493 propoe um sweep duravel do nome aposentado no `check:all` e, no seu conserto
proposto, inclui uma "allowlist explicita para os usos legitimos do token", nomeando
entre eles `CAM_`. Essa clausula fica EMENDADA: `CAM_` deixa de ser uso legitimo
permanente e passa a ser estado transitorio.

A emenda nao invalida o resto do CAM-493, que segue valido inteiro: a superficie de
strings de remediacao em runtime sem cobertura, o terminador cego do unico guarda
(`test/help-registry.test.ts:114`), e os quatro testes duraveis que pinam o nome velho na
direcao errada. O sweep dele deve nascer ja sabendo que a allowlist de `CAM_` tem data
para cair, e portanto a allowlist precisa ser uma lista explicita e datada, nunca um
padrao permanente.

## Inventario medido em 2026-08-12

44 identificadores distintos com prefixo `CAM_` em `src/`, `scripts/` e `index.ts`, cerca
de 500 ocorrencias. Eles nao sao todos da mesma especie, e a especie muda o custo do
rename:

- **Sentinela de handback**, que vive em contrato de persona e de slash command e portanto
  o rename atravessa a superficie de instrucao: `CAM_ISSUE_RESULT` (51 ocorrencias),
  `CAM_IMPLEMENTER_STATUS` (38), `CAM_SPEC_RESULT` (16), `CAM_SETUP_STATUS` (6),
  `CAM_DOMAIN_DOCS_WRITTEN` (1), `CAM_LOOP_STATUS` (2), `CAM_JOURNAL_APPENDED` (6).
- **Variavel de ambiente de processo**: `CAM_WORKER` (47), `CAM_SESSION` (44),
  `CAM_TEST_WAIVERS` (12), `CAM_WORKER_TIMEOUT_MS` (5), `CAM_WORKER_MAX_TOKENS` (1),
  `CAM_RUN_DRY_RUN` (9), `CAM_ORCH_REHYDRATE` (16), `CAM_ORCH_HANDOFF_DUE` (8).
- **Ligado a tmux, pane ou sentinela de scrollback**, e portanto candidato forte a morrer
  em vez de ser renomeado: `CAM_ORCH_PANE` (5), `CAM_CONFIG_PANE` (16),
  `CAM_TMUX_SOCKET` (4), mais `CAM_IMPLEMENTER_STATUS` e `CAM_SETUP_STATUS` acima.
- **Telemetria e ferramenta de desenvolvimento**: `CAM_VERSION` (35), `CAM_CONFIG_LOG`
  (25) e familia, `CAM_STATS_*`, `CAM_PATTERNS_*`, `CAM_JOURNAL_*`, `CAM_TRIAGE_*`,
  `CAM_SUGGESTIONS_*`, `CAM_TEST_LANE`, `CAM_REAP_FIXTURE_DIR`, `CAM_VENDOR_CACHE_DIR`.

Essa classificacao por especie e MEDIDA. A classificacao por sobrevivencia (quais morrem
com o modelo alvo) e PROVISORIA e e o primeiro entregavel do ciclo que fizer a migracao.

## Ids de issue

Os ids `CAM-NNN` entram no escopo do rename por decisao do operador. O custo conhecido e
que 549 issues, mais o journal, os PRDs historicos, os ADRs e os documentos de memoria
referenciam esses ids, entao a migracao precisa preservar rastreabilidade das citacoes
historicas em vez de reescreve-las cegamente. Isso e requisito de desenho do ciclo que
executar, nao motivo para nao executar.
