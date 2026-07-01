# ADR 0003: Isolation boundary do worker = dev container local

- **Status**: aceito (implementado em CAM-111)
- **Data**: 2026-07-01

## Contexto

O worker do cam implementa stories de forma autonoma: faz commits, push, roda gates de qualidade. Ele precisa de acesso de escrita ao repositorio no filesystem do host e acesso de rede ao Anthropic API e ao GitHub. O isolamento entre corridas de workers e entre o worker e o ambiente do operador e um requisito de seguranca.

Tres gates definem quando uma decisao merece um ADR:

1. **Dificil de reverter**: a escolha do isolation boundary afeta o toolchain exigido de todo operador (Docker Engine, devcontainer CLI), a forma como o sidecar spawna o worker (`loop.ts`), os scripts `.devcontainer/`, e a instrucao do operador para setup. Reverter exige refactor de multiplos modulos e mudanca de convencao operacional.

2. **Surpreendente sem contexto**: para quem le apenas `loop.ts`, o dispatch do worker parece um `respawn-pane -k` comum sobre um pane tmux. Nao e evidente que o pane estara dentro de um container com firewall de egresso default-deny. Sem este ADR, a arquitetura de isolamento e invisivel para novos colaboradores.

3. **Trade-off genuino**: ha quatro alternativas viaveis, cada uma com custo e garantia distintos (ver secao Alternativas descartadas). A escolha do dev container local foi deliberada e nao trivial.

## Decisao

O isolation boundary do worker cam e um **dev container local** (`.devcontainer/Dockerfile` + `.devcontainer/devcontainer.json`).

O container fornece tres camadas de isolamento:

1. **Filesystem**: o repositorio e montado como bind-mount read-write; nao ha acesso ao restante do host.
2. **Rede (default-deny)**: firewall de egresso via `iptables` + `ipset` (script `.devcontainer/init-firewall.sh`), sete dominios permitidos (ver `docs/recovery-runbook.md` secao (x)).
3. **Usuario nao-root**: `cam-worker` (uid 1001) minimiza o blast radius de uma falha de execucao.

O preflight deterministico (`src/supervisor/preflight-container.ts`) verifica daemon Docker ativo e imagem `cam-worker:latest` presente antes de qualquer dispatch. Se o preflight falhar, o sidecar nao tenta spawnar o worker.

O fail-closed spawn (recusar dispatch quando o container nao esta pronto) sera documentado na Half B (CAM-150), quando a logica de spawn condicional existir. Este ADR documenta apenas o modelo de container e a firewall; o comportamento de recuperacao de falha de spawn e um forward reference.

## Consequencias

- **Dependencia de Docker**: todo operador precisa de Docker Engine (ou Docker Desktop) instalado e rodando localmente. A ausencia do daemon ou da imagem e detectada pelo preflight; o sidecar nao despacha sem o container pronto.
- **Custo de setup inicial**: construir a imagem uma vez (`docker build .devcontainer -t cam-worker:latest`) e rodar `init-firewall.sh` (exige capacidades `NET_ADMIN` e `NET_RAW`). Esta e uma cerimonia de operador (`requires: "operator"`, US-001 do PRD CAM-111).
- **Portabilidade**: a firewall default-deny requer Linux com iptables (ou Docker Desktop que usa VM interna no macOS/Windows). Ambientes sem suporte a iptables obtem apenas o isolamento de filesystem e usuario; sem default-deny de rede.
- **Evolucao da allowlist**: qualquer story futura que precisar de acesso a um novo dominio externo deve atualizar `init-firewall.sh` e a secao (x) do `docs/recovery-runbook.md`. Adicionar um dominio e uma decisao consciente, nao uma conveniencia.

## Alternativas descartadas

- **Native bash-sandbox** (barreira primaria via bash): implementar o gate de seguranca como wrapper bash em torno do worker. Rejeitada como barreira primaria: bash-sandbox e contornavel -- ferramentas como `Edit`, `Write`, e chamadas de rede escapam via Task subagent com permissoes distintas. Pode funcionar como camada adicional futura, nunca como gate principal.

- **Sandbox-runtime** (ex: Burrow, Sandcastle, Deno sandbox): mais leve que um container completo, mas nenhum produto maduro existe para este caso de uso especifico (worker com acesso de escrita ao repositorio e spawn tmux) em 2026-07-01. Rejeitada por maturidade insuficiente; pode ser revisitada.

- **VM local** (ex: QEMU, multipass): isolamento airtight, mas overkill para um repositorio trusted. Custo de startup de 5-30 segundos, setup de bind-mount complexo, overhead de RAM elevado. Rejeitada: custo desproporcional ao risco para o caso de uso.

- **Cloud-Daytona** (Path B): o operador avaliou delegar o worker para um workspace Daytona na nuvem em 2026-06-30. Rejeitada em favor de Path A (local) nessa data: preserva dados do repositorio local, sem dependencia de servico externo pago, latencia de rede zero para operacoes git.
