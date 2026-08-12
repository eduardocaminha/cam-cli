# Decisoes do CAM-544 (headless em container), tomadas antes do spec

Entrevista de spec do CAM-544 iniciada em 2026-08-12 e INTERROMPIDA de proposito
antes de persistir os criterios de aceite. Quatro decisoes foram tomadas com
evidencia e ficam registradas aqui porque `gship issue` nao tem edit (CAM-540 e
CAM-542) e a entrevista sera retomada depois que o CAM-521 shipar.

Motivo do adiamento, e ele e de engenharia e nao de agenda: o CAM-521 parametriza
`stripHeadlessChildEnv` por ator (US-001) e introduz o contrato de tres sinais
(US-002), que sao exatamente as superficies que o CAM-544 modifica. Oraculo
varrido contra a main de hoje apodreceria quando o CAM-521 landasse, violando a
regra de varrer contra a arvore pre-mudanca.

## Decisao 1: contagem de token vem do stream, e o teto morre junto

Fonte de token no caminho headless passa a ser o campo `modelUsage` do evento
terminal `result`, lido da linha que `classifyHeadlessStreamLine` ja classifica
hoje. O teto de token por worker (CAM-5) e DELETADO no mesmo ciclo.

Evidencia que sustenta:

- O parser de transcript quebra em container por dois motivos independentes: o
  transcript cai no volume nomeado `claude-code-config`, que nao e bind-mount e
  e invisivel ao host, e mesmo se caisse o parent codifica o cwd do host
  enquanto o filho roda em `/workspace`. A falha e silenciosa, porque
  `readWorkerTokens` devolve `null` em path ilegivel (`events.ts:914-915`).
- O parser de transcript ja esta errado hoje, independente de container. A doc
  oficial de cost-tracking do Agent SDK registra que o `output_tokens` de cada
  mensagem assistant e placeholder, a contagem que a API reportou no
  `message_start` antes de a resposta existir, e que uma resposta da API produz
  varias mensagens assistant todas carregando o mesmo placeholder. Somar
  mensagens assistant produz numero errado por desenho. Nosso
  `parseTranscriptUsage` dedupa por `msgId|reqId`, o que resolve a dupla
  contagem mas nao o placeholder.
- O campo correto e `modelUsage` e nao `usage`. A mesma doc tabula: `usage`
  exclui tokens de subagente, `total_cost_usd` e `modelUsage` incluem. Nossos
  workers rodam com `--agent subagent-<papel>`. Campos de `modelUsage`:
  `inputTokens`, `outputTokens`, `cacheReadInputTokens`,
  `cacheCreationInputTokens`, `costUSD`, por modelo.
- O ecossistema convergiu nisso para a nossa categoria exata (supervisor que
  spawna claude como filho). A propria action oficial da Anthropic,
  `anthropics/claude-code-action`, acumula as mensagens em
  `base-action/src/run-claude-sdk.ts`, pega o ultimo elemento em
  `src/entrypoints/update-comment-link.ts` para ler `total_cost_usd`, e renderiza
  `input_tokens`, `cache_creation_input_tokens` e `cache_read_input_tokens` em
  `src/entrypoints/format-turns.ts`. Nunca toca `~/.claude/projects`. Mesmo
  mecanismo em vibe-kanban, cmux (que e orquestrador de container) e humanlayer.
- Telemetria nativa foi avaliada e REJEITADA para este uso. Claude Code tem OTEL
  completo, com metrica `claude_code.token.usage` quebrada por
  `type=input|output|cacheRead|cacheCreation` e atributo
  `query_source=main|subagent|auxiliary`, correlacionada por `session.id`. Mas
  exige collector ou scrape, o intervalo default de export e 60 segundos sem
  garantia documentada de flush no exit (run curta nao emite nada), e nao existe
  exporter de arquivo. Os consumidores reais sao stacks de observabilidade, nao
  processos pai. O projeto flagship do genero esta parado ha mais de um ano.
- O teto cai por consequencia e nao por conveniencia: o evento `result` so chega
  no fim e a contagem por mensagem e placeholder por desenho, entao nao existe
  forma correta de construir teto mid-run a partir do stream. Somado aos zero
  disparos em 1.377 dispatches ja medidos no item 25 do contrato, deletar e a
  unica saida coerente.

## Decisao 2: credencial em container vai por `-e CLAUDE_CODE_OAUTH_TOKEN`

O builder de `docker exec` do caminho headless passa o token por `-e`
name-only, espelhando o que `worker-container.ts:309-310` ja faz no `docker run`
do caminho tmux. A lista de `-e` e explicita e deny-by-default: nada e herdado.

Entra: `CLAUDE_CODE_OAUTH_TOKEN`, `CAM_WORKER=1`, `CAM_SESSION`, `GITHUB_TOKEN`.
Nao entra: `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, `TMUX`, `TMUX_PANE`,
`CLAUDECODE` e familia.

Evidencia que sustenta, incluindo a que derrubou a recomendacao inicial oposta:

- Sob `docker exec`, `stripHeadlessChildEnv` deixa de ser a superficie de
  controle. O env map entregue ao `Bun.spawn` vale para o cliente `docker` no
  host, nao para o processo dentro do container. Quem decide o env interno e a
  lista de `-e` no argv. Hoje nada faz esse forwarding.
- O token existe e esta populado: `.env` do repo carrega
  `CLAUDE_CODE_OAUTH_TOKEN` com 108 caracteres e prefixo `sk-a`, forma de
  `claude setup-token`, artefato de assinatura e nao API key. Bun auto-carrega
  `.env`, entao o sidecar ja tem no `process.env`.
- O ADR-0059 nao proibe este caminho, ele PEDE esta decisao. Consequencias,
  verbatim: "Fica registrado como divida explicita que a combinacao container
  mais token por variavel de ambiente nao foi medida, e que a decisao de qual
  credencial o caminho headless usa precisa ser tomada e declarada, ja que hoje
  o modo host remove o token do ambiente do worker de proposito e o modo
  container o mantem."
- O item 5 do contrato (`memory/project_definicoes_web_headless.md`) atribui a
  alternativa (login no volume de config-dir) uma medicao que ela NAO tem. Ele
  diz "a forma medida do ADR-0059", mas o ADR mediu "worker rodando no host e
  autenticando pelo diretorio de configuracao". Volume de container nao e
  diretorio de config do host. As duas opcoes sao igualmente nao medidas, e o
  argumento que eu usei contra o passthrough se aplicava identicamente a
  alternativa que eu recomendava. O item 5 precisa de emenda.
- A alternativa e inverificavel nesta maquina: nada no codigo estabelece o login
  no volume (varredura por `claude login`, `setup-token`, `.credentials.json`
  em `src/` devolve so hits de documentacao), ele viria de um `claude login`
  manual rodado uma vez dentro do container, e o daemon do Docker nao esta
  rodando aqui, entao o estado do volume nao pode ser conferido.
- `CLAUDE_CONFIG_DIR` esta setado no host como `/Users/eduardo/.claude-pessoal`.
  Como `stripHeadlessChildEnv` herda `process.env` inteiro, essa variavel
  atravessaria e faria o filho procurar, dentro do container, um path que so
  existe no host. E a razao concreta de a lista de `-e` ser deny-by-default em
  vez de um strip sobre heranca.
- `CAM_WORKER=1` e obrigatorio na lista: o ACL do write-guard do ADR-0035 depende
  dele chegar ao processo interno. Sem isso o guard fica inerte dentro do
  container, mesma classe do defeito que o CAM-549 registra para codex.

O ADR do CAM-544 declara esta escolha, fechando a pendencia que o ADR-0059
deixou aberta, e a medicao de consumo em container (a mesma cerimonia de console
que o ADR-0059 descreve) entra como criterio do ciclo.

## Decisao 3: `-w` explicito, so no builder novo, com origem no `workspaceFolder`

O builder de `docker exec` do caminho headless passa `-w` explicito, e o valor
vem de `workspaceFolder` do `.devcontainer/devcontainer.json`, nunca hardcoded.
O `dockerExecWrap` do caminho tmux NAO e alterado.

Evidencia que sustenta:

- A doc do Docker nao documenta o comportamento que a alternativa dependeria.
  `docker container exec` diz apenas "runs in the same working directory set
  when the container was created", e o exemplo adjacente imprime `/`. A doc do
  `WORKDIR` lista `RUN`, `CMD`, `ENTRYPOINT`, `COPY` e `ADD`, e `exec` nao esta
  na lista. A garantia real so existe no source do moby (`daemon/exec.go:147-149`
  e `:273-274`, cadeia `exec -w` para `Config.WorkingDir` para `/`), portanto e
  detalhe de implementacao e nao contrato.
- O comportamento ja mudou uma vez: o commit `ddae20c0` do moby, de 2025-09-22,
  na migracao para containerd 1.0, passou a honrar o WORKDIR da imagem no exec.
  Antes nao honrava. Classificado como breaking behaviour em vmware/vic#8166.
- A implementacao de referencia da spec que este repo espelha sempre passa a
  flag: `devcontainers/cli`, funcao `toDockerExecArgs` em
  `src/spec-shutdown/dockerUtils.ts`, faz `if (cwd) { execArgs.push('-w', cwd); }`,
  e `-w` vem antes do nome do container.
- Os seis builders irmaos do repo nao passam `-w`, mas isso nao e precedente:
  todos sao workdir-independentes, usando path absoluto ou probe de `--version`.
  `dockerExecWrap` e o unico sitio de exec cuja correcao depende do cwd, porque
  o filho escreve `worker-report.json` de forma relativa. E `container-config.ts:78`
  ja passa `-u root` explicito em vez de herdar, entao pinar atributo de exec ja
  e padrao da casa.
- `.devcontainer/devcontainer.json` ja declara `"workspaceFolder": "/workspace"`
  e nada no codigo le. Existe `test/supervisor/worker-container-parity.test.ts`
  construido para pegar drift entre o devcontainer.json e o argv TS, com blocos
  para `runArgs`, `workspaceMount`, `mounts`, `containerEnv` e `remoteUser`, e
  nenhum bloco para `workspaceFolder`. Fechar esse buraco de paridade entra no
  mesmo ciclo.
- Nao tocar o `dockerExecWrap` porque o CAM-545 deleta o caminho tmux inteiro.
  Endurece-lo custaria alterar quatro assercoes em
  `test/supervisor/docker-exec.test.ts` (linhas 28, 40, 46 e 73, que pinam a
  ausencia da flag) numa superficie agendada para delecao. Mesma regra de
  `memory/project_nomenclatura_gateship.md`: classificar o que morre antes de
  mexer no que sobra.

## Decisao 4: a ordem do epico inverte, CAM-521 antes de CAM-544

O `blockedBy` do CAM-521 apontando para CAM-544 estava ERRADO e foi removido em
2026-08-12.

Evidencia que sustenta:

- A justificativa escrita no CAM-544 diz "O CAM-521 deleta o caminho tmux do
  worker (1.466 linhas medidas). Se o CAM-521 shipar antes deste desbloqueio, o
  modo container fica com zero caminho de worker". O escopo do CAM-521,
  especificado no dia seguinte, diz o oposto: "mantendo o caminho tmux como
  default e fallback. NAO deleta tmux (isso e CAM-545)". O numero 1.466 e
  literalmente o do titulo do CAM-545. A delecao migrou de issue e a
  justificativa do CAM-544 ficou apontando para a issue errada.
- Nenhum dos 14 criterios do CAM-521 menciona container. Ele e
  container-independente.
- CAM-544 e pre-requisito do CAM-545, nao do CAM-521.
- Na ordem invertida o CAM-544 herda o contrato de tres sinais pronto, entao a
  classe de falha que ele introduz (`docker exec` falhando por container ausente
  ou binario ausente, que sai nao-zero, sem evento terminal, com stderr hoje
  descartado por `stderr: 'ignore'` em `headless-dispatch.ts:343`) nasce coberta
  em vez de invisivel.

Mecanica da remocao, registrada porque nao e obvia: `blockedBy` so bloqueia
enquanto a dependencia nao esta `stage:shipped` (`graph.ts:8-16`, `status` nunca
e lido, entao `abandon` NAO desbloqueia), e `isPlannable` consulta `isBlocked`
nos dois caminhos, com o id explicito validando mais e nao menos
(`plannable.ts:20-26`, `plan.ts:154`). Nao existe writer de `blockedBy` de issue
existente alem de `specifyIssueOnMain`, e a filagem descarta o campo em silencio.
O unico caminho honesto foi `gship issue demote` seguido de
`gship spec --persist` com o campo omitido, aproveitando que o demote preserva
spec e wsjf (`issue-specify.ts:635`). Round-trip conferido byte a byte.

## Pendencias que a entrevista ainda nao cobriu

Ficam para a retomada, depois que o CAM-521 shipar:

- Captura de stderr. Hoje e `stderr: 'ignore'` (`headless-dispatch.ts:343`), e
  falha de `docker exec` aparece quase so em stderr. O caminho tmux tem captura
  por `pipe-pane` para `.claude/cam-worker-out-<fase>-<uuid>.log`; o headless nao
  tem equivalente.
- Ensure e preflight de container no ramo headless. O ramo tmux chama
  `ensureContainerFn` (`loop.ts:1561`) e checa `preflightResult.ready`
  (`loop.ts:1614`); o ramo headless nao chama nenhum dos dois.
- Inversao dos tres testes de `test/supervisor/headless-container-failclose.test.ts`.
  Atencao ao de linha 160 ("never wraps through docker exec"), que asserta sobre
  `opts.spawn`, superficie que o caminho headless nunca usa: pos-mudanca ele
  passaria vacuamente. Precisa ser reapontado para o builder de argv.
- Tripwire de documentacao: `test/docs/recorte-fidelity.test.ts:99-111` falha se
  o paragrafo de recorte em `scripts/cam/CLAUDE.md` afirmar que a combinacao
  container mais token foi medida. Qualquer edicao de doc do CAM-544 esbarra
  nele enquanto a medicao nao existir.
