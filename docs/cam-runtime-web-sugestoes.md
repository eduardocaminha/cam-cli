> **Procedencia.** Documento de estrategia escrito em 2026-07-13, importado para o repo em 2026-08-10 a pedido do operador. Ate esta data vivia apenas em `~/Downloads`, fora do controle de versao, e e a origem das 7 fases do CAM-408. Conteudo abaixo preservado verbatim: partes podem estar superadas por decisoes posteriores (notadamente a stack web, decidida em 2026-08-10 como vite mais tailwind mais shadcn mais sqlite, e o rename do produto para gateship). Trate como registro historico da direcao, nao como especificacao corrente.

# CAM Runtime — Estratégia de Evolução para Web, Observabilidade e Execução por Subscrição

## 1. Resumo executivo

O CAM não deve ser tratado apenas como um CLI nem como um agente de coding.

A classificação mais precisa é:

> **CAM é um runtime local, domain-specific, exposto por CLI, para operar agentes de coding por subscrição.**

Seu domínio é o ciclo de engenharia de software orientado a issues:

```text
issue → plan → implement → review → ship
```

O Claude Code é o executor. O CAM é a camada que impõe:

- processo;
- estado;
- continuidade;
- observabilidade;
- gates;
- supervisão;
- retry;
- accounting;
- integração com backlog;
- governança operacional.

A direção recomendada é:

> **transformar o CAM em um control plane local-first, com Web UI diária, CLI como fallback e automação, daemon como runtime e Claude Code/Codex CLI como executores por subscrição.**

---

# 2. O que o CAM é

## 2.1 Taxonomia

| Categoria | O CAM é? | Observação |
|---|---:|---|
| CLI | Sim | É a superfície atual de controle |
| Runtime | Sim | Mantém sessão, estado, sidecar, workers, retry e lifecycle |
| Domain-specific runtime | Sim | O domínio é engenharia de software orientada a issues |
| Domain-specific agent | Parcialmente | O agente real ainda é Claude Code |
| Agent framework geral | Não | Não é LangGraph, CrewAI ou OpenHands |
| Personal assistant | Não | Não deve competir com Hermes ou OpenClaw |
| Control plane | Deve se tornar | Essa é a evolução mais defensável |

## 2.2 Framing recomendado

### Framing atual

```text
CAM = CLI que dirige Claude Code via tmux
```

### Framing recomendado

```text
CAM = control plane local para coding agents por subscrição
      com workflow stateful de engenharia
      e gates verificáveis
```

Ou:

> **CAM transforma Claude Code subscription em uma esteira autônoma de desenvolvimento.**

Uma frase de posicionamento possível:

> **CAM é o runtime que impede coding agents de trabalharem sem processo.**

---

# 3. Diferenciação estratégica

O CAM não deveria tentar virar:

- um novo Claude Code;
- um novo Codex;
- um personal assistant;
- um gateway de mensageria;
- um framework multiagente genérico;
- um clone de OpenHands;
- uma infraestrutura cloud-first dependente de API.

Seu espaço mais defensável é:

```text
subscription coding agents
        ↓
CAM runtime
        ↓
issue → plan → implement → review → ship
        ↓
GitHub / Linear / backlog local
```

## 3.1 Vantagens atuais do CAM

- ciclo explícito de engenharia;
- sidecar loop;
- worker report estruturado;
- dashboard;
- retry de rate limit;
- integração com GitHub, Linear e issues locais;
- execução longa usando Claude Code autenticado;
- controle de sessões;
- separação entre orchestrator e worker;
- gates de review e ship;
- menor custo marginal por usar subscrição.

---

# 4. Relação com outras ferramentas

## 4.1 Claude Squad

O que copiar:

- git worktree por story;
- isolamento por tarefa;
- múltiplos workspaces;
- operação paralela.

O CAM é melhor em:

- workflow explícito;
- plan/review/ship;
- lifecycle por issue;
- reports estruturados;
- sidecar operacional.

## 4.2 OpenHands

O que copiar:

- backend local/remoto;
- sandbox;
- control plane;
- múltiplos agentes;
- automações;
- arquitetura desacoplada.

Não copiar agora:

- complexidade enterprise;
- dependência de API como caminho principal;
- amplitude excessiva de escopo.

## 4.3 Hermes Agent

Hermes é mais próximo de um agente pessoal persistente com:

- memória;
- skill creation;
- autoaperfeiçoamento;
- cron;
- mensageria;
- múltiplos backends;
- subagentes;
- personalização do usuário.

O CAM não deveria competir nesse eixo.

O que aproveitar conceitualmente:

- memória persistente;
- skills versionadas;
- execução remota;
- backend adapters;
- agendamento;
- context files;
- isolamento por executor.

## 4.4 OpenClaw

OpenClaw é um personal assistant gateway com:

- canais de mensageria;
- multi-agent routing;
- skills;
- cron;
- browser;
- apps companion;
- sandbox.

O que aproveitar:

- control plane local;
- skill registry;
- daemon;
- multi-agent routing;
- security posture;
- backend adapters.

Não transformar o CAM em:

- assistente pessoal;
- gateway de WhatsApp/Telegram;
- marketplace amplo de skills;
- sistema genérico de automação pessoal.

## 4.5 Warren

Warren é a principal referência arquitetural para a evolução web do CAM.

Princípios relevantes:

- Web UI diária;
- CLI apenas para ops;
- HTTP API única;
- runs observáveis;
- event stream canônico;
- sandbox por run;
- steer/cancel;
- branch como resultado;
- separação entre control plane e runtime;
- UI, CLI e API consumindo a mesma pipeline.

Diferença decisiva:

| Warren | CAM |
|---|---|
| API-first | subscription-first |
| cloud/sandbox-first | local-first |
| run efêmero | sessão longa + workflow |
| Anthropic API key | Claude Code autenticado localmente |
| container/Fly | máquina do usuário |
| custo por token | custo fixo de subscrição |

Direção recomendada:

> **CAM deve ser Warren-like na arquitetura, mas subscription-first no executor.**

---

# 5. tmux, cmux e interface web

## 5.1 Trocar tmux por cmux?

Não como fundação obrigatória.

O cmux é melhor como:

- cockpit;
- terminal;
- browser;
- notificações;
- workspaces;
- splits;
- UI nativa.

O CAM é:

- workflow;
- runtime;
- state machine;
- scheduler;
- supervisor;
- process layer.

Modelo recomendado:

```text
CAM = runtime
cmux = superfície opcional
```

Arquitetura possível:

```text
surface adapters
  ├── tmux
  ├── cmux
  ├── web
  └── headless
```

## 5.2 Abandonar tmux como interface principal

Sim.

Não abandonar imediatamente tmux como backend.

O tmux hoje cumpre várias funções:

| Função | Web substitui? |
|---|---:|
| Visualização de panes | Sim |
| Dashboard | Sim |
| Controles | Sim |
| Processo persistente | Só com daemon |
| PTY interativo | Precisa adapter |
| Debug manual | Terminal embutido ou tmux |
| Attach/detach | Daemon + WebSocket |
| Recovery | Daemon + persistência |

A estratégia correta é:

```text
não trocar tmux por web diretamente
separar runtime de superfície
```

---

# 6. Arquitetura-alvo

```text
Browser
   │
   ▼
CAM Web UI
   │
   ▼
CAM HTTP API / WebSocket
   │
   ▼
CAM Daemon
   ├── state machine
   ├── command queue
   ├── event log
   ├── issue selector
   ├── worker lifecycle
   ├── gates
   ├── retry manager
   ├── accounting
   └── runner adapters
          ├── claude-subscription
          ├── codex-subscription
          ├── tmux
          ├── PTY
          ├── headless
          └── futuros remotos
```

## 6.1 Papel de cada camada

| Camada | Responsabilidade |
|---|---|
| Web UI | operação diária |
| CLI | automação, fallback e ops |
| Daemon | verdade operacional |
| Event log | histórico canônico |
| Command queue | entrada de comandos |
| Runner | execução do agente |
| Claude Code | coding agent |
| tmux/PTY | substrate técnico |

---

# 7. CLI continua sendo importante?

Sim.

Mas não como interface principal diária.

## 7.1 Papel ideal do CLI

| Uso | Interface ideal |
|---|---|
| iniciar | CLI |
| pausar | CLI ou Web |
| parar | CLI ou Web |
| scripting | CLI |
| cron/hooks | CLI |
| CI | CLI |
| observação longa | Web |
| review | Web |
| ship approval | Web |
| debug | terminal bruto |
| operação remota | Web |

A frase correta é:

> **CLI é a melhor interface mínima e robusta. Web é a melhor interface operacional contínua.**

## 7.2 Evolução do CLI

Hoje:

```text
cam plan → tmux send-keys → orchestrator pane
```

Futuro:

```text
cam plan → HTTP/local RPC → daemon → state machine → runner
```

Ou:

```text
cam plan → command queue → daemon
```

O CLI deve virar thin client do runtime.

---

# 8. Restrição central: Claude subscription

A arquitetura deve partir do fato de que o CAM não controla uma API limpa.

Ele controla:

> **um processo interativo local autenticado na subscrição do usuário.**

Portanto, o runner deve tratar Claude Code como:

- processo interativo;
- opaco;
- observável;
- reiniciável;
- steerable;
- sujeito a rate limit;
- capaz de emitir artifacts estruturados;
- não confiável como fonte única de estado textual.

## 8.1 Regras de robustez

1. Não depender de scrollback como fonte primária.
2. Não deixar a UI armazenar estado.
3. Não usar `send-keys` como contrato semântico principal.
4. Toda ação deve gerar evento.
5. Toda conclusão deve gerar artifact estruturado.
6. Terminal bruto é debug, não verdade operacional.
7. A UI pode morrer sem interromper o runtime.
8. O daemon deve sobreviver a reload do browser.
9. O runner deve ser substituível.
10. O estado deve ser recuperável após crash.

---

# 9. Daemon local

Comandos sugeridos:

```bash
cam daemon
cam web
cam status
cam stop
cam resume
```

Fluxo:

```text
cam web
  └── abre browser

browser
  └── chama CAM daemon

CLI
  └── chama o mesmo CAM daemon
```

## 9.1 API mínima

```text
GET    /status
GET    /projects
GET    /sessions
GET    /runs
GET    /runs/:id
GET    /runs/:id/events
GET    /runs/:id/events?follow=1

POST   /commands/plan
POST   /commands/next
POST   /commands/review
POST   /commands/ship
POST   /commands/pause
POST   /commands/resume

POST   /runs/:id/steer
POST   /runs/:id/cancel

GET    /healthz
GET    /readyz
WS     /stream
```

---

# 10. Web UI

## 10.1 Primeira versão

A primeira versão deve ser read-only.

```text
cam web
  └── dashboard
        ├── overview
        ├── active session
        ├── current issue
        ├── current story
        ├── token accounting
        ├── cost accounting
        ├── timeline
        ├── worker reports
        └── gates
```

Não começar por:

- merge;
- ship;
- destructive actions;
- approval;
- remote execution;
- multi-user;
- RBAC;
- live terminal completo.

## 10.2 O que a dashboard deve responder em cinco segundos

1. O CAM está fazendo o quê?
2. Qual issue está ativa?
3. Qual story está ativa?
4. Está avançando ou travado?
5. Qual fase do workflow está rodando?
6. Qual ator está ativo?
7. Quanto tempo gastou?
8. Quanto token consumiu?
9. Quanto isso custaria em API?
10. Qual foi o último evento confiável?
11. Quais gates passaram?
12. Qual o próximo passo?

---

# 11. Estatísticas como primeira etapa

Estatísticas é a primeira etapa correta.

Mas a ordem deve ser:

```text
instrumentação
→ schema de eventos
→ agregador
→ cam stats --json
→ Web UI read-only
→ live events
→ ações web
```

A Web UI não deve ser uma representação estética do tmux.

Ela deve ser uma representação do estado canônico do runtime.

---

# 12. Métricas recomendadas

## 12.1 Overview global

| Métrica | Definição |
|---|---|
| Total tokens | soma de input, cached e output |
| API-equivalent cost | quanto teria custado por API |
| Subscription cost | valor real mensal |
| Estimated savings | API-equivalent menos subscription |
| Total time | tempo total de execução |
| Issues shipped | issues concluídas |
| Cycles | ciclos iniciados |
| Success rate | ciclos shipped / iniciados |
| Block rate | ciclos bloqueados / iniciados |
| Retry rate | retries / workers |
| Avg cycle duration | duração média de ciclo |
| Avg story duration | duração média por story |

## 12.2 Sessão atual

| Métrica | Definição |
|---|---|
| Status | condição operacional |
| Phase | etapa do workflow |
| Actor | papel ativo |
| Session time | duração |
| Branch | branch atual |
| Issue | issue atual |
| Story | story atual |
| Stories | concluídas / total |
| Iterations | atual / máximo |
| Last event | último evento |
| Last event age | tempo desde o último evento |
| Rate-limit status | normal / waiting / retried |
| Active worker | processo técnico |
| Blocker | motivo atual |

## 12.3 Story-level

Colunas recomendadas:

```text
Story
Status
Phase
Actor
Worker
Input
Cached
Output
Total
API-equivalent cost
Duration
Files changed
Gates
Retries
Report source
```

---

# 13. Custo e economia

Como o CAM é subscription-first, `Total cost` pode ser enganoso.

Evitar:

```text
Total cost
$1,284
```

Preferir:

```text
API-equivalent cost
$1,284
```

E separar:

```text
Subscription paid
$200
```

```text
Estimated savings
$1,084
```

## 13.1 Três métricas distintas

```text
API-equivalent cost
Subscription amortized cost
Estimated savings
```

Exemplo por sessão:

```text
API-equivalent: $8.46
Subscription amortized: $0.74
Estimated savings: $7.72
```

Essa é uma métrica central para o posicionamento do produto:

> **O CAM transforma uma assinatura fixa em trabalho agentic contínuo mensurável.**

---

# 14. State, phase, actor e worker

Esses conceitos não devem se confundir.

```text
Runtime status ≠ Workflow phase ≠ Active actor ≠ Worker process
```

## 14.1 Definições

| Conceito | Exemplo | Responde a |
|---|---|---|
| Status | active, paused, blocked | O runtime está funcionando? |
| Phase | planning, implementing, reviewing | Em qual etapa do workflow? |
| Actor | planner, implementer, reviewer | Qual papel está agindo? |
| Worker | pane, PID, PTY ou run técnico | Qual processo executa? |

## 14.2 Valores sugeridos

### Status

```text
idle
active
paused
blocked
error
completed
stopping
recovering
```

### Phase

```text
planning
implementing
reviewing
shipping
handoff
waiting
none
```

### Actor

```text
orchestrator
sidecar
planner
implementer
reviewer
auditor
shipper
operator
none
```

### Worker

```json
{
  "kind": "tmux-pane",
  "id": "%12",
  "session_id": "..."
}
```

Ou:

```json
{
  "kind": "pty",
  "pid": 12345,
  "session_id": "..."
}
```

## 14.3 UI recomendada

Em vez de:

```text
STATE
implementing
```

Usar:

```text
STATUS
active
```

```text
PHASE
implementing
```

```text
ACTOR
implementer
```

Deixar `Worker` para a tela técnica.

---

# 15. Event log canônico

## 15.1 Primeira forma

```text
.claude/cam/events.jsonl
```

Exemplo:

```json
{
  "ts": "2026-07-13T13:05:00.000Z",
  "project": "cam-cli",
  "session_id": "sess_123",
  "run_id": "run_456",
  "issue_id": "127",
  "story_id": "US-009",
  "status": "active",
  "phase": "implementing",
  "actor": "implementer",
  "kind": "worker_started",
  "data": {}
}
```

Token usage:

```json
{
  "ts": "2026-07-13T13:31:00.000Z",
  "run_id": "run_456",
  "story_id": "US-009",
  "kind": "token_usage",
  "data": {
    "input": 28000,
    "cached": 41000,
    "output": 100,
    "total": 69100,
    "api_equivalent_usd": 0.40
  }
}
```

Worker completed:

```json
{
  "ts": "2026-07-13T13:34:00.000Z",
  "run_id": "run_456",
  "story_id": "US-009",
  "kind": "worker_completed",
  "data": {
    "status": "done",
    "files_changed": 7,
    "tests_passed": true
  }
}
```

## 15.2 Eventos recomendados

```text
session_started
session_resumed
session_paused
session_stopped
session_recovered

phase_changed
issue_selected
story_selected
story_started
story_completed
story_blocked

worker_started
worker_completed
worker_failed
worker_timeout
worker_killed

review_started
review_completed
review_failed

ship_started
ship_completed
ship_failed

rate_limit_seen
retry_scheduled
retry_sent
retry_exhausted

token_usage
cost_estimated

gate_started
gate_completed
gate_failed

report_written
report_received
report_invalid

command_received
command_started
command_completed
command_failed
```

---

# 16. Persistência

## 16.1 V0

```text
scripts/cam/events.jsonl
scripts/cam/worker-report.json
scripts/cam/journal.md
.claude/cam-loop.local.md
```

## 16.2 V1

SQLite local:

```text
~/.cam/projects/<project-hash>/cam.db
```

Tabelas mínimas:

```text
projects
sessions
runs
issues
stories
events
commands
token_usage
worker_reports
gates
workers
```

## 16.3 Regra

- JSONL para log;
- SQLite para consulta;
- reports para artifacts;
- filesystem para compatibilidade;
- event stream para UI.

---

# 17. Command queue

Substituir gradualmente `send-keys` como contrato principal.

Hoje:

```text
cam plan 127
→ espera orchestrator idle
→ send-keys "/cam-plan 127"
```

Futuro:

```text
cam plan 127
→ COMMAND_REQUESTED
→ daemon valida
→ state machine agenda
→ runner executa
→ eventos são persistidos
```

Modelo de comando:

```json
{
  "id": "cmd_123",
  "type": "plan",
  "payload": {
    "issue_id": "127"
  },
  "status": "queued",
  "created_at": "..."
}
```

---

# 18. Runner adapters

Estrutura recomendada:

```text
runner adapters
  ├── tmux-claude
  ├── pty-claude
  ├── claude-subscription
  ├── codex-subscription
  ├── claude-api
  ├── codex-api
  ├── opencode
  └── remote-worker
```

## 18.1 Curto prazo

```text
Web UI
→ daemon
→ tmux adapter
→ Claude Code
```

## 18.2 Médio prazo

```text
Web UI
→ daemon
→ PTY adapter
→ Claude Code
```

## 18.3 Longo prazo

```text
Web UI
→ daemon
→ local/remote runner
→ Claude Code / Codex / OpenCode
```

---

# 19. PTY vs tmux

## 19.1 tmux

Vantagens:

- já funciona;
- attach/detach;
- robusto;
- debug manual;
- persistência de pane;
- menor reescrita.

Desvantagens:

- `send-keys`;
- parsing;
- dependência de panes;
- estado acoplado à UI terminal;
- problemas de TCC/macOS;
- difícil abstração web.

## 19.2 PTY

Vantagens:

- terminal web com xterm.js;
- controle direto de stream;
- resize;
- logs;
- stdin/stdout;
- lifecycle programático.

Desvantagens:

- reimplementar attach/detach;
- recovery;
- persistência;
- cross-platform;
- gerenciamento de processos.

## 19.3 Recomendação

Não substituir tmux imediatamente.

Criar adapter de PTY experimental depois que:

- daemon estiver estável;
- event log estiver canônico;
- Web UI estiver read-only;
- CLI já for thin client.

---

# 20. Segurança

O risco mais importante do CAM é:

```text
automação longa + bypassPermissions + acesso ao host
```

Medidas recomendadas:

- allowlist de comandos;
- gates antes de ações destrutivas;
- sandbox opcional;
- worktree por story;
- network policy;
- diretórios permitidos;
- kill switch;
- audit log;
- timeout;
- token ceiling;
- diff gate;
- approval gate;
- secret boundary;
- runner isolado.

O CAM deve ter uma postura explícita:

```text
fast mode
safe mode
sandbox mode
```

---

# 21. Worktree por story

Uma das prioridades mais importantes.

Modelo:

```text
issue 127
  ├── story US-001 → worktree A
  ├── story US-002 → worktree B
  └── story US-003 → worktree C
```

Benefícios:

- isolamento;
- reversibilidade;
- concorrência futura;
- diffs menores;
- menos contaminação;
- recuperação mais simples;
- review mais claro.

---

# 22. Remote execution

Não é prioridade inicial, mas deve existir como seam arquitetural.

Possíveis backends futuros:

```text
local
ssh
docker
vm
daytona
modal
fly
remote worker
```

A restrição subscription-first significa:

- autenticação deve permanecer local ao executor;
- o CAM não deve extrair cookies ou tokens;
- o runner remoto deve usar login oficial;
- API deve ser opcional, não obrigatória.

---

# 23. Roadmap recomendado

## Fase 1 — Instrumentação

- definir schema de eventos;
- consolidar status/phase/actor/worker;
- registrar tokens;
- registrar retries;
- registrar gates;
- registrar transitions;
- registrar reports.

## Fase 2 — Agregador

Criar:

```bash
cam stats --json
```

Saída:

```json
{
  "overview": {},
  "session": {},
  "issue": {},
  "stories": []
}
```

## Fase 3 — Web UI read-only

Criar:

```bash
cam web
```

Mostrar:

- overview;
- active session;
- issue;
- stories;
- tokens;
- costs;
- timeline;
- gates;
- reports.

## Fase 4 — Daemon

Criar:

```bash
cam daemon
```

Adicionar:

- HTTP API;
- WebSocket/SSE;
- health checks;
- command queue;
- recovery.

## Fase 5 — CLI como thin client

Todos os comandos passam pelo daemon:

```text
cam plan
cam next
cam review
cam ship
cam stop
cam resume
```

## Fase 6 — Ações web

Adicionar:

- pause;
- resume;
- next;
- review;
- ship;
- cancel;
- steer.

## Fase 7 — PTY adapter

Migrar gradualmente de tmux para PTY.

## Fase 8 — Worktrees e sandbox

- worktree por story;
- sandbox opcional;
- network restrictions;
- permission profiles.

## Fase 9 — Multi-run e remoto

- runners remotos;
- fila;
- concorrência;
- placement;
- worker registry;
- fleet view.

---

# 24. Stack sugerida

## Runtime

- Bun;
- TypeScript;
- SQLite;
- WebSocket ou SSE;
- Hono ou Bun.serve;
- Zod para schemas;
- JSONL para eventos.

## UI

- React;
- Vite;
- xterm.js;
- TanStack Query;
- TanStack Table;
- charts mínimos;
- sem Next.js inicialmente.

## Terminal

- tmux adapter;
- node-pty experimental;
- xterm.js na web.

---

# 25. Estrutura de navegação da Web UI

```text
Overview
Runs
Issues
Stories
Workers
Events
Analytics
Settings
```

## Overview

- status;
- phase;
- actor;
- current issue;
- current story;
- tempo;
- tokens;
- savings;
- last event.

## Runs

- histórico;
- status;
- duração;
- issue;
- resultado;
- tokens;
- retries;
- gates.

## Issues

- backlog;
- prioridade;
- WSJF;
- stories;
- progresso;
- ship status.

## Workers

- actor;
- runner;
- PID/pane;
- start time;
- current story;
- last heartbeat;
- logs.

## Events

- timeline canônica;
- filtros;
- payload;
- source.

## Analytics

- tokens;
- API-equivalent;
- savings;
- throughput;
- retries;
- block rate;
- cycle time.

---

# 26. Conclusão

A evolução recomendada é:

```text
CAM CLI atual
→ runtime observável
→ daemon local
→ Web UI diária
→ CLI thin client
→ command queue
→ PTY runner
→ runners múltiplos
→ sandbox e remoto
```

O ponto central é:

> **não trocar CLI por Web.**
>
> **não trocar tmux por Web.**
>
> **separar runtime, interface e executor.**

Modelo final:

```text
CLI controla
Web opera
Daemon decide
Event log registra
Runner executa
Claude Code trabalha
```

A posição estratégica mais forte para o CAM é:

> **um control plane local-first, subscription-first e domain-specific para coding agents, com workflow verificável de engenharia de software.**
