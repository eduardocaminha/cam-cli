# Definicoes de arquitetura: web, headless, sandbox e credencial

Confirmadas pelo operador em 2026-08-10, apos nove varreduras de evidencia (codigo proprio, Warren e burrow locais, docs oficiais Anthropic/Bun/Docker/shadcn, prior art de mercado, e um repro de runtime executado nesta data). Esta lista guia todo o desenvolvimento a partir daqui. Ela nao substitui ADR: cada item dificil de reverter ganha o seu ADR no ciclo que o implementa, citando esta pagina.

## A. Substrato de execucao

1. Workers rodam headless como processo filho (`claude --print --input-format stream-json --output-format stream-json`). O implementer ja shipou assim (CAM-516, ADR-0059). CAM-521 migra reviewer, planner e auditor e remove o tmux do caminho de worker. Motivo medido: processo filho tem exit code, pane nao tem; a troca e delecao liquida de aproximadamente 1.900 linhas de compensacao de tmux (marcadores duraveis que existem porque send-keys pode ser perdido em silencio, e dispatch verificado que existe porque respawn-pane retorna 0 sem trocar o processo).

2. O tmux permanece em exatamente dois lugares, por merito proprio: o oraculo de gate comportamental via PTY (feature de produto, socket privado) e o wrapper de retry `gship claude` (utilitario autonomo). Em nenhum outro.

3. O orquestrador preserva a funcao integral (onisciente, contexto continuo entre sessoes); muda apenas o substrato. Vira um daemon que dirige o binario `claude` real em stream-json com `--resume`, socket unix, `gship chat` como cliente fino e a web como superficie de conversa. Reinicio por crash usa `--resume` da sessao persistida em `~/.claude/projects/` (sem handoff). Exaustao de contexto usa rotacao de geracao com handoff, num laco TypeScript com contador; o schema do handoff atual sobrevive. Invariantes nao-negociaveis sao re-injetadas na primeira mensagem de cada geracao (achado ConstraintRot, arXiv 2606.22528: violacoes sobem de 0% para ate 59% quando a restricao nao sobrevive a sumarizacao; 0% quando sobrevive). Break-glass: `claude --resume <sessionId>` abre a mesma conversa em TUI completa, o que permite ao `gship chat` ser um REPL minimo em vez de reimplementar TUI. NAO usar o Agent SDK: a pagina legal da Anthropic direciona produtos com SDK para API key e somos subscription-only; sempre executar o binario `claude` real. Substitui aproximadamente 2.300 linhas de src (loop bash de respawn, orch-recycle-watch, tmux/dispatch.ts com residuo de corretude nao fechado) por um laco em processo; sobrevivem o persona, o schema de handoff, os ponteiros duraveis e a aritmetica de threshold. Pendencia dura antes de qualquer codigo: cerimonia validando que sessao criada via `--print` stream-json e retomavel por `claude --resume` interativo.

4. Sandbox e Docker, unico substrato em todas as plataformas (dev macOS, Linux, NAS, Fly.io). Fly Machines embrulham imagem OCI em Firecracker, dando isolamento de microVM na hospedagem sem codigo nosso. O bloqueio headless x container e conserto de uma funcao: `docker exec -i` sem `-t`, builder de argv irmao do dockerExecWrap (o padrao ja existe em container-auth.ts:73 e container-firewall.ts:70). Camada 2 dentro do container: o sandbox nativo do Claude Code em modo estrito. Backend opcional futuro atras do seam backend-adapter: @anthropic-ai/sandbox-runtime, nunca default (beta 0.0.x, sem limites de recurso, deny-list construida no launch nao cobre git clone). Nao reconstruir burrow (sandbox-exec esta deprecado pela Apple sem substituto publicado), nao Apple container (macOS 26 + Apple Silicon apenas), nao gVisor, Firecracker direto ou Landlock. Hibrido Docker-no-Linux com Seatbelt-no-macOS foi rejeitado: daria a maquina de dev uma fronteira diferente e mais fraca que producao. Pendencias no nosso Docker: adicionar `-m`, `--memory-swap`, `--cpus` e `--pids-limit` ao docker run (o journal ja rastreou um OOM SIGKILL a essa ausencia) e ligar o preflightWorkerContainer ja construido e testado.

5. Credencial em modo container entra pelo login no volume de config-dir (a forma medida do ADR-0059), nao pelo passthrough `-e CLAUDE_CODE_OAUTH_TOKEN`. O strip de env feito no host nao atravessa a fronteira do docker exec (o env do processo interno vem do docker run), entao o passthrough atual autenticaria em silencio pela combinacao nao medida.

## B. Credencial e politica

6. Subscription-only agora tem fundamento legal, nao apenas economico. A Anthropic proibe terceiros de rotear requisicoes por credenciais Free/Pro/Max em nome de usuarios, e OAuth e exclusivo para uso ordinario do proprio assinante. Tres linhas que nunca cruzamos: (a) nunca operar instancia hospedada que guarde token de terceiros; (b) nunca reimplementar cliente de API falando com a Anthropic via token OAuth, sempre exec do binario `claude` real; (c) loop 24/7 nao supervisionado e leitura defensavel mas nao isenta de risco de "uso ordinario e individual": documentar a postura, nunca vender como "rode para sempre".

7. Modelo de negocio e distribuicao, nao SaaS. Cada usuario auto-hospeda a propria instancia com o proprio token. Declarar como nao-objetivo explicito na doc (precedente do SPEC do Warren). Sem tabela de usuarios, sem multi-tenancy.

8. Dois canais de credencial. `inherit`: ler o login do host (Keychain no macOS via `security find-generic-password -s "Claude Code-credentials" -w`, arquivo `~/.claude/.credentials.json` no Linux) e materializar no workspace com HOME redirecionado, re-copiando a cada spawn para refresh propagar. `token`: `CLAUDE_CODE_OAUTH_TOKEN` gerado por `claude setup-token`.

9. Armazenamento. O project.toml commitado carrega apenas `[auth] mode = "inherit" | "token"`, e o parser recusa com erro duro qualquer chave desconhecida em `[auth]`, entao colar um token ali falha alto em vez de commitar. O segredo vive em `~/.config/gship/credentials.toml`, diretorio 0700, arquivo 0600, criado por `gship auth login`, fora de qualquer repo. Precedencia: env `CLAUDE_CODE_OAUTH_TOKEN`, depois o arquivo, depois inherit, depois erro com conserto de uma linha. Keychain nunca e requisito (quebra headless nas duas plataformas). Sem criptografia caseira em repouso: a ameaca real e git add acidental e backup mal configurado, chave mestra no mesmo disco nao resolve nenhuma das duas, e nenhum par de mercado (gh, docker, npm, aws, stripe, o proprio Claude Code) faz. Entrega em container: `-e` name-only (worker-container.ts ja faz certo), compose secrets ou fly secrets; nunca ENV em Dockerfile, nunca valor em argv.

10. Strip ativo de `ANTHROPIC_API_KEY` do env de todo spawn de agente. A precedencia oficial do Claude Code poe a API key ACIMA do token OAuth, entao uma chave perdida no host sequestraria o faturamento para a Console org em silencio.

11. Expiracao de token e nossa para construir, com zero prior art (nem Warren nem burrow tratam): setup-token dura 1 ano, sem refresh, sem auto-save. Gravar `expires_at` no credentials.toml e avisar em `gship status` e `gship doctor` a partir de T-30 dias.

12. Defeitos vivos a corrigir: `src/config/models.ts:361` ainda le `resend_api_key` do TOML commitado (remover o caminho de leitura, o escritor ja foi endurecido); o `.env` local esta 0644 (chmod 600 e checagem no doctor).

## C. Web

13. UI: vite + Tailwind v4 CSS-first + shadcn vendorizado a mao (sem components.json, sem CLI do shadcn, sem tailwind.config, sem postcss.config). Radix + cva + clsx + tailwind-merge. Tokens num unico bloco `@theme`, dark por atributo `data-theme` com script inline anti-FOUC. Identidade visual: branch `/coss` do cam-dss (decisao de 2026-08-05), o que responde o CAM-421: o dashboard adota a identidade, nao sobe sem estilo. Por que vite, medido em runtime em 2026-08-10: a CLI do `bun build --compile` nao roda plugins; Tailwind no Bun depende do bun-plugin-tailwind 0.1.2 (parado desde 2025-10, era v3, sem peer de tailwindcss); e o bug oven-sh/bun#23646 reproduziu no nosso repro (binario compilado sobe, serve Tailwind cru nao processado, falha silenciosa). Tailwind v4 nao tem integracao de primeira parte com Bun. O vite e ferramenta de build-time e nunca entra no binario shipado. A linha "don't use vite" do CLAUDE.md era boilerplate do pacote bun-types (byte-identica ao arquivo do vendor), nao decisao de engenharia; sera recortada com ADR.

14. API: `Bun.serve` com a opcao `routes` NATIVA (existe desde Bun 1.2.3; o roteador a mao do Warren e anterior a ela e nao e a referencia). Sem Hono, sem Express. Handlers como funcoes puras atras de adaptador HTTP fino, para que uma eventual migracao a Hono custe um arquivo e nao setenta handlers. Custos aceitos e documentados: 404 em vez de 405 em metodo errado (oven-sh/bun#18197, aberto) e gerador de OpenAPI proprio de ~180 linhas usando `z.toJSONSchema` do Zod 4, com schemas anexados a tabela de rotas desde o dia 1 (a licao do gerador-esqueleto do Warren). Gatilhos registrados para reavaliar Hono: OpenAPI com corpos virar requisito duro, precisar rodar o mesmo HTTP fora do Bun, auth crescer alem de um bearer, ou passar de ~150 rotas.

15. Mesmo processo e mesma origem: o servidor serve o SPA. Sem CORS, sem segunda porta, sem nginx.

16. API sob `/api/*` desde o primeiro dia. O Warren nao fez, colidiu rota de API com rota de browser e precisou de HashRouter; o erro esta documentado no proprio codigo dele e evita-lo e gratis.

17. Eventos ao vivo: NDJSON sobre GET longo (nao WebSocket, nao SSE), reconexao por `?since=<seq>` com backoff exponencial ate 30s, dedup por seq monotonico. `idleTimeout: 0` no Bun.serve (o default de 10s mata stream quieto; o Warren tem bug id proprio para isso).

18. Banco: SQLite unico via `bun:sqlite` + drizzle. Sem Postgres, sem dual-dialect (o maior imposto do codebase do Warren: dois schemas, teste de drift, adapter sobre cada repo, migrations em par). `migrate()` no boot com o wrapper de `PRAGMA foreign_keys` OFF/ON, WAL, synchronous NORMAL, busy_timeout 5000, pragmas pulados em :memory:.

19. Escrever no banco primeiro, publicar depois num broker em memoria nao-duravel; a tabela e a fronteira de recuperacao; assinantes abrem a subscription ANTES do replay do historico, com dedup por seq (o detalhe nao-obvio de corretude do Warren).

20. Auth da superficie web: um bearer token com seam AuthProvider para o futuro; isentar todo path nao-API, senao a tela de login toma 401 antes de renderizar; comparacao com timingSafeEqual.

21. Timestamps ISO8601 como TEXT em toda parte, sem traducao em fronteira nenhuma.

## D. Distribuicao do binario

22. Levantar o teto auto-imposto de 100 MB do build-release.sh. Os binarios linux estao em 98 MB com folga de 1,34 MB, e um bundle React + Tailwind + shadcn come isso. Medir o custo real de download antes de qualquer otimizacao de tamanho.

23. Embarcar o `dist/**` da UI estendendo o `generate-embedded-vendor.ts`, que ja inlina diretorio recursivo como string constants com gate de drift (`--check`) e teste byte a byte. Evita o problema de filename com hash que `with { type: "file" }` criaria.

## E. Estado interno do supervisor

24. Event log com replay deterministico como direcao de estado (modelo OpenHands), pagando onde a complexidade se concentra: reconstrucao de estado apos morte de worker em loop.ts e plan-runner.ts. Para o orquestrador, o JSONL da sessao Claude ja E o event log; nao construir um segundo.

25. Delecoes ganhas por medicao (62 dias de event log, 94.684 eventos, 1.377 dispatches): teto de token por worker (zero disparos na historia, CAM-5), post-merge-stalled-marker (o proprio header admite que nao esta ligado a nada), deteccao de morte precoce (1 disparo em 1.377, ~90 minutos economizados em 7 semanas por 62,9M tokens; a retratacao ja esta no journal).

26. Resiliencia mantida, ganha por incidente com taxa real de disparo: guarda de no-progress (CAM-36), backoff de worker morto (69 disparos), retry de review (CAM-37), dispatch verificado (41 disparos, CAM-433), verificacao de push e commit, finalize com gate do supervisor (ADR-0035).

## F. Ordem de execucao

27. CAM-530 (fonte unica de templates) e depois CAM-529 (superficie de instrucao, delecao do gate agents-md, hook de pre-commit inexistente) antes do epico web/headless, aplicando a premissa de reduzir superficie antes de policiar. O epico segue na ordem: CAM-521 (headless dos papeis restantes e remocao do tmux do caminho de worker), daemon do orquestrador, CAM-522 (web read-only). O texto do CAM-421 esta stale (ainda descreve e-ink) e sera atualizado na especificacao do CAM-522.

## Pendencias abertas nomeadas

- Cerimonia de interop resume (fundamento do item 3): validar com sessao descartavel que `claude --resume` interativo abre a mesma conversa de uma sessao criada via `--print` stream-json. Antes de qualquer codigo do daemon.
- Warren local do operador: o `.env` de os-eco/warren seta `ANTHROPIC_API_KEY` e `CLAUDE_CODE_OAUTH_TOKEN` juntos; pela precedencia oficial a API key ganha, entao as runs hospedadas provavelmente faturam na API e nao na assinatura. Acao do operador, fora do escopo gateship.
- Implementer com backend codex fim a fim sob o sidecar segue nao medido; CAM-526 e a sonda designada.
