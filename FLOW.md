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
| `cam next` | print path + tmux (pane launcher) | abre pane na sessão, retorna 0 imediatamente |
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
    RUN -. "lançador de pane" .-> NEXT["cam next<br/>abre pane: /cam-next"]
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

    RUN -. "orquestrador sai" .-> TEARDOWN["sessao destruida<br/>tmux kill-session"]
```

Resumo da espinha dorsal: `init` (uma vez) prepara a máquina e instala templates.
`run` abre a sessão única por projeto com 3 panes: pane 0.0 é o orquestrador, pane 0.1
é o `cam dashboard` permanente (sempre visível), pane 0.2 é o menu interativo. `plan`,
`next` e `issue` são lançadores de pane: abrem um pane novo na sessão e retornam 0
imediatamente. Quando o orquestrador (pane 0.0) sai, a sessão inteira é destruída
automaticamente. Quando o PRD fecha com review limpo, o loop emite `COMPLETE`, abre o
PR via `/cam-ship` e `/cam-prune` limpa a branch.

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
    CREATE --> P0["pane 0.0: orchestrator<br/>(claude /cam-next; ao sair: kill-session)"]
    CREATE --> P1["pane 0.1: cam dashboard<br/>(permanente, read-only)"]
    CREATE --> P2["pane 0.2: menu interativo<br/>(n, p, i, s, r, d, q)"]

    P0 --> NOATTACH{"--no-attach?"}
    P1 --> NOATTACH
    P2 --> NOATTACH
    NOATTACH -->|sim| EXIT0b(["exit 0, sem anexar"])
    NOATTACH -->|nao| ATTACH2["attach ou switch-client"]
    ATTACH2 --> EXIT0c(["exit 0"])
```

O pane 0.0 encadeia `; tmux kill-session -t <sessao>` após o `claude` sair, portanto
quando o orquestrador termina (por qualquer motivo), os 3 panes somem. O dashboard
(pane 0.1) é sempre visivel enquanto a sessao existe.

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

## 4. cam next (supervisor in-process)

`cam next` roda o supervisor determinístico (`runSupervisor`, `src/supervisor/loop.ts`)
no próprio processo. Ele lê o pane de worker alocado por `cam plan`, arma o state file,
adquire o lock de supervisor único e entra no loop implement-review-complete. NÃO há
stop hook, NÃO registra nada em `settings.local.json`, e NÃO abre um pane `/cam-next`:
o supervisor despacha cada worker (claude TUI interativo) no pane de worker reusado via
`respawn-pane` e detecta conclusão pollando `capture-pane` atrás do sentinel. Retorna ao
chegar num estado terminal. As flags `--max-iter N` e `--completion-promise S` continuam
aceitas (a promise é só registrada no state file para display via `cam status`, não
dirige a terminação).

```mermaid
flowchart TD
    A["cam next [--max-iter N] [--completion-promise S]"] --> WP["le worker pane (.claude/.cam-worker-pane)"]
    WP --> WPOK{"alocado?"}
    WPOK -->|nao| F1["erro: rode cam plan primeiro"] --> E1(["exit 1"])
    WPOK -->|sim| H3["arma state file cam-loop.local.md"]
    H3 --> H3OK{"ok? (recusa sobrescrever<br/>state file existente)"}
    H3OK -->|nao| F3["erro: state file ja existe,<br/>rode cam stop"] --> E3(["exit 1"])
    H3OK -->|sim| LOCK["adquire .cam-supervisor.lock<br/>(supervisor unico por projeto)"]
    LOCK --> LOCKOK{"livre?"}
    LOCKOK -->|nao| F4["erro: outro supervisor ativo"] --> E4(["exit 1"])
    LOCKOK -->|sim| SUP["runSupervisor: loop decideNextAction<br/>implement / review / complete"]
    SUP --> TERM{"estado terminal"}
    TERM -->|"complete / awaiting-operator"| E0(["exit 0"])
    TERM -->|"blocked / max-iterations"| E5(["exit 1"])
```

Decisao chave: o loop corre IN-PROCESS no `cam next`, não num pane separado nem via
re-injeção de slash command. O pane de worker (alocado por `cam plan`) é reusado a cada
história via `respawn-pane`. A sessão do projeto já tem pane 0.1 (`cam dashboard`)
permanente e pane 0.2 (menu). Nao ha deteccao de host: a sessao unica por projeto e a
fonte de verdade, independente do terminal do operador.

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

O mesmo padrao de pane launcher de `cam plan` e `cam next`. A diferença: o comando
injetado no pane é `/cam-issue create <texto>`, nao um loop ou planner.

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

Isto é o ciclo de vida que o supervisor de `cam next` dirige (e que o orchestrator de
`cam run` dispara sob demanda). O supervisor determinístico (`runSupervisor`) chama
`decideNextAction`, que lê `prd.json` + o veredito de review para decidir implement /
review / complete, despacha um worker por história, e repete in-process até o estado
terminal. Não há stop hook nem `<promise>COMPLETE</promise>` dirigindo a terminação: o
loop termina quando todas as histórias non-operator passam E o review é terminal (CLEAN
ou MAX_ROUNDS_DEBT). Os passos `/cam-issue`, `/cam-plan`, `/cam-review`, `/cam-ship`,
`/cam-prune` abaixo são as cerimônias slash que o operador (ou o orchestrator) roda em
volta do loop de implement/review que o supervisor automatiza.

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

Como o loop "anda" sozinho: o supervisor (`runSupervisor`, in-process no `cam next`)
itera internamente. A cada volta chama `decideNextAction(prd)`, despacha o worker certo
(implementer ou reviewer, sessão claude TUI no pane reusado), espera o sentinel via
`capture-pane`, lê o desfecho e repete, até o estado terminal ou o teto `max_iterations`.
O desfecho é state-primary (CAM-32): `handoff.json` (qual história) + `prd.json`
`passes:true` (feito) são autoritativos; o sentinel `CAM_*_STATUS` / `<review>` no pane é
só corroboração, nunca gate. A alternativa de eventos estruturados via
`-p --output-format stream-json --include-hook-events` é deliberadamente NÃO usada, porque
`claude -p` é proibido em contas de subscrição (CAM-42): o sinal estruturado vive nos
arquivos de estado em disco (`handoff.json` / `prd.json`), não num stream de eventos.

---

## 8. State machine do loop (e como stop / resume / status se ligam a ele)

Tudo gira em torno de um arquivo: `.claude/cam-loop.local.md`. Sua presença e o campo
`active` definem o estado que `cam status` reporta, e o trio PID + último commit +
retry-monitor define o que `cam resume` decide.

```mermaid
stateDiagram-v2
    [*] --> Idle: sem state file
    Idle --> Active: cam next (arma o state file)
    Active --> Active: supervisor despacha o proximo worker (loop in-process)
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

- **`cam next`** cria o state file (Idle para Active), grava o PID do processo dono, e
  roda o supervisor in-process: mantém Active vivo (itera, despachando workers) ou chega a
  Complete e remove o file no estado terminal.
- **`cam status`** só lê: presença do file e `active` decidem idle / active / paused.
- **`cam stop`** remove o state file e mata a sessão tmux `cam` (Active/Paused para Idle); idempotente.
- **`cam resume`** age sobre o Orphan (PID morto + file presente), escolhendo respawn,
  reset, ou abortar conforme idade do último commit e resposta do operador.
- **`cam claude` / retry-monitor** registra seu PID em `~/.cam/retry.pid`; é isso que
  faz `cam resume` cair em `noop` (o monitor respawna o loop quando a janela de
  rate-limit fecha).
