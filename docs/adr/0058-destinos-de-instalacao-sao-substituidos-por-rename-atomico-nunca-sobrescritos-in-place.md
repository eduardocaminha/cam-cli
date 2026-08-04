# ADR 0058: Destinos de instalacao sao substituidos por rename atomico, nunca sobrescritos in-place

## Context

O gateship se auto-spawna pelo nome do binario instalado em cinco lugares (sidecar, orch-recycle-watch, dashboard), entao reinstalar com uma sessao gship run viva e o caso COMUM, nao borda. Os dois caminhos de instalacao faziam cp direto por cima do destino: install.sh:140 e o ramo --install de scripts/build-release.sh:204. Medido em 2026-08-04 com um binario bun-compiled: cp por cima de um destino em execucao preserva o inode e o arquivo resultante morre com rc=137 no exec, sem diagnostico; o processo vivo sobrevive. O caminho interno tem o mesmo cp e so nao exibe o defeito porque o codesign --force seguinte reescreve o arquivo, ou seja mascara em vez de nao ter. Um segundo sintoma da mesma raiz: ler o destino no meio do cp devolve arquivo parcial.

## Decision

Todo caminho que coloca um binario num destino de instalacao stageia um temporario no MESMO diretorio do destino, prepara ele por completo (conteudo, bit de execucao, quarentena, e no caminho interno assinatura e smoke de --version) e so entao troca por mv/rename(2). A alternativa mais barata, rm -f do destino antes do cp, foi considerada e REJEITADA com discriminador medido: ela mata o SIGKILL e produz inode novo, passando nos dois oraculos comportamentais, e mesmo assim deixa viva a janela em que um leitor observa o destino ausente ou pela metade. rename e a unica forma que fecha os dois sintomas de uma vez.

## Consequences

Verificacao passa a rodar contra o staged e nao contra o destino, o que muda um comportamento observavel do build-release.sh para melhor: hoje um smoke reprovado deixa a instalacao anterior ja destruida, depois disso ela fica intacta. O staged exige limpeza na trap de EXIT, senao uma falha no meio do laco deixa .gship.XXXXXX no diretorio de instalacao do usuario. O invariante fica valendo para qualquer caminho de auto-atualizacao futuro (CAM-485), que e a razao de ele ser ADR e nao so um conserto de duas linhas. Nao cobre o caso de artefato incompativel com o host (CAM-496): rename entrega o binario intacto, nao garante que ele roda nesta CPU.
