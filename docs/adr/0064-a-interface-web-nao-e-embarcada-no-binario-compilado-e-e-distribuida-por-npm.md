# ADR 0064: A interface web nao e embarcada no binario compilado e e distribuida por npm

## Context

O gateship e distribuido como binario unico de arquivo unico, e o build-release.sh aborta acima de 100 MiB. Medicao de 2026-08-11: os artefatos linux estao em 98,19 e 98,66 MiB, e a folga real ate o gate e de 2,34 MiB em linux-x64, nao os 1,34 MiB que o contrato de arquitetura registrava (o gate trunca para inteiro antes de comparar, entao so dispara a partir de 101 MiB). Um bundle React com Tailwind e componentes nao cabe nessa folga. Embarcar exigiria ainda estender o generate-embedded-vendor.ts, que le utf8 nos dois sitios de leitura, com uma trilha base64 inexistente para fontes e imagens, a mais 33 por cento de tamanho sobre um budget ja insuficiente. Do outro lado, o pacote npm ja esta estruturalmente pronto: package.json com nome gateship, private false e campo bin. O payload npm medido e de 6 a 9 MiB contra 98 MiB do binario.

## Decision

A interface web nao entra no binario compilado. O binario permanece o perfil enxuto de linha de comando, e a interface web e distribuida pelo canal npm, incluindo o diretorio de build da UI pela whitelist de arquivos do pacote. Os dois canais coexistem: o binario continua sendo a instalacao sem toolchain com verificacao de integridade e procedencia, e o npm passa a ser o canal primario, com caminho de atualizacao pelo proprio gerenciador.

## Consequences

Os itens 22 e 23 do contrato de arquitetura deixam de ser trabalho: nao ha teto a levantar nem embarque a construir. Em contrapartida, quem instalar apenas o binario nao tem a interface web, o que divide a capacidade do produto por canal de instalacao e tensiona a promessa de um comando sem toolchain declarada no README. A decisao e reversivel: embarcar depois continua possivel, ao custo da trilha base64 e do levantamento do teto. Fica registrado que o canal npm nao e universal, porque o programa e Bun-only: o entrypoint tem shebang de bun, existem 110 chamadas a APIs Bun no codigo, e Bun.TOML e Bun.sleepSync nao tem equivalente embutido no Node, entao ter npm instalado nao e o mesmo que poder executar o programa.
