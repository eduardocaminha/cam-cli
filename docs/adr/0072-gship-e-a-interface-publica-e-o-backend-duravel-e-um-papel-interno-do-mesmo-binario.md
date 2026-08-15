# ADR 0072: `gship` e a interface publica; o backend duravel e um papel interno do mesmo binario

- **Status**: aceito como arquitetura-alvo; a implementacao atual continua transitoria ate a migracao vertical
- **Data**: 2026-08-15

## Contexto

O fluxo atual precisa sobreviver ao fechamento do terminal, a troca de sessao do orquestrador e a desconexao do navegador. Isso exige um processo duravel, mas nao exige preservar a implementacao atual do sidecar. A experiencia com o spike web e com o planejamento da CAM-555 mostrou duas coisas diferentes: o transporte headless sem `tmux` funciona, enquanto o sidecar atual acumula responsabilidades de scheduler, supervisor de processos, maquina de estados, policy engine, recovery e workflow de negocio. O resultado e um loop grande, dirigido por polling e por muitos arquivos `.cam-*`, no qual ownership e cancelamento ainda podem deixar um filho orfao.

A investigacao de Warren, Overstory, OpenHands, SWE-agent, Claude Code, Codex app-server, LangGraph e Temporal sustenta a separacao entre uma interface web descartavel e um backend de execucao persistente. Ela nao sustenta copiar a amplitude dessas ferramentas. Gateship e local-first, single-user e orientado ao ciclo de engenharia; Kubernetes, um workflow engine distribuido e uma plataforma multiagente generica seriam complexidade sem necessidade medida.

O core que vale preservar e o dominio `issue -> work -> verify -> review -> ship`, com estado observavel, retomada e gates. `tmux`, `send-keys`, o arquivo de loop usado como barramento e o sidecar destacado sao mecanismos historicos, nao o core do produto.

## Decisao

Gateship converge para **um unico servico local** que reune API HTTP, runner, estado duravel e stream de eventos. Nesta ADR, `gshipd` e apenas o nome arquitetural do papel duravel (`d` de daemon), nao um segundo produto nem um segundo binario instalado.

A superficie publica permanece uma so:

```text
gship
```

O mesmo executavel pode assumir papeis internos por subcomando, por exemplo `gship web` ou `gship serve`. A UI, o CLI e automacoes consomem a mesma API. Se o processo precisar ser registrado no `launchd`, `systemd` ou em um container, o identificador do servico pode usar `gshipd`, mas o usuario nao precisa instalar nem aprender esse comando.

### Forma do backend

O servico local tera:

- `Bun.serve` para comandos HTTP e assets da interface;
- SQLite como fonte duravel para runs, transicoes e eventos relevantes;
- uma maquina de estados pequena, dirigida por eventos, sem polling periodico como caminho principal;
- `POST` para comandos e SSE para eventos; WebSocket fica fora enquanto nao houver bidirecionalidade que o justifique;
- adaptadores finos de executor com um contrato comum de execucao, eventos, resultado, retomada e cancelamento;
- ownership explicito do processo filho: cancelar propaga o sinal, encerra o grupo/processo e aguarda a saida antes de o servico terminar;
- recuperacao honesta: se o backend cair, a run vira `interrupted` e pode retomar pelo identificador de sessao/thread do provedor; a primeira versao nao tenta adotar magicamente processos orfaos.

O adaptador Claude continua usando o CLI headless e `stream-json`, conforme a ADR 0060; esta decisao nao reabre o uso do Agent SDK para credenciais de subscricao. O adaptador Codex pode usar o app-server, cujo protocolo ja oferece thread, turn, eventos, retomada e interrupcao. O contrato interno nao deve reimplementar o loop cognitivo que esses executores ja possuem.

### Loop de produto

A maquina de estados alvo e:

```text
queued -> working -> verify -> review? -> ready-to-ship -> done
                    |          |
                    |          +-> working (no maximo uma rodada automatica de fix)
                    +-> waiting-user | failed | interrupted
```

Politicas deliberadamente limitadas:

- a mesma sessao primaria planeja e implementa quando o provedor permite retomada; muda-se a permissao, nao se traduz o plano entre dois agentes por padrao;
- review e uma leitura nova, read-only, do diff e dos testes;
- ha no maximo uma rodada automatica de correcao depois do review;
- sugestoes aparecem para o operador e nao viram stories automaticamente;
- testes focados rodam durante o trabalho; a suite completa roda no gate de ship/CI;
- erro de spec ou de harness e roteado ao artefato responsavel ou a `waiting-user`, sem recriar recursivamente todo o planejamento;
- roles extras so entram mediante evidencia de que elevam a qualidade mais do que elevam custo, latencia e nao-convergencia.

### Migracao vertical

O primeiro slice implementa, nesta ordem:

1. schema SQLite, reducer da maquina de estados e SSE, exercitados por um executor fake;
2. um adaptador real, retomavel, para uma unica sessao de trabalho;
3. cancelamento com teste que prova a inexistencia de processo filho orfao;
4. um ciclo real completo pela Web;
5. remocao do caminho antigo correspondente, incluindo testes de compatibilidade que so protegem `tmux`, markers ou polling.

Nao sera feita uma reescrita horizontal que primeiro replique todos os comportamentos do sidecar. Cada capacidade antiga precisa provar valor no novo fluxo antes de ser portada.

## Consequencias

- A persistencia continua existindo, mas passa a pertencer ao backend principal, e nao a um sidecar ao lado da aplicacao.
- O navegador permanece stateless e pode abrir, fechar ou reconectar sem ser dono de uma execucao.
- `gship` continua sendo a marca e o unico comando publico. `gshipd` pode existir em logs, nomes de processo ou configuracao do sistema operacional, sem ampliar a superficie de produto.
- `cam-loop.local.md` deixa de ser a arquitetura-alvo como scheduler/barramento. As ADRs 0004, 0009 e 0024 continuam descrevendo corretamente o sistema legado, mas seus mecanismos serao superseded por slices quando cada substituicao estiver implementada e validada.
- O transporte tipado sem TTY e a superficie web same-origin do spike sao aproveitaveis. Ownership destacado por marker, polling, explosao de `.cam-*`, replan/audit recursivo e fallback indefinido para `tmux` nao sao.
- Temporal e LangGraph nao entram como dependencias agora. Gateship aproveita seus principios de checkpoint, idempotencia e retomada sem assumir seu custo operacional e seus modelos de execucao.

## Regra de simplicidade

Uma nova regra, role, marker, retry ou gate so entra quando protege uma falha real e medida. A unidade de avaliacao nao e "este teste torna esta funcao mais segura", mas "esta politica melhora a probabilidade de completar um ciclo com qualidade". Complexidade que apenas descreve, testa ou recupera outra complexidade deve ser removida junto com a causa.
