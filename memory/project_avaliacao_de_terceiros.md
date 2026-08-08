# Avaliacao de terceiros: restricoes, vereditos e protocolo

Origem: pedido do operador em 2026-08-08, durante a sessao que decidiu o rumo
headless (CAM-516). O problema que este arquivo resolve: cinco subagentes e
cerca de 250 mil tokens foram gastos numa unica sessao auditando Warren, Agent
SDK, auth e sandboxes, e todo esse material evapora quando o orquestrador
recicla. Sem registro, o proximo nome que o operador trouxer custa a mesma
pesquisa de novo, e pode chegar a veredito diferente sem ninguem perceber que
ja havia decisao.

Ordem deliberada das secoes: as restricoes sao duraveis, os produtos sao
periveis. Quem consulta este arquivo le a secao 1 primeiro e na maioria dos
casos nao precisa da secao 2.

## 1. Restricoes eliminatorias

Estas quatro restricoes decidiram todos os vereditos da secao 2. Elas nao
mudam quando os produtos mudam, e a maioria dos candidatos morre aqui sem
precisar de estudo aprofundado.

- **R1, credencial propria.** Tem que aceitar `CLAUDE_CODE_OAUTH_TOKEN` num
  binario `claude` real. Produto que so aceita `ANTHROPIC_API_KEY` quebra a
  tese economica do projeto, que e rodar na subscription.
- **R2, nao intermediar a chamada.** Produto que roteia a chamada do modelo
  pelo servico dele esta fora por duas razoes somadas: quebra a subscription e
  cai na politica da Anthropic. Texto literal em
  `code.claude.com/docs/en/legal-and-compliance`: "Anthropic does not permit
  third-party developers to offer Claude.ai login or to route requests through
  Free, Pro, or Max plan credentials on behalf of their users." A linha e
  rotear credencial alheia. O operador injetando o proprio token no proprio
  ambiente e uso ordinario.
- **R3, adotavel pelo usuario final.** O gateship e CLI open source destinado a
  lancamento publico. Exigir que o usuario tenha conta de terceiro, cartao de
  credito ou plataforma especifica e barreira de entrada, nao detalhe.
- **R4, sessao longa e com estado.** O workload e uma sessao morna de minutos a
  horas, com bind-mount de repo git e volume persistente. APIs de sandbox
  efemero sao otimizadas contra exatamente esse formato.

Corolario medido em 2026-08-08: R2 e R3 juntas eliminaram Daytona, E2B, Modal,
Fly, Runloop, Blaxel, Vercel, Cloudflare, Northflank e Freestyle sem nenhum
estudo individual aprofundado.

## 2. Vereditos

Formato: uma linha por produto. Todo veredito carrega a data em que foi
medido e qual restricao decidiu. **Veredito sem data nao conta como veredito**
e dispara re-auditoria.

Dois eixos, porque servem a propositos diferentes. **Adotar** significa passar
a depender do produto. **Copiar** significa estudar e portar codigo ou desenho,
com a licenca como unico gate.

### 2.1 Eixo copiar (prior-art)

| Produto | Medido | Veredito | Razao |
|---|---|---|---|
| Warren (`jayminwest/warren`) | 2026-08-08 | COPIAR PARCIAL | MIT, 281 stars, vivo (commit no mesmo dia). 97k LOC nao-teste, aplicacao inteira, nao biblioteca. Reusavel: cerca de 350 linhas. `src/server/ui.ts` (handler de SPA estatica com fallback de deep-link e guard de path traversal), Dockerfile multi-stage `oven/bun`, `useEventStream.ts` (NDJSON com resume por seq e backoff). Irrelevante: supervisor, preview, plots, healer, ci-fixer, 52 migrations, os 2.4k linhas de `api/client.ts` e `types.ts`. |
| burrow (`jayminwest/burrow`) | 2026-08-08 | COPIAR NAO NECESSARIO | Mecanismo de credencial (extrair blob OAuth do Keychain via `security find-generic-password`, plantar em `$HOME/.claude/.credentials.json` mode 0600 com HOME remapeado). Existe porque o burrow sandboxa com HOME proprio. O gateship ja resolve melhor: passa `CLAUDE_CODE_OAUTH_TOKEN` name-only no `docker run` e nao passa `ANTHROPIC_API_KEY`, ou seja ja e subscription-only por construcao. Autoria upstream Jaymin West, nao do operador. |

### 2.2 Eixo adotar (infraestrutura)

| Produto | Medido | Veredito | Restricao que decidiu |
|---|---|---|---|
| Docker puro (status quo) | 2026-08-08 | ADOTADO | Unico com alcance universal (Intel Mac, Windows, WSL2, arm64 Linux, CI). Configuracao atual e copia quase exata do devcontainer de referencia da Anthropic, que a propria Anthropic nomeia como adequado para `--dangerously-skip-permissions`. |
| Anthropic devcontainer + `init-firewall.sh` | 2026-08-08 | ADOTADO (ja e o nosso) | Apache-2.0. Usuario nao-root, volume nomeado para `~/.claude`, `NET_ADMIN`/`NET_RAW`, allowlist iptables default-deny. |
| Claude Code CLI headless (`--print`, `stream-json`) | 2026-08-08 | ADOTADO (decisao CAM-516) | Caminho sancionado para subscription. `claude setup-token` documentado para "CI pipelines, scripts, or other environments where interactive browser login isn't available". |
| `@anthropic-ai/sandbox-runtime` (srt) | 2026-08-08 | CANDIDATO FUTURO | Apache-2.0, first-party, ~4.9k stars, beta research preview. Seatbelt no macOS sem Docker, bubblewrap no Linux, deny-by-default de rede, e documenta OAuth explicitamente (allowlist precisa de `claude.ai` e `platform.claude.com` para refresh de token). Nao adotado agora por dois defeitos medidos: sem limite de OOM nem de recurso, e no Linux a deny list e montada no launch e nao cobre o que a sessao criar depois. Melhor resposta futura para o usuario que nao quer instalar Docker. |
| Docker Sandboxes (`sbx`) | 2026-08-08 | CONTRADICAO NAO RESOLVIDA | MicroVM via Apple Virtualization.framework, sem Docker Desktop, `sbx run claude` nativo. Duas auditorias independentes discordaram no mesmo dia: uma afirma que o proxy substitui o bearer token e da 401 para quem usa subscription (bug `docker/desktop-feedback#68`, aberto desde fev 2026), a outra descreve o proxy como injetando credencial sem armazena-la. Uma das duas esta desatualizada. Medir antes de considerar. |
| Agent SDK (`@anthropic-ai/claude-agent-sdk`) | 2026-08-08 | REJEITADO | R1 e R2. Politica explicita no quickstart: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." Zero mencao a `CLAUDE_CODE_OAUTH_TOKEN` em qualquer pagina do SDK. Tecnicamente funcionaria (o SDK spawna subprocess `claude`), mas funcionar nao torna sancionado. Nao traz nada que o CLI nao traga: cerca de 150 linhas de parser de NDJSON e a diferenca inteira. |
| Daytona | 2026-08-08 | REJEITADO | R2, R3, R4. Pivotou em 2025 de dev-envs para sandbox de agente, core AGPL-3.0, criacao sub-90ms. SaaS efemero-first cobrado por segundo; usuario final precisaria de conta. Cold start irrelevante para sessao de horas. |
| E2B | 2026-08-08 | REJEITADO | R3. Firecracker, infra Apache-2.0, mas self-host e projeto de infraestrutura real (Terraform, Nomad, Consul), com piso citado na faixa de 1.250 USD/mes. |
| Modal Sandboxes | 2026-08-08 | REJEITADO | R3, R4. gVisor, SaaS-only, e limite de 24h de vida por sandbox. |
| Fly.io Sprites | 2026-08-08 | REJEITADO | R3. KVM persistente, bom tecnicamente, mas SaaS-only com piso mensal para uma ferramenta local. |
| Hospedados em bloco (Vercel Sandbox, Cloudflare Sandbox SDK, Runloop, Blaxel, Northflank, Coder, Freestyle) | 2026-08-08 | REJEITADOS | R2, R3. Todos exigiriam ensinar terceiros a mandar token de Claude.ai para nuvem de terceiro, que e a postura exata que a politica da Anthropic mira. |
| Apple `container` | 2026-08-08 | REJEITADO | R3. Apache-2.0, VM por container, 1.0 em jun/2026, mas exige macOS 26 e Apple Silicon. Exclui Intel Mac, Windows e Linux. |
| microsandbox | 2026-08-08 | IMATURO | libkrun microVM, OSS, unico contendor OSS de grau VM genuinamente interessante. Historia de Apple Silicon nao verificada e sem caminho de integracao com Claude Code. |
| container-use (Dagger) | 2026-08-08 | REJEITADO | Adiciona camada de Dagger mais MCP, e o modelo de worktree por agente conflita com o fluxo de push e CI. |
| Sandcastle (`mattpocock/sandcastle`) | 2026-08-08 | REJEITADO | Wrapper fino sobre Docker/Podman, sem isolamento proprio. |
| Sculptor (Imbue) | 2026-08-08 | REJEITADO | R4 parcial. Aplicacao GUI de desktop, nao formato headless. Roda agentes em Docker e declara funcionar com subscription existente. |
| Harbor (`laude-institute/harbor`) | 2026-08-08 | CATEGORIA ERRADA, GUARDAR | Apache-2.0, ~4k stars, descendente do Terminal-Bench. Nao e runtime de sandbox: e harness de avaliacao e RL que delega isolamento para Docker, Daytona, Modal, E2B, Runloop, Blaxel. Docs de setup assumem `ANTHROPIC_API_KEY`. Guardar por outro motivo: medir se uma mudanca de prompt ou de modelo melhorou o loop e hoje impossivel no gateship, e e exatamente esse o problema que ele resolve. |

## 3. Protocolo de pesquisa

Quando o operador trouxer um nome novo, a auditoria segue esta ordem. O custo
esperado e minutos, nao um subagente inteiro, porque a secao 1 elimina a
maioria antes da pesquisa comecar.

**Passo 1, aplicar as restricoes da secao 1 pela pagina inicial do produto.**
Se ele intermedia a chamada do modelo (R2) ou exige conta de terceiro (R3), o
veredito ja saiu. Registre e pare.

**Passo 2, se sobreviver, buscar nesta ordem de autoridade.** Documentacao
oficial do produto, depois o repositorio no GitHub (licenca, ultimo commit,
issues abertas relevantes), depois a documentacao da Anthropic quando houver
interacao com Claude Code. Blog de marketing e material de lancamento nao
estabelecem nada e nao devem ser citados como fonte.

**Passo 3, extrair sempre estes campos.** Licenca verbatim, se e self-hostable
ou SaaS, se roda em macOS Apple Silicon ou exige Linux, mecanismo de
isolamento, e principalmente como a credencial entra e se o produto a
armazena ou a intermedia.

**Passo 4, separar intencao de comportamento.** Documentacao oficial estabelece
intencao. Somente medicao estabelece comportamento. Esta linhagem errou duas
vezes na mesma semana afirmando configuracao por raciocinio em vez de teste (a
permissao "Checks: Read" que nao era necessaria, e a alegacao de que o
container injetava o token quando toda mutacao `gh` ja o remove). Quando a
diferenca importar para a decisao, meca.

**Passo 5, registrar na secao 2 com data e restricao.** Contradicao entre
fontes se registra como contradicao, nao se resolve por escolha. O `sbx` e o
exemplo vivo: duas auditorias no mesmo dia discordaram e a linha diz isso.

**Passo 6, reavaliar o que ficou velho.** Veredito sem data nao vale. Veredito
com mais de seis meses vale como hipotese, nao como fato: produtos deste
mercado pivotam rapido, e o Daytona (dev-envs para sandbox de agente) e o
proprio Agent SDK sao prova disso.
