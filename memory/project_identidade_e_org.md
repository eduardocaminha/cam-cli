# Decisao: nome da org e direcao de identidade visual

Decisao do operador em 2026-08-05, tomada no meio da discussao sobre substrato de execucao.

## Org do GitHub

A org chama-se `gateship-dev`. O nome `gateship` sozinho nao esta disponivel (404 na tentativa), e o operador fechou em `gateship-dev` em vez de reabrir o gate de nome.

Consequencia a observar: o produto passa a carregar tres nomes proximos, o produto `gateship`, o binario `gship` e a org `gateship-dev`. Coerencia de nome ja mordeu este projeto antes (a colisao GARBOARD rastreada no CAM-434, e o CAM-462 registra que nada durable guarda o nome). Qualquer texto publico novo deve usar os tres deliberadamente, nunca por default.

## Identidade visual

O e-ink esta DESCARTADO. Nao buscar, nao pedir e nao esperar as referencias visuais de e-ink: aquela cerimonia do operador deixa de existir.

A direcao passa a ser o branch visual do cam-dss que carrega `/coss`. O cam-dss e o design system compartilhado do ecossistema cam (shadcn/ui sobre primitivas Base UI, tema catalog-first por preset compartilhado).

Consequencia direta no backlog: o CAM-331 (README publico ultra-profissional) estava bloqueado esperando as referencias de e-ink. Esse bloqueio CAIU. O CAM-331 volta a ser acionavel, agora ancorado no branch `/coss` do cam-dss em vez das referencias que nunca vieram.

## Mudanca de casa para a org

Decisao do operador em 2026-08-07.

Formato: TRANSFERIR o repo existente, nao criar repo novo, e renomear para `gateship` no mesmo movimento.

Razao decisiva, medida e nao opinada. Repo novo nasce com zero releases e o `install.sh` aborta com "no releases found", ou seja instalador morto no dia 1. Nasce tambem sem branch protection, e ai o `gh pr merge --auto` do ship passa a mergear sem gate de CI. E mata na hora a URL de bootstrap `raw.githubusercontent.com/<owner>/<repo>/main/install.sh`, que a transferencia mantem viva por redirect 301. A transferencia carrega os 7 releases, as 286 tags e as regras de protecao.

Contra-argumento que caiu: o repo tem 0 stars e 0 forks, entao o valor da transferencia NAO e preservar audiencia. O ativo e continuidade de distribuicao. Nao repetir o erro de avaliar o move pela metrica de audiencia.

Custo de codigo do transfer: 4 linhas mais 1 teste. O runtime resolve repo pelo remote (`gh` implicito mais `origin`), entao se auto-cura. Os hardcodes sao `install.sh:41`, `src/ui/Splash.tsx:104`, `src/retry/config.ts:31`, `package.json:10`, e o teste `test/ui/splash.test.tsx:42`.

O web entra no MESMO repo. O dashboard web substitui o pane de dashboard do tmux, nao e produto novo, e dois repos adicionariam coordenacao cross-repo que o proprio projeto documenta como fragil e nao suportada (CAM-241).

A troca de casa fecha a divida de nome, e esse e o unico instante em que ela custa uma operacao em vez de quatro ciclos. Hoje convivem binario `gateship`/`gship`, pacote `gateship`, repo `cam-cli`, diretorio de estado `scripts/cam/`, markers `.cam-*` e comandos `/cam-*`, com quatro ADRs (0045, 0049, 0050, 0054) sobre um rename que nunca fechou.

### Tres armadilhas que nao sao codigo

1. O PAT fine-grained do `.env` e owner-scoped em `eduardocaminha/cam-cli` e deixa de cobrir o repo ao virar org. Ele alimenta o polling do merge-watch e e injetado no container do worker. Precisa reemissao, e a org precisa de opt-in de PAT fine-grained.
2. A policy de Actions da org precisa permitir `oven-sh/setup-bun@v2` e `actions/attest-build-provenance@v4`, com `id-token: write` e `attestations: write`, senao o `release.yml` quebra no passo de attest.
3. As attestations racham em definitivo. Binario ja publicado esta assinado contra a identidade antiga e so valida sob o slug antigo. Cabe nota no README, nao tem conserto.

### Scope de token

O PAT fine-grained do `.env` NAO enxerga a org (403). Tudo que toca a org vai com `env -u GITHUB_TOKEN`, que cai no token OAuth do keyring. Esse token ainda precisa de `admin:org` para ler ou setar policy de Actions, via `gh auth refresh -h github.com -s admin:org`.

## Poda do backlog

Executada em 2026-08-07 com autorizacao explicita do operador.

A auditoria dos 79 issues abertos deu 17 de produto, 33 de harness interno, 12 de teste e tooling, e 17 obsoletos. 77 por cento do backlog aberto era o loop se mantendo, e esse numero e a explicacao da exaustao do operador.

O store foi podado de 477 para 18 arquivos num unico commit (`8a65239f`), removendo 388 shipados, 10 abandonados e 61 abertos que nao sobreviveram. Os 18 restantes sao 15 de produto mais 3 pendentes de decisao.

Invariante preservada por construcao: o CAM-515 e o maior id e foi retido, entao `allocateId` segue em 516 sem colidir com ids que o journal, o patterns e os ADRs referenciam. Qualquer poda futura precisa reter o teto de id pelo mesmo motivo.

Principio que a poda estabelece: nao feche N issues um a um, refile os poucos que sobrevivem. Fechar um a um custa N commits e e a mesma doenca do pen de suggestions, onde limpar sai mais caro que deletar.

## Decisoes ainda pendentes do operador

- CAM-501: binario empacotado, publicar no npm, ou apenas clone de fonte.
- CAM-421: o dashboard web adota a identidade visual agora ou sobe sem estilo.
- CAM-428: consertar as escalacoes do Resend ou deletar o subsistema de notify agora que existe superficie web.

## Por que isto esta registrado aqui

Sao decisoes de stakeholder que atravessam varios issues (CAM-331, CAM-434, CAM-462 e o caminho critico do lancamento publico) e nao pertencem a nenhum deles sozinho. O canal canonico para decisao de stakeholder e `memory/project_<topico>.md`, conforme a tabela de roteamento de conhecimento em `scripts/cam/CLAUDE.md`.
