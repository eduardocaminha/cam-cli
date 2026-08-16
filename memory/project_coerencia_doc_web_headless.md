# Coerencia da documentacao contra as definicoes de web e headless

Inventario levantado em 2026-08-11 por seis varreduras dirigidas, todas confrontando
a documentacao viva contra `memory/project_definicoes_web_headless.md` (as 27 definicoes
confirmadas pelo operador em 2026-08-10). Este arquivo existe para que os ciclos
CAM-529, CAM-521, CAM-522 e o daemon citem o inventario em vez de re-derivar.

Cobertura: ADRs (62 arquivos), superficie de instrucao (`CLAUDE.md` raiz,
`scripts/cam/CLAUDE.md`, 5 personas, slash commands, `patterns.md` por grep),
`docs/recovery-runbook.md` (27 secoes), README, `docs/positioning.md`,
`docs/launch-readiness.md`, `docs/cam-runtime-web-sugestoes.md`, `CONTEXT.md` e
`CHANGELOG.md` por grep, holding pen de suggestions (177 entradas).

Ressalva de metodo registrada na origem: 8 das 10 secoes do runbook classificadas
como intactas foram varridas por grep, nao abertas.

## Decisoes do operador ainda pendentes

1. Dispatch verificado. O item 1 manda deletar, o item 26 manda manter. Recomendacao
   registrada: deletar a implementacao de tmux (`sendKeysVerified`,
   `src/tmux/dispatch.ts:566`, `src/supervisor/verified-dispatch.ts`) e preservar a
   garantia como checagem de pid e exit code do processo filho. Tres varreduras
   independentes acharam esse mesmo ponto (contrato, CONTEXT.md:426-429, ADR sweep).
2. Codex na imagem. O operador decidiu em 2026-08-11 que host mode e aposentado e so
   fica Docker. Bloqueador medido: `.devcontainer/Dockerfile` nao instala codex e
   `project.toml` tem `backend.implementer = "codex"`. Ou codex entra na imagem, ou o
   implementer volta para claude.
3. Sonda de codex. A linha 75 do contrato aponta CAM-526, que e o write-guard do
   ADR-0035. A issue de quota e codex e a CAM-435. Ou o id esta trocado, ou a sonda
   nunca foi filada.
4. Camada A do gate comportamental. `subagent-implementer.md:86-90` manda abrir sessao
   tmux privada dentro do worker. Sob headless em container isso falha em execucao.
   Escolher entre Layer A sem tmux, ou Layer A eliminada com o gate so no reviewer.

## Correcoes de fato dentro do proprio contrato

- Item 22 descreve a folga do teto como 1,34 MiB. O gate trunca para inteiro antes de
  comparar (`scripts/build-release.sh:125`), entao so dispara em 101 MiB ou mais. Folga
  real medida em linux-x64, 2,34 MiB.
- Item 23 e mais caro do que o contrato assume. A codegen le utf8 nos dois sitios
  (`scripts/generate-embedded-vendor.ts:111,127`), entao fonte ou imagem no bundle exige
  trilha base64 inexistente, a mais 33 por cento de tamanho.
- Item 25 justifica deletar o marcador post-merge-stalled dizendo que ele nao esta ligado
  a nada. Ele e referenciado em quatro modulos (`post-merge.ts`, `status.ts`,
  `status-diagnostics.ts`, `sidecar.ts`) e no boot da persona do orquestrador. A delecao
  pode continuar certa por medicao, o motivo escrito nao se sustenta.
- Item 13 sub-dimensiona o recorte do vite. A justificativa de boilerplate byte-identico
  ao bun-types confirma para `CLAUDE.md:55`, mas o veto vive tambem em `CLAUDE.md:2`
  (front-matter autoral), `scripts/cam/CLAUDE.md:32` e `scripts/cam/CLAUDE.md:64`, esta
  ultima dentro do bloco declarado como leitura integral obrigatoria por story.
- Item 4 nunca declara host mode aposentado, apenas diz que Docker e substrato unico. A
  decisao do operador de 2026-08-11 fecha essa porta e precisa entrar no texto.

## Superficie de instrucao

Classe mais grave, porque agente le em tempo de execucao e obedece.

- `scripts/cam/CLAUDE.md:93` governa apenas a marcacao de bullets do `patterns.md` com o
  prefixo `[resolved YYYY-MM]`, que e o que `gship patterns archive` move para o arquivo
  de arquivo. Ela nao proibe editar o texto dos invariantes curados na linha 64, e
  `scripts/cam/patterns.md` tem zero ocorrencias de vite, entao nao existe bullet a
  resolver e a linha nunca e acionada pelo recorte do vite. A afirmacao anterior deste
  bullet, de que a linha 93 travava o recorte inteiro e um worker disciplinado recusaria
  o epico citando essa linha, estava errada; corrigida em 2026-08-11.
- `scripts/cam/patterns.md:14` mantem a proibicao absoluta de `claude -p` sem citar o
  recorte do ADR-0059, enquanto `scripts/cam/CLAUDE.md:95` carrega o recorte com evidencia
  e oraculo. Contradicao viva hoje, e o roteamento oficial manda grepar patterns.md.
- `scripts/cam/CLAUDE.md:44` e `:68` condicionam o gate de drift a stories que tocam
  `vendor/` ou `templates/`. Sob o item 23 o `dist/**` da UI entra pelo mesmo gerador,
  entao uma story de UI pula o gate e commita embed stale.
- `scripts/cam/CLAUDE.md:36` descreve toda sessao como split de tmux.
- `.claude/commands/cam-next.md` codifica o modelo antigo inteiro (pane titulado, mutex de
  tres panes, respawn-pane, notifyOrchestrator, fallback de scrollback) e e o unico lugar
  que afirma a proibicao de `claude -p` para workers, na linha 33.
- `.claude/commands/cam-review.md:9,26`, `cam-plan.md:5,30`, `cam-issue.md:15` e
  `cam-spec.md:3` assumem pane e send-keys como transporte.
- `.claude/agents/subagent-implementer.md:177` descreve a sessao como TUI interativa
  terminada por `respawn-pane -k`; `:117` e `:165` mandam empurrar resumo para o pane do
  orquestrador.
- `.claude/agents/subagent-reviewer.md:266` usa `capture-pane -p -S -` para detectar a tag
  de veredito. Isso e transporte e morre.
- `.claude/agents/subagent-auditor.md:140` e `subagent-planner.md:129,191,196` citam pane e
  tmux como termo de dominio.
- `patterns.md:74`, `:338` e `:908` documentam, respectivamente, a premissa de que a regra
  de subscricao forca TUI, que worker interativo nunca sai sozinho, e o teto de token por
  worker do CAM-5.

Lacuna, nao conflito: os itens 4, 5, 9, 10 e 25 tem cobertura zero nas personas e nos
comandos. Os invariantes de credencial em container e o strip de `ANTHROPIC_API_KEY` nao
tem superficie de enforcement em agente nenhum, e precisam nascer como invariante novo no
auditor e no checklist de seguranca do reviewer.

## O que sobrevive e nao pode ser tocado

O gate comportamental Layer B do reviewer e feature de produto, preservada pelo item 2.
No mesmo arquivo convivem os dois usos de tmux, e um sed global destroi a feature.

- Fica: `subagent-reviewer.md:39`, `:45-55` (incluindo a linha 51, que e captura do
  oraculo), `:158`, `:183`, `:194`, `:228`, `:232`, e `subagent-planner.md:100`.
- Morre: `subagent-reviewer.md:266`, que e deteccao de conclusao por scrollback.

## ADRs

Sete contraditos, cinco erodidos, doze reforcados. Precisam de ADR novo de supersessao,
nunca reescrita do antigo, seguindo o precedente ADR-0049 para ADR-0050.

- Contraditos: 0004 (planner em pane), 0059 (headless por flag), 0046 (codex em pane TUI),
  0025 (marcador post-merge-stalled), 0003 na secao de credencial, 0038 (sem zod) e 0044
  por arrasto.
- Erodidos: 0048, 0029, 0047, 0024, 0039.
- Reforcados, entre outros: 0005 (gate PTY), 0035, 0042, 0060, 0034, 0011, 0026.

Ponta solta estrutural: nao existe campo de status nos ADRs de 0010 a 0062, entao nao ha
onde marcar supersessao. Hoje supersessao e prosa em negrito no fim do arquivo. Alem
disso, ADR-0013 foi parcialmente superseded por uma issue e nao por um ADR, e ADR-0003 e
ADR-0006 foram editados depois de aceitos, que e a reescrita que a convencao proibe.

Zod merece decisao propria. ADR-0038 sustenta zero dependencia nova de runtime no binario
e ADR-0044 replica a clausula. O item 14 adota Zod 4 e o item 18 adiciona drizzle. O
proprio ADR-0038 registrou o gatilho de supersessao.

## Runbook

27 secoes. Cinco orfas, quatro conflitos duros, oito sobrevivem com retoque, dez intactas.

- Pior item, secao (x) na linha 2100. Instrui ativamente o caminho de credencial que o
  contrato proibe (`CLAUDE_CODE_OAUTH_TOKEN` via `.env` e `containerEnv`) e rebaixa o
  login no volume a conveniencia de desenvolvimento interativo. Enquanto existir, quem
  seguir o runbook autentica pela combinacao nao medida.
- Secao (f) na linha 222 afirma que `-p` e proibido para contas de subscricao citando
  CAM-42, o que colide de frente com o item 1. Mesma flag nos dois lados, resolver antes
  do CAM-521.
- Secao (c) na linha 118 e a unica receita de finalize manual pos-crash. Nao pode ser
  deletada junto com o handoff-para-crash sem antes ser reancorada em
  `worker-report.json` mais event log.
- Secao (y) na linha 2324 sai de graca, o conteudo util ja vive duplicado na secao (n).
- Orfas restantes: (b) linha 87, (e) linha 189, (k) linha 560, (p) linha 1091.

## README, docs e CONTEXT

- README tem seis conflitos duros, todos da mesma familia (tmux split universal, injecao
  por send-keys, respawn por wrapper, workers como TUI, container como opt-in com host
  por default, secao inteira de panes nas linhas 261-274).
- `docs/launch-readiness.md` afirma que `RESEND_API_KEY` so vem do env, mas
  `src/config/models.ts:361` ainda le `resend_api_key` do TOML commitado, que e o defeito
  vivo do item 12. Os quatro gaps que ele nomeia nao incluem a precedencia de
  `ANTHROPIC_API_KEY` (item 10) nem o canal de credencial em container (item 5).
- Tres dimensoes do launch-readiness ja fecharam e o relatorio nao sabe. Linux e x64
  compilam (`scripts/build-release.sh:95-96`), o `package.json` e `gateship` com
  `private: false` e campo `bin`, e existem install.sh, Release, SHA256SUMS e attestation.
  O veredito No-go dele caducou.
- `docs/cam-runtime-web-sugestoes.md` (1423 linhas, de 2026-07-13) propoe stack anterior e
  concorrente (Hono ou Bun.serve em aberto, WebSocket ou SSE, xterm.js, TanStack, duas
  lojas de dados, rotas sem prefixo, tmux mantido como backend). Nao deve ser reescrito,
  e registro historico e origem rastreavel do CAM-408. Deve receber cabecalho que nomeie
  as secoes mortas uma a uma apontando o item que as substituiu.
- O vazamento importa mais que o doc. `CAM-408` esta aberta repetindo a stack superada sem
  ressalva. Ela e `stage:idea`, portanto fora do alcance do planner, mas quem rodar
  `/cam-spec CAM-408` comeca a entrevista pela stack errada. Consertar antes de
  especificar.
- `CONTEXT.md` tem verbetes orfaos em `:68-69`, `:177-186` e `:189,192`, e o verbete de
  verificacao de identidade por `pane_pid` em `:426-429` cai na contradicao do dispatch
  verificado.

## Roteamento por ciclo

- CAM-529 continua valioso como reducao de superficie de instrucao e como reconciliacao
  de `patterns.md:14` com o recorte do ADR-0059, mas NAO e pre-requisito do epico web nem
  do headless. A afirmacao anterior de que `scripts/cam/CLAUDE.md:93` travava o recorte
  estava errada (a linha governa so a marcacao `[resolved]` de bullets do `patterns.md`;
  corrigida em 2026-08-11). O recorte do vite nao tem cadeado e foi executado em
  2026-08-11 com o ADR-0063. Escopo restante: reconciliar `patterns.md:14`, corrigir o
  gatilho condicional do gate de drift, e reescrever `cam-next.md`.
- CAM-521 absorve: personas e comandos de worker, secoes orfas do runbook ligadas a pane,
  ADR novo de supersessao para 0004, 0059, 0046 e a secao de credencial do 0003, e a
  decisao sobre Layer A.
- CAM-522 absorve: adocao de Zod com supersessao do ADR-0038, levantamento do teto com
  atualizacao do numero citado no ADR-0057, e a correcao do README e do launch-readiness.
  O recorte do vite, antes listado aqui, foi executado em 2026-08-11 com o ADR-0063.
- Daemon absorve: ADR novo cobrindo as clausulas de orquestrador do 0029 e do 0047, o
  ADR-0048, os verbetes orfaos de CONTEXT.md e as oito secoes do runbook que sobrevivem
  com retoque.
- Fila de delecoes do item 25 ainda nao tem issue. Precisa nascer, e inclui a re-checagem
  dos cinco pontos de leitura do marcador post-merge-stalled.

## Estado do holding pen

De 177 entradas, 26 foram descartadas em 2026-08-11 por morrerem com a superficie de tmux
e com o item 25. Restam 151. As demais foram agrupadas por fix-site, e as composicoes
propostas seguem sem promover, por politica de promocao sob demanda.

Defeito de produto identificado no proprio pen e ainda nao filado. O fingerprint muda a
cada round de review e o dedup e por fingerprint, entao o mesmo achado e refilado a cada
rodada. A CAM-482 aparece tres vezes, nos rounds 3, 5 e 7.

## Testes de tmux, inventario de 2026-08-11

Levantado depois do recorte do vite, para responder se ainda precisamos de teste tmux.
Serve de insumo direto ao CAM-521 e ao ciclo do daemon.

Numeros medidos em 2026-08-11: 114 arquivos de teste mencionavam tmux. A previsao era
que sobrevivessem seis, tres do oraculo de gate comportamental e tres do wrapper de
retry `gship claude`. Em 2026-08-16, o wrapper e seus tres testes tmux foram removidos;
ele nao participava de nenhum ciclo. Portanto sobrevivem por contrato apenas os tres
do oraculo (`test/integration/behavioral-gate.test.ts`,
`test/supervisor/behavioral-gate.test.ts`, `test/supervisor/prd-oracle-lint.test.ts`). Morrem inteiros 32
arquivos, 266 testes, mais 60 a 120 testes parciais nos cerca de 25 arquivos mistos, onde
a logica do comando fica e so as assercoes de argv de split-window, respawn-pane e
send-keys saem. Corte total estimado entre 330 e 390 testes.

Esse corte e a maior simplificacao disponivel no projeto hoje, e e delecao pura, sem
troca de mecanismo por mecanismo. E argumento de priorizacao para o CAM-521 e o daemon
acima de feature nova.

Tres pontos que precisam sobreviver ao corte, e por que.

1. A politica de reciclagem por contexto nao e teste de tmux. O arquivo
   `test/commands/orch-recycle-watch.test.ts` (28 testes) nao toca tmux real: testa
   `checkBackstop`, a fracao de backstop, e o fallback de handoff com clock injetavel. O
   item 3 do contrato diz que a aritmetica de threshold sobrevive ao daemon, entao esses
   testes sao a especificacao executavel dela. Deletar o arquivo pelo nome perde um
   requisito, nao um teste. O ciclo do daemon precisa de criterio de aceite explicito
   dizendo que a politica migra e so o atuador (SIGTERM em pane mais marcador) morre.

2. O menu de setup morre por consequencia, e o sequenciamento importa.
   `buildSetupMenuScript` (`src/commands/setup.ts:810`) spawna o pane do orquestrador por
   split-window e faz polling de sentinel por capture-pane. A funcao dele e abrir o pane
   do orquestrador, entao quando o orquestrador deixa de ser pane a funcao some junto.
   Nao e uma terceira superficie tmux a preservar. Mas ele morre no ciclo do DAEMON, nao
   no CAM-521: ate o daemon existir, `gship run` ainda e como o operador trabalha. Os 30
   testes associados (`setup-menu-viewer-live`, `setup-config-log`, `setup-menu`) seguem
   o mesmo calendario.

3. A lacuna de cobertura em terminal real e modesta, nao e buraco. Medido em 2026-08-11:
   as telas Ink tem cobertura de render em `test/ui/` (config-screen, splash, tab-bar,
   dashboard-story-row, teclas de init e setup). O que nao existe e teste ponta a ponta em
   terminal real dessas telas. A maquina para fechar isso ja existe e e preservada pelo
   item 2, porque o gate comportamental dirige Ink por PTY. Nao e mecanismo novo, e
   apontar mecanismo existente. Entra quando algum ciclo tocar essas telas.

Correcao de metodo registrada: a varredura original afirmou que nenhuma tela Ink tinha
cobertura. A medicao direta refutou. Pela segunda vez neste dia uma varredura
superdimensionou um achado e a medicao corrigiu; a primeira foi o suposto cadeado da
linha 93.

Consequencia de triagem: nenhuma issue foi filada a partir deste inventario. Os dois
testes que falharam localmente durante o recorte do vite
(`test/integration/orch-recycle-watch.test.ts` e `test/integration/setup-menu-viewer-live.test.ts`)
sao ambos da classe que morre, entao estabiliza-los seria pagar para manter viva uma
superficie que o epico apaga.
