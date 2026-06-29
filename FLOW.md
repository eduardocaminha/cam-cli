# FLOW: mapa das telas do cam-cli

Mapa de como as telas (surfaces) do `cam` se conectam conforme as decisões do operador.
Os diagramas são Mermaid: renderizam como diagramas reais no GitHub ou no preview de
markdown do VS Code. O texto em volta resume cada bifurcação.

Convenção dos diagramas:

- Retângulo: uma tela ou um passo que produz output.
- Losango: ponto de decisão (uma escolha do operador ou um galho automático).
- Linha cheia: transição que sempre acontece.
- Linha pontilhada: transição condicional, alternativa, ou "depois, manualmente".
- `exit N`: código de saída do processo naquele ramo.

Inventário rápido de quem renderiza o quê:

| Comando | Render | Telas / estados |
|---|---|---|
| `cam help`, `cam <cmd> --help` | print path (`renderHelp`) | uma tela estática por comando |
| `cam init` | Ink (`Splash` + `InitScreen`, `SetupScreen`) com fallback linear em CI | validação de máquina, wizard, tmux |
| `cam run` | print path + tmux | sessão orchestrator (3 panes: orquestrador + dashboard + menu) |
| `cam plan` | print path + tmux (pane launcher) | abre pane na sessão, retorna 0 imediatamente |
| `cam next` | print path + thin-proxy | liga `active:true` (dispara o sidecar), retorna 0 imediatamente |
| `cam issue` | print path + tmux (pane launcher) | abre pane na sessão, retorna 0 imediatamente |
| `cam dashboard` | Ink (alt-screen) | TUI read-only; pane 0.1 permanente na sessão |
| `cam status` | print path | idle / active / paused |
| `cam stop` | print path | cleanup |
| `cam resume` | print path + `promptSelect` (Ink) | summary + 5 modos auto + 3 modos reset |
| `cam claude` | print path + retry-monitor | print mode com retry de rate-limit |

---

## 1. Mapa de comandos (o ciclo de vida do projeto)

Como o operador navega entre comandos ao longo da vida de um projeto. As caixas
pontilhadas marcam o que roda DENTRO de uma sessão claude (os slash commands),
detalhado na seção 7.

```mermaid
flowchart TD
    START([repo do projeto]) --> INIT["cam init<br/>setup, uma vez"]

    INIT --> RUN["cam run<br/>sessao unica por projeto<br/>3 panes: orquestrador + dashboard + menu"]

    RUN -. "lançador de pane" .-> PLAN["cam plan<br/>abre pane: /cam-plan"]
    RUN -. "thin-proxy (dispara o sidecar)" .-> NEXT["cam next<br/>flip active:true, retorna 0"]
    RUN -. "lançador de pane" .-> ISSUE["cam issue 'texto'<br/>abre pane: /cam-issue create"]

    PLAN -. "volta pra sessao" .-> RUN
    NEXT -. "volta pra sessao" .-> RUN
    ISSUE -. "volta pra sessao" .-> RUN

    NEXT --> WATCH{"acompanhar<br/>ou intervir?"}
    WATCH -. "ver de relance" .-> STATUS["cam status"]
    WATCH -. "pane 0.1 sempre visivel" .-> DASH["cam dashboard"]
    WATCH -. "cancelar" .-> STOP["cam stop"]
    WATCH -. "voltou depois de cair" .-> RESUME["cam resume"]

    STATUS -. "volta pro loop" .-> NEXT
    STOP -. "recomeca limpo" .-> NEXT
    RESUME --> NEXT

    NEXT -->|"PRD completo + review CLEAN"| SHIP["/cam-ship<br/>push + PR"]
    SHIP --> PRUNE["/cam-prune<br/>volta pra main"]
    PRUNE -. "proximo issue" .-> PLAN

    RUN -. "orq. sai com handoff" .-> RESPAWN["respawn orquestrador<br/>(rehidrata, ate o cap)"]
    RUN -. "orq. sai sem handoff" .-> TEARDOWN["sessao destruida<br/>tmux kill-session"]
```

Resumo da espinha dorsal: `init` (uma vez) prepara a máquina e instala templates.
`run` abre a sessão única por projeto com 3 panes: pane 0.0 é o orquestrador, pane 0.1
é o `cam dashboard` permanente (sempre visível), pane 0.2 é o menu interativo. `plan`
e `issue` são lançadores de pane: abrem um pane novo na sessão e retornam 0
imediatamente; `next` também é thin-proxy (não abre pane), só liga `active:true` e
dispara o sidecar (o `runSupervisor` background spawnado pelo `cam run`), que corre o loop.
Quando o orquestrador (pane 0.0) sai, o wrapper respawna se houver um handoff de
cycle-close (por-ciclo) pendente, senão destrói a sessão. Quando o PRD fecha com review limpo, o
sidecar chega ao terminal, o PR vai via `/cam-ship` e `/cam-prune`
limpa a branch.

---

## 2. cam init (validacao de maquina + wizard)

Duas etapas. A etapa 1 valida a máquina; só se ela passar a etapa 2 (wizard) roda.
A renderização muda conforme o terminal: TTY interativo usa as telas Ink, CI ou pipe
cai no caminho linear (readline / prints).

```mermaid
flowchart TD
    A["cam init"] --> TTY1{"TTY interativo?"}
    TTY1 -->|sim| INK["Stage 1 Ink<br/>Splash + InitScreen"]
    TTY1 -->|"nao / CI"| LIN["Stage 1 linear<br/>prints"]

    INK --> CHECKS
    LIN --> CHECKS

    CHECKS["checa: claude no PATH + versao,<br/>smokes vendados, escreve config.toml,<br/>escreve retry.toml na 1a vez"]
    CHECKS --> PASS1{"validacao passou?"}
    PASS1 -->|nao| FAIL1["erro em stderr"]
    FAIL1 --> EXITN(["exit != 0, para aqui"])

    PASS1 -->|sim| VAGENT{"claude instalado<br/>+ logado?"}
    VAGENT -->|nao| FAILV["erro: claude not ready"]
    FAILV --> EXIT1(["exit 1"])

    VAGENT -->|sim| TTY2{"TTY interativo?"}
    TTY2 -->|sim| WIZ["SetupScreen (Ink wizard)"]
    TTY2 -->|"nao / CI"| RL["readline"]

    WIZ --> Q
    RL --> Q
    Q["perguntas:<br/>1. new / existing<br/>2. issue system: linear / github / none<br/>3. se new: descricao"]
    Q --> CANCEL{"cancelou?"}
    CANCEL -->|sim| EXIT1b(["exit 1, setup cancelado"])
    CANCEL -->|nao| WRITE["escreve project.toml,<br/>copia templates para<br/>.claude/commands, .claude/agents, scripts/cam"]

    WRITE --> NOTMUX{"--no-tmux?"}
    NOTMUX -->|sim| PRINTNEXT["imprime proximos passos"]
    PRINTNEXT --> EXIT0(["exit 0"])

    NOTMUX -->|nao| TMUX["abre tmux split"]
    TMUX --> PANES["pane config: claude adapta templates<br/>pane menu: c interage, v read-only, q fecha"]
    PANES --> POLL{"menu detecta<br/>CAM_SETUP_STATUS=DONE?"}
    POLL -->|"ainda nao"| PANES
    POLL -->|sim| HANDOFF["handoff automatico:<br/>menu spawna pane do orchestrator"]
    HANDOFF --> POST["menu vira: o orchestrator,<br/>c config, k mata config, q fecha"]
    POST --> EXIT0b(["exit 0"])
```

Decisões que mudam a tela: **TTY vs CI** (Ink vs linear), **falha na validação**
(stderr + para), **new vs existing** (pergunta extra de descrição só no new),
**issue system** (muda só o hint de credencial: LINEAR_API_KEY vs gh auth),
**`--no-tmux`** (instala e sai vs abre a sessão de config com handoff pro orchestrator).

---

## 2.5. cam run (sessao unica por projeto: 3-pane layout)

`cam run` é o ponto central: abre (ou re-anexa) a sessão única do projeto. O nome
da sessão é estável por projeto (`cam-orch-<basename>-<hash>`). Se a sessão já existe,
o comando anexa ou faz `switch-client` (dentro do tmux). Se não existe, cria com 3 panes.

Todos os comandos de sessão do cam usam o socket dedicado `tmux -L cam`, isolado
do socket padrão do tmux. Esse isolamento evita colisão com sessões acumuladas
(ex: `claude-retry-*` do claude-auto-retry) e protege contra um problema específico
do macOS: um servidor tmux deixado por uma sessão de segurança morta nega acesso TCC
a `~/Documents`, causando falha silenciosa do Claude Code. Com `tmux -L cam`, o cam
sempre parte de um servidor limpo com o contexto de segurança correto para o login atual.

Exceção intencional: `cam claude` e `cam retry-monitor` ficam no socket ambiente do
usuário, pois monitoram o pane interativo do usuário, nao a sessao do workspace do cam.

```mermaid
flowchart TD
    A["cam run [--no-attach]"] --> CHECK["verifica tmux e<br/>.claude/agents/subagent-orchestrator.md"]
    CHECK --> CHKOK{"ok?"}
    CHKOK -->|nao| ERR["erro: tmux ou orchestrator ausente<br/>(rode cam init)"] --> EXIT1(["exit 1"])

    CHKOK -->|sim| EXISTS{"sessao ja existe?"}
    EXISTS -->|sim| ATTACH["attach ou switch-client"]
    ATTACH --> EXIT0a(["exit 0"])

    EXISTS -->|nao| CREATE["new-session -d (3 panes):"]
    CREATE --> P0["pane 0.0: orchestrator<br/>(claude + subagent-orchestrator prompt;<br/>ao sair: respawn no handoff, senao kill-session)"]
    CREATE --> P1["pane 0.1: cam dashboard<br/>(permanente, read-only)"]
    CREATE --> P2["pane 0.2: menu interativo<br/>(n, p, i, s, r, d, q)"]

    P0 --> NOATTACH{"--no-attach?"}
    P1 --> NOATTACH
    P2 --> NOATTACH
    NOATTACH -->|sim| EXIT0b(["exit 0, sem anexar"])
    NOATTACH -->|nao| ATTACH2["attach ou switch-client"]
    ATTACH2 --> EXIT0c(["exit 0"])
```

Quando o `claude` do pane 0.0 sai, o wrapper do `cam run` respawna o orquestrador
(rehidratando de um handoff de cycle-close) se houver um pendente e dentro do cap
de respawns; senao encadeia `; tmux kill-session -t <sessao>` e os 3 panes somem. O
dashboard (pane 0.1) é sempre visivel enquanto a sessao existe.

---

## 3. cam plan (lancador de pane: abre /cam-plan na sessao)

`cam plan` é um lançador fino: garante que a sessão do projeto existe, abre um pane
novo nela com `claude --permission-mode <mode> "/cam-plan"`, e retorna 0 imediatamente.
O flow de planning (incluindo o prompt APPROVE) corre dentro do pane. Se o operador
rodar `cam plan` de fora da sessão, um hint imprime o comando `cam run` para se anexar.

```mermaid
flowchart TD
    A["cam plan [--issue N]"] --> SESSION["ensureProjectSession<br/>(cria sessao 3-panes se nao existe)"]
    SESSION --> OK{"tmux ok?"}
    OK -->|nao| ERR["erro: tmux unavailable (stderr)"]
    ERR --> EXIT1(["exit 1"])

    OK -->|sim| PANE["openPaneInSession<br/>split-window: claude /cam-plan (ou /cam-plan #N)"]
    PANE --> PANEOK{"pane abriu?"}
    PANEOK -->|nao| PANE_ERR["erro: failed to open pane"]
    PANE_ERR --> EXIT1b(["exit 1"])

    PANEOK -->|sim| INSIDE{"dentro da<br/>sessao?"}
    INSIDE -->|nao| HINT["emite hint:<br/>Run cam run to open the project session"]
    INSIDE -->|sim| EXIT0
    HINT --> EXIT0(["exit 0"])
```

Decisao chave: `cam plan` retorna 0 imediatamente. O orquestrador (pane 0.0) e o
dashboard (pane 0.1) continuam rodando enquanto o pane de planning executa em paralelo.
Sem `--issue`, o planner pick o issue de maior prioridade pendente por conta proprio.

---

## 4. cam next (thin-proxy que dispara o sidecar)

`cam next` NÃO roda o supervisor no próprio processo. Ele é um thin-proxy (mesmo modelo
de `cam plan`/`issue`/`review`/`ship`): liga o flag `active: true` no state file
`.claude/cam-loop.local.md` para disparar o SIDECAR, e opcionalmente injeta uma narração
em linguagem natural no pane do orquestrador via send-keys atômico (texto + Enter na MESMA
chamada, sem `-l`). Retorna imediatamente.

O **sidecar** é o supervisor determinístico (`runSupervisor`, `src/supervisor/loop.ts`)
rodando como processo background detached, spawnado pelo `cam run` (não pelo `cam next`).
Ele é gated no flag `active`: ocioso enquanto `active: false`; ao ver `active: true` com
histórias não-operator pendentes, adquire o lock de supervisor único e corre o loop
implement-review-complete, despachando cada worker (claude TUI interativo) no pane de
worker reusado (titulado, via `respawn-pane -k`). A conclusão é detectada lendo o
push-report-file `scripts/cam/worker-report.json` (não mais pollando o scrollback atrás do
sentinel). Ao chegar num estado terminal, escreve o report terminal e zera `active: false`.
As flags `--max-iter N` e `--completion-promise S` continuam aceitas (a promise é só
registrada no state file para display via `cam status`, não dirige a terminação).

```mermaid
flowchart TD
    A["cam next [--max-iter N]"] --> ORCH{"orquestrador vivo?"}
    ORCH -->|nao| BOOT["bootstrapa cam run --no-attach<br/>(spawna o sidecar)"]
    ORCH -->|sim| FLIP["flip active:true em cam-loop.local.md<br/>(+ send-keys narracao, opcional)"]
    BOOT --> FLIP
    FLIP --> E0(["exit 0 imediato"])

    SIDE["SIDECAR: runSupervisor (background detached, spawnado por cam run)"] --> GATE{"active:true?"}
    GATE -->|nao| IDLE["ocioso (poll)"] --> GATE
    GATE -->|sim| LOCK["adquire .cam-supervisor.lock"]
    LOCK --> SUP["loop decideNextAction implement/review/complete<br/>(worker no 3o pane; le worker-report.json)"]
    SUP --> TERM{"terminal"}
    TERM --> CLR["escreve report terminal + active:false"] --> GATE
```

Decisao chave: o loop corre no SIDECAR (processo background detached spawnado por `cam run`),
NÃO in-process no `cam next` nem absorvido pelo orquestrador LLM. O `cam next` só dispara
(flip `active:true`). O pane de worker (3o pane, titulado por `@cam_label`) é reusado a cada
história via `respawn-pane -k`. A sessão do projeto tem orquestrador (pane 0.0) + dashboard
(pane 0.1) permanentes; o worker é o 3o pane sob mutex. Nao ha deteccao de host: a sessao
unica por projeto e a fonte de verdade, independente do terminal do operador.

Guardrails por worker: cada despacho tem dois tetos. (1) Wall-clock: `perWorkerTimeoutMs`
(default 30min, env `CAM_WORKER_TIMEOUT_MS`); ao estourar, o pane é morto e a iteração
bloqueia. (2) Tokens (opt-in, CAM-5): `CAM_WORKER_MAX_TOKENS` (default 0 = desligado); o
loop de sentinel lê o gasto do worker no transcript a cada tick (spend = input +
cacheCreation + cacheRead, a mesma fórmula do `cam orch-budget`) e, ao cruzar o teto, mata
o pane e bloqueia terminalmente (evento `worker-token-ceiling`). O cap de turns é o
`maxIterations` do supervisor (`--max-iter`, default 50). Os flags `claude --max-turns` e
`--max-budget-usd` NÃO são usados: são print-mode-only (exigem `-p`, proibido em
subscrição, CAM-42), e budget em USD é N/A em subscrição (sem billing por chamada).

---

## 4.5. cam issue (lancador de pane: abre /cam-issue create na sessao)

`cam issue "<texto livre>"` é um lançador fino. O texto é passado verbatim ao slash
command `/cam-issue create`, que expande para título + descrição estruturada. Retorna
0 imediatamente; o pane agent cuida do rest.

```mermaid
flowchart TD
    A["cam issue 'texto livre'"] --> SESSION["ensureProjectSession<br/>(cria sessao 3-panes se nao existe)"]
    SESSION --> OK{"tmux ok?"}
    OK -->|nao| ERR["erro: tmux unavailable"] --> EXIT1(["exit 1"])

    OK -->|sim| PANE["openPaneInSession<br/>split-window: claude /cam-issue create 'texto'"]
    PANE --> PANEOK{"pane abriu?"}
    PANEOK -->|nao| PANE_ERR["erro: failed to open pane"] --> EXIT1b(["exit 1"])

    PANEOK -->|sim| INSIDE{"dentro da<br/>sessao?"}
    INSIDE -->|nao| HINT["emite hint:<br/>Run cam run to open the project session"]
    INSIDE -->|sim| EXIT0
    HINT --> EXIT0(["exit 0"])
```

O mesmo padrao de pane launcher de `cam plan`. A diferença: o comando injetado no
pane é `/cam-issue create <texto>`, nao um planner. (`cam next` nao e um lançador de
pane: e um thin-proxy que liga `active:true` para disparar o SIDECAR.)

---

## 5. cam resume (arvore de recuperacao)

`cam resume` reconcilia o estado depois de uma interrupção. Sem `--mode`, ele
classifica automaticamente lendo três fontes (state file, prd.json, último commit
+ PIDs vivos) e cai num de cinco modos. Com `--mode`, pula a classificação e faz
um reset explícito. A ordem de classificação importa e está no diagrama.

```mermaid
flowchart TD
    A["cam resume [--mode M] [--dry-run] [--force]"] --> MODE{"--mode passado?"}

    MODE -->|nao| CLASSIFY["classifica (ordem importa)"]
    CLASSIFY --> C1{"PRD completo?"}
    C1 -->|sim| SUCCESS["success:<br/>remove state file orfao"]
    SUCCESS --> E0a(["exit 0"])
    C1 -->|nao| C2{"tem state file?"}
    C2 -->|nao| IDLE["idle:<br/>Next: cam next"]
    IDLE --> E0b(["exit 0"])
    C2 -->|sim| C3{"retry-monitor vivo?"}
    C3 -->|sim| NOOP["noop:<br/>retry-monitor respawna sozinho"]
    NOOP --> E0c(["exit 0"])
    C3 -->|nao| C4{"PID do loop vivo?"}
    C4 -->|sim| RESPAWN1["respawn:<br/>Next: cam next re-attach"]
    C4 -->|nao| C5{"ultimo commit > 24h<br/>ou desconhecido?"}
    C5 -->|nao| RESPAWN2["respawn:<br/>terminal fechou / reboot recente"]
    RESPAWN1 --> E0d(["exit 0"])
    RESPAWN2 --> E0d
    C5 -->|sim| PROMPT["prompt [Y/n/reset]<br/>orfao de hard-kill"]

    PROMPT --> P{"resposta"}
    P -->|"Y"| PY["Next: cam next"] --> E0e(["exit 0"])
    P -->|"reset"| PR["remove state file"] --> E0f(["exit 0"])
    P -->|"n / default"| PN["abortado, nada feito"] --> E1(["exit 1"])

    MODE -->|"reset-current-story"| RCS{"prd.json existe?"}
    RCS -->|nao| RCSE(["exit 2"])
    RCS -->|sim| RCS2["flip a historia concluida<br/>mais recente para passes:false"]
    RCS2 --> RCS3{"tinha o que resetar?"}
    RCS3 -->|nao| RCSE2(["exit 2"])
    RCS3 -->|sim| RCSOK["Next: cam next re-implementa"] --> E0g(["exit 0"])

    MODE -->|"reset-prd"| RP{"prd.json existe?"}
    RP -->|nao| RPE(["exit 2"])
    RP -->|sim| RP2["flip TODAS as historias para passes:false"]
    RP2 --> RPOK["Next: cam next do topo"] --> E0h(["exit 0"])

    MODE -->|"reset-branch"| RB{"--force?"}
    RB -->|nao| RBC["confirma [y/N]<br/>(descarta commits locais)"]
    RBC --> RBCA{"confirmou?"}
    RBCA -->|nao| RBN["abortado"] --> E1b(["exit 1"])
    RBCA -->|sim| RBDO
    RB -->|sim| RBDO["NAO roda git reset (operador roda):<br/>imprime git reset --hard origin/main,<br/>remove state file"]
    RBDO --> RBOK["Next: cam next depois do reset"] --> E0i(["exit 0"])
```

Notas: `--dry-run` curto-circuita qualquer mutação ou spawn em todos os ramos
(classifica e imprime, exit 0). `reset-branch` nunca roda `git reset` sozinho:
ele imprime o comando pro operador copiar, justamente pra não destruir trabalho
por classificação errada.

---

## 6. cam status (estados do loop)

Leitura read-only de três fontes (state file, prd.json, git). Sempre sai 0. A tela
muda conforme o estado e oferece uma seção "Next" com o que fazer em seguida.

```mermaid
flowchart TD
    A["cam status"] --> READ["le state file + prd.json + git"]
    READ --> S{"tem state file?"}
    S -->|nao| IDLE["estado: idle<br/>(circulo muted)"]
    IDLE --> IDLEN["mostra proxima historia pendente,<br/>branch, ultimo commit"]
    IDLEN --> IDLENEXT["Next: cam next, cam plan"]

    S -->|sim| ACT{"active:false<br/>no state file?"}
    ACT -->|nao| ACTIVE["estado: active<br/>(circulo accent)"]
    ACTIVE --> ACTINFO["story, iter N/M, since,<br/>branch, last, promise"]

    ACT -->|sim| PAUSED["estado: paused<br/>(! warning)"]
    PAUSED --> PINFO["mesma info + aviso de pausa"]
    PINFO --> PNEXT["Next: cam stop, cam next"]
```

---

## 7. O loop autonomo (slash commands dentro do claude)

Isto é o ciclo de vida que o SIDECAR dirige (processo background detached, spawnado pelo
`cam run`). O sidecar (`runSupervisor`, `src/supervisor/loop.ts`) fica gateado no flag
`active` do state file; quando `cam next` liga `active:true`, o sidecar adquire o lock e
chama `decideNextAction`, que lê `prd.json` + o veredito de review para decidir implement /
review / complete, despacha um worker por história, e repete até o estado terminal. Nao ha
stop hook nem `<promise>COMPLETE</promise>` dirigindo a terminacao: o loop termina quando
todas as historias non-operator passam E o review e terminal (CLEAN ou MAX_ROUNDS_DEBT).
O orchestrator LLM (pane 0.0) NARRA o report terminal do sidecar e roteia os
slash-commands de cerimonia (/cam-plan, /cam-review, /cam-ship, /cam-issue, /cam-prune)
como interface humana -- ele NAO dirige o loop de implement/review.

```mermaid
flowchart TD
    ISSUE["/cam-issue<br/>cria/acha issue no sistema (linear/github/none)"] -->|"CAM_ISSUE_RESULT=id"| PLANC["/cam-plan id<br/>preflight, subagent-planner gera prd.json"]
    PLANC --> AUDIT["subagent-auditor"]
    AUDIT --> VERD{"verdict"}
    VERD -->|"BLOCK"| FIX["aplica suggestions,<br/>re-audita (ate 3x)"]
    FIX --> AUDIT
    VERD -->|"APPROVE"| BRANCH["cria branch + commit + push"]

    BRANCH --> NEXTC["cam next: supervisor (1 iteracao)"]
    NEXTC --> PRE["preflight: sync remote,<br/>working tree, typecheck, tests"]
    PRE --> DEC{"decideNextAction<br/>(le prd.json + review)"}

    DEC -->|"alguma historia passes:false"| IMPL["subagent-implementer<br/>(uma historia, contexto fresco)"]
    IMPL --> ST{"CAM_IMPLEMENTER_STATUS"}
    ST -->|"DONE"| DONE["mostra progresso, para o turno"]
    ST -->|"PRD_COMPLETE"| REEVAL["re-avalia a matriz"]
    ST -->|"BLOCKED_QUALITY"| BQ["surface, NAO re-roda"]
    ST -->|"BLOCKED_AMBIGUITY"| BA["surface pergunta, para"]
    ST -->|"RATE_LIMIT"| RL["espera reset, retry"]

    DEC -->|"tudo passes:true + nao revisado<br/>ou FIXES_PENDING com fixes prontos"| REVIEWC["/cam-review"]
    DEC -->|"tudo passes:true + CLEAN<br/>ou MAX_ROUNDS_DEBT ou teto"| COMPLETE["estado terminal<br/>supervisor sai"]

    REVIEWC --> REVAGENT["subagent-reviewer<br/>(contexto separado, so o diff)"]
    REVAGENT --> RV{"review tag"}
    RV -->|"CLEAN"| RCLEAN["pronto pro /cam-ship"]
    RV -->|"N findings"| RFIX["cria historias US-RX-NNN (passes:false),<br/>atualiza prd.review, rounds limitados (3)"]
    RFIX -. "proxima iteracao do supervisor" .-> NEXTC
    DONE -. "supervisor despacha o proximo worker" .-> NEXTC
    REEVAL -. "re-entra" .-> DEC

    COMPLETE --> SHIPC["/cam-ship<br/>verifica PRD completo, quality gates, push, PR"]
    SHIPC --> SHIPCHK{"toda historia<br/>non-operator passes:true?"}
    SHIPCHK -->|nao| SHIPSTOP["STOP: rode /cam-next primeiro"]
    SHIPCHK -->|sim| PR["abre PR"]
    PR --> PRUNEC["/cam-prune<br/>volta pra main, deleta branch"]
```

Como o loop "anda" sozinho: o SIDECAR (`runSupervisor`, processo background detached
spawnado pelo `cam run`) itera internamente. A cada volta chama `decideNextAction(prd)`,
despacha o worker certo (implementer ou reviewer, sessao claude TUI no pane reusado),
aguarda o push-report-file (`scripts/cam/worker-report.json`) que o worker escreve ao
terminar, le o desfecho e repete, ate o estado terminal ou o teto `max_iterations`.
O desfecho e state-primary (CAM-32): `handoff.json` (qual historia) + `prd.json`
`passes:true` (feito) sao autoritativos; o sentinel `CAM_*_STATUS` no scrollback e
so corroboracao/fallback, nunca gate primario -- o gate primario e o report-file.
A alternativa de eventos estruturados via `-p --output-format stream-json
--include-hook-events` e deliberadamente NAO usada, porque `claude -p` e proibido em
contas de subscricao (CAM-42): o sinal estruturado vive nos arquivos de estado em disco
(`handoff.json` / `prd.json`), nao num stream de eventos.

---

## 8. State machine do loop (e como stop / resume / status se ligam a ele)

Tudo gira em torno de um arquivo: `.claude/cam-loop.local.md`. Sua presença e o campo
`active` definem o estado que `cam status` reporta, e o trio PID + último commit +
retry-monitor define o que `cam resume` decide.

```mermaid
stateDiagram-v2
    [*] --> Idle: sem state file
    Idle --> Active: cam next (arma o state file)
    Active --> Active: sidecar despacha o proximo worker (loop background detached)
    Active --> Paused: terminal nao-sucesso (blocked / awaiting-operator / max_iterations -> active:false)
    Active --> Complete: supervisor terminal complete (todas non-operator passam + review terminal)

    Active --> Orphan: terminal fecha / reboot / hard-kill (PID morre)

    Paused --> Idle: cam stop (remove state file)
    Paused --> Active: cam next (reinicia)
    Complete --> Idle: cam next remove o state file no terminal

    Orphan --> Active: cam resume -> respawn / Y
    Orphan --> Idle: cam resume -> reset
    Orphan --> Orphan: cam resume -> n (aborta, deixa como esta)

    Idle --> Idle: cam stop (idempotente, nada a limpar)
```

Quem mexe em quê:

- **`cam next`** liga `active:true` no state file (Idle para Active), injetando a narração
  no pane do orquestrador via send-keys atômico. O SIDECAR (já rodando em background desde
  o `cam run`) detecta `active:true`, adquire o lock, itera despachando workers, e chega a
  Complete removendo o file no estado terminal.
- **`cam status`** só lê: presença do file e `active` decidem idle / active / paused.
- **`cam stop`** remove o state file e mata a sessão tmux `cam` (Active/Paused para Idle); idempotente.
- **`cam resume`** age sobre o Orphan (PID morto + file presente), escolhendo respawn,
  reset, ou abortar conforme idade do último commit e resposta do operador.
- **`cam claude` / retry-monitor** registra seu PID em `~/.cam/retry.pid`; é isso que
  faz `cam resume` cair em `noop` (o monitor respawna o loop quando a janela de
  rate-limit fecha).

---

## 9. supervisor/dispatch (CAM-55: tres decisoes arquiteturais)

CAM-55 fixa tres perguntas abertas de design sobre como os subcomandos CLI e o supervisor
interagem com o orquestrador (a Q1 foi re-decidida no fix-cycle para o modelo sidecar). As respostas abaixo estao decididas e congeladas; as historias
seguintes codificam a implementacao sem precisar re-decidir.

**Q1: onde o loop determinístico roda (modelo SIDECAR).**
O loop determinístico (`runSupervisor`, `src/supervisor/loop.ts`) roda como um SIDECAR: um
processo background detached spawnado pelo `cam run`, gated no flag `active` do state file
`.claude/cam-loop.local.md`. `cam next` (e os outros thin-proxies) só liga `active:true`
para disparar; o sidecar adquire o lock de supervisor único e corre o loop. A
completion-detection muda de polling de scrollback (`capture-pane` atrás do sentinel
`CAM_*_STATUS`) para um push-report-file (`scripts/cam/worker-report.json`): o worker
escreve o resultado estruturado ao terminar, o sidecar lê esse arquivo. Isso elimina a
classe de fragilidade documentada em `supervisor-sentinel-parse-fragility.md` (falsos
positivos de sentinel no scrollback, sentinel em markdown, pane morto).

REJEITADO: o modelo "o orquestrador LLM absorve o loop" (o orquestrador recebe o report e
ele mesmo decide/dispara a próxima história, sem supervisor determinístico). Esse modelo
perde os guards determinísticos que vivem no `runSupervisor`: streak de no-progress
(CAM-36), backoff de worker morto (CAM-44), `MAX_ITERATIONS`, o lock de supervisor único, e
o event log. Um loop dirigido por LLM é não-determinístico e não tem como garantir esses
limites. O sidecar mantém o loop determinístico; o orquestrador LLM só narra o report
terminal e roteia os outros slash-commands (plan/review/ship/issue) como interface humana.

**Q2: thin-proxies e o marker `.claude/.cam-orch-ready`.**
Os subcomandos CLI (`cam plan`, `cam issue`) sao thin-proxies. Fluxo:
(a) detecta a sessao do orquestrador via `tmux -L cam ls`;
(b) se ausente, bootstrapa `cam run --no-attach`;
(c) aguarda o marker `.claude/.cam-orch-ready` no disco (arquivo criado pelo orquestrador
    ao terminar a inicializacao do TUI e estar pronto para receber comandos);
(d) injeta o pedido via `send-keys` atomico no pane 0.0 (texto + Enter na mesma chamada).
Sem o marker, o proxy nao tem garantia de que o TUI do orquestrador esta pronto e pode
injetar antes que o Ink inicialize, perdendo o comando silenciosamente.

**Q3: idle-guarantee e historia separada.**
A garantia de que o orquestrador esta idle (nao no meio de uma tarefa) antes de o worker
fazer o push-report nao e incluida no proxy. E a historia US-008, implementada
em separado. A separacao evita acoplamento prematuro: Q2 (bootstrap + wait-marker) e Q3
(idle-check antes do push) sao camadas com razoes de mudanca diferentes e podem ser
testadas e revertidas de forma independente.
