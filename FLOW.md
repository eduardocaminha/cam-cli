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
| `cam run` | print path + tmux | sessão orchestrator (2 panes) |
| `cam plan` | print path + PTY claude + `promptSelect` (Ink) | sessão de planning, prompt APPROVE |
| `cam next` | print path + spawn | Loop + Host, depois claude assume o terminal |
| `cam dashboard` | Ink (alt-screen) | TUI read-only |
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

    INIT --> RUN["cam run<br/>orchestrator, sessao longa"]
    INIT -. "ou pula o orchestrator" .-> PLAN

    RUN -. "operador pede 'plano para X'" .-> PLAN["cam plan<br/>gera PRD + branch"]
    PLAN --> NEXT["cam next<br/>loop autonomo"]
    RUN -. "operador pede 'implementa'" .-> NEXT

    NEXT --> WATCH{"acompanhar<br/>ou intervir?"}
    WATCH -. "ver de relance" .-> STATUS["cam status"]
    WATCH -. "monitor ao vivo" .-> DASH["cam dashboard"]
    WATCH -. "cancelar" .-> STOP["cam stop"]
    WATCH -. "voltou depois de cair" .-> RESUME["cam resume"]

    STATUS -. "volta pro loop" .-> NEXT
    DASH -. "volta pro loop" .-> NEXT
    STOP -. "recomeca limpo" .-> NEXT
    RESUME --> NEXT

    NEXT -->|"PRD completo + review CLEAN"| SHIP["/cam-ship<br/>push + PR"]
    SHIP --> PRUNE["/cam-prune<br/>volta pra main"]
    PRUNE -. "proximo issue" .-> PLAN
```

Resumo da espinha dorsal: `init` (uma vez) prepara a máquina e instala templates.
`run` abre o orchestrator, que é a interface humana de longa duração. Dentro (ou fora)
dele, `plan` cria o PRD e a branch, `next` roda o loop autônomo que implementa o PRD
história por história. Enquanto o loop roda, `status`, `dashboard`, `stop` e `resume`
são as telas de observação e controle. Quando o PRD fecha com review limpo, o loop
emite `COMPLETE`, abre o PR via `/cam-ship` e `/cam-prune` limpa a branch.

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

## 3. cam plan (sessao de planning com gate de aprovacao)

`cam plan` é um wrapper fino: spawna `claude` num PTY com `/cam-plan` (ou `/cam-plan #N`)
como primeiro turno, repassa tudo pro seu terminal, e fica escaneando o output atrás
da linha de veredito do auditor. Quando acha `APPROVE`, pausa e te pergunta se pode
deixar o planner criar a branch.

```mermaid
flowchart TD
    A["cam plan [--issue N]"] --> SPAWN["spawn claude (PTY)<br/>dispatch /cam-plan ou /cam-plan #N"]
    SPAWN --> OK{"spawn deu certo?"}
    OK -->|nao| ERR["erro: failed to spawn claude (stderr)"]
    ERR --> EXIT1(["exit 1"])

    OK -->|sim| LIVE["sessao interativa:<br/>teclas vao direto pro claude,<br/>cam escaneia o output"]
    LIVE --> SCAN{"achou linha<br/>verdict APPROVE?"}
    SCAN -->|"nao (sessao segue)"| LIVE
    SCAN -->|"claude saiu antes"| PROP(["propaga exit code do claude"])

    SCAN -->|sim| PROMPT["promptSelect (Ink):<br/>Approve PRD and create branch?"]
    PROMPT --> CHOICE{"escolha"}
    CHOICE -->|"Yes"| CONT["ack: planner continua<br/>branch + commit"]
    CONT --> WAIT["cam espera o claude terminar"]
    WAIT --> PROP2(["exit code do claude"])
    CHOICE -->|"No / default"| KILL["mata a sessao (SIGTERM)"]
    KILL --> EXIT0(["exit 0, cancelado limpo"])
```

Decisão chave: o **prompt APPROVE** (Yes deixa o planner criar branch e commitar;
No mata a sessão de planning e sai 0). Se o claude sair antes de qualquer veredito,
o exit code dele é propagado como está.

---

## 4. cam next (arma o loop + detecta o host)

Antes de spawnar o claude, `cam next` arma o terreno: materializa o stop hook,
registra ele em `.claude/settings.local.json`, e escreve o state file
`.claude/cam-loop.local.md`. Qualquer falha nesses três passos é fatal. Depois,
detecta o host pra decidir se abre um split com dashboard ou roda inline.

```mermaid
flowchart TD
    A["cam next [--max-iter N] [--completion-promise S]"] --> H1["materializa stop hook"]
    H1 --> H1OK{ok?}
    H1OK -->|nao| F1["erro stderr"] --> E1(["exit 1"])
    H1OK -->|sim| H2["registra Stop hook em settings.local.json"]
    H2 --> H2OK{ok?}
    H2OK -->|nao| F2["erro stderr"] --> E2(["exit 1"])
    H2OK -->|sim| H3["escreve state file cam-loop.local.md"]
    H3 --> H3OK{"ok? (recusa sobrescrever<br/>state file existente)"}
    H3OK -->|nao| F3["erro: state file ja existe,<br/>rode /cancel-cam ou rm"] --> E3(["exit 1"])

    H3OK -->|sim| HOST{"detecta host"}
    HOST -->|"TERM_PROGRAM=vscode"| INLINE
    HOST -->|"tmux no PATH"| SPLIT
    HOST -->|"nada disso"| INLINE

    SPLIT["tmux-split"] --> INTMUX{"ja esta<br/>dentro do tmux?"}
    INTMUX -->|sim| S1["split-window -h:<br/>claude no pane atual,<br/>cam dashboard no novo pane"]
    INTMUX -->|nao| S2["new-session -d -s cam:<br/>dashboard na sessao cam,<br/>claude inline no terminal atual"]
    S1 --> SPAWNC
    S2 --> SPAWNC
    INLINE["inline (sem split):<br/>o terminal atual e o dashboard"] --> SPAWNC

    SPAWNC["spawn claude com /cam-next<br/>(foreground)"] --> SPOK{ok?}
    SPOK -->|nao| FC["erro: failed to spawn claude"] --> EC(["exit 1"])
    SPOK -->|sim| LOOP["claude assume o terminal:<br/>entra no loop autonomo (secao 7)"]
    LOOP --> RET(["retorna o exit code do claude"])
```

Decisão chave: **host detection**. VS Code e ausência de tmux caem em inline
(pane único, o próprio terminal é o dashboard). Com tmux, abre o split com
`cam dashboard` ao lado; dentro do tmux usa o window atual, fora cria a sessão `cam`.

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

Isto é o que roda DENTRO da sessão claude que `cam next` spawna (e que o orchestrator
de `cam run` dispara sob demanda). O stop hook re-injeta `/cam-next` a cada turno,
formando o loop, até o assistente emitir `<promise>COMPLETE</promise>` ou bater o
teto de iterações.

```mermaid
flowchart TD
    ISSUE["/cam-issue<br/>cria/acha issue no sistema (linear/github/none)"] -->|"CAM_ISSUE_RESULT=id"| PLANC["/cam-plan id<br/>preflight, subagent-planner gera prd.json"]
    PLANC --> AUDIT["subagent-auditor"]
    AUDIT --> VERD{"verdict"}
    VERD -->|"BLOCK"| FIX["aplica suggestions,<br/>re-audita (ate 3x)"]
    FIX --> AUDIT
    VERD -->|"APPROVE"| BRANCH["cria branch + commit + push"]

    BRANCH --> NEXTC["/cam-next (1 iteracao)"]
    NEXTC --> PRE["preflight: sync remote,<br/>working tree, typecheck, tests"]
    PRE --> DEC{"branch decision<br/>(le prd.json)"}

    DEC -->|"alguma historia passes:false"| IMPL["subagent-implementer<br/>(uma historia, contexto fresco)"]
    IMPL --> ST{"CAM_IMPLEMENTER_STATUS"}
    ST -->|"DONE"| DONE["mostra progresso, para o turno"]
    ST -->|"PRD_COMPLETE"| REEVAL["re-avalia a matriz"]
    ST -->|"BLOCKED_QUALITY"| BQ["surface, NAO re-roda"]
    ST -->|"BLOCKED_AMBIGUITY"| BA["surface pergunta, para"]
    ST -->|"RATE_LIMIT"| RL["espera reset, retry"]

    DEC -->|"tudo passes:true + nao revisado<br/>ou FIXES_PENDING com fixes prontos"| REVIEWC["/cam-review"]
    DEC -->|"tudo passes:true + CLEAN<br/>ou MAX_ROUNDS_DEBT ou teto"| COMPLETE["emite COMPLETE<br/>loop termina"]

    REVIEWC --> REVAGENT["subagent-reviewer<br/>(contexto separado, so o diff)"]
    REVAGENT --> RV{"review tag"}
    RV -->|"CLEAN"| RCLEAN["pronto pro /cam-ship"]
    RV -->|"N findings"| RFIX["cria historias US-RX-NNN (passes:false),<br/>atualiza prd.review, rounds limitados (3)"]
    RFIX -. "proxima iteracao re-entra no /cam-next" .-> NEXTC
    DONE -. "stop hook re-injeta /cam-next" .-> NEXTC
    REEVAL -. "re-entra" .-> DEC

    COMPLETE --> SHIPC["/cam-ship<br/>verifica PRD completo, quality gates, push, PR"]
    SHIPC --> SHIPCHK{"toda historia<br/>non-operator passes:true?"}
    SHIPCHK -->|nao| SHIPSTOP["STOP: rode /cam-next primeiro"]
    SHIPCHK -->|sim| PR["abre PR"]
    PR --> PRUNEC["/cam-prune<br/>volta pra main, deleta branch"]
```

Como o loop "anda" sozinho: o stop hook (`vendor/cam-loop-stop-hook.sh`, registrado
em `settings.local.json` por `cam next`) dispara no evento Stop de cada turno. Ele lê
o state file: se ainda não viu `<promise>COMPLETE</promise>` e não bateu o teto, re-injeta
`/cam-next`, e o loop re-entra na matriz de decisão. Quando vê COMPLETE ou estoura
`max_iterations`, remove o state file e o loop para.

---

## 8. State machine do loop (e como stop / resume / status se ligam a ele)

Tudo gira em torno de um arquivo: `.claude/cam-loop.local.md`. Sua presença e o campo
`active` definem o estado que `cam status` reporta, e o trio PID + último commit +
retry-monitor define o que `cam resume` decide.

```mermaid
stateDiagram-v2
    [*] --> Idle: sem state file
    Idle --> Active: cam next (arma o state file)
    Active --> Active: stop hook re-injeta /cam-next
    Active --> Paused: plugin seta active:false (completou/cancelou)
    Active --> Complete: emite COMPLETE ou bate max_iterations

    Active --> Orphan: terminal fecha / reboot / hard-kill (PID morre)

    Paused --> Idle: cam stop (remove state file)
    Paused --> Active: cam next (reinicia)
    Complete --> Idle: stop hook remove o state file

    Orphan --> Active: cam resume -> respawn / Y
    Orphan --> Idle: cam resume -> reset
    Orphan --> Orphan: cam resume -> n (aborta, deixa como esta)

    Idle --> Idle: cam stop (idempotente, nada a limpar)
```

Quem mexe em quê:

- **`cam next`** cria o state file (Idle para Active) e grava o PID do processo dono.
- **stop hook** mantém Active vivo (re-injeta) ou leva a Complete e remove o file.
- **`cam status`** só lê: presença do file e `active` decidem idle / active / paused.
- **`cam stop`** remove o state file e mata a sessão tmux `cam` (Active/Paused para Idle); idempotente.
- **`cam resume`** age sobre o Orphan (PID morto + file presente), escolhendo respawn,
  reset, ou abortar conforme idade do último commit e resposta do operador.
- **`cam claude` / retry-monitor** registra seu PID em `~/.cam/retry.pid`; é isso que
  faz `cam resume` cair em `noop` (o monitor respawna o loop quando a janela de
  rate-limit fecha).
