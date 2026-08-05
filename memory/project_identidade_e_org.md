# Decisao: nome da org e direcao de identidade visual

Decisao do operador em 2026-08-05, tomada no meio da discussao sobre substrato de execucao.

## Org do GitHub

A org chama-se `gateship-dev`. O nome `gateship` sozinho nao esta disponivel (404 na tentativa), e o operador fechou em `gateship-dev` em vez de reabrir o gate de nome.

Consequencia a observar: o produto passa a carregar tres nomes proximos, o produto `gateship`, o binario `gship` e a org `gateship-dev`. Coerencia de nome ja mordeu este projeto antes (a colisao GARBOARD rastreada no CAM-434, e o CAM-462 registra que nada durable guarda o nome). Qualquer texto publico novo deve usar os tres deliberadamente, nunca por default.

## Identidade visual

O e-ink esta DESCARTADO. Nao buscar, nao pedir e nao esperar as referencias visuais de e-ink: aquela cerimonia do operador deixa de existir.

A direcao passa a ser o branch visual do cam-dss que carrega `/coss`. O cam-dss e o design system compartilhado do ecossistema cam (shadcn/ui sobre primitivas Base UI, tema catalog-first por preset compartilhado).

Consequencia direta no backlog: o CAM-331 (README publico ultra-profissional) estava bloqueado esperando as referencias de e-ink. Esse bloqueio CAIU. O CAM-331 volta a ser acionavel, agora ancorado no branch `/coss` do cam-dss em vez das referencias que nunca vieram.

## Por que isto esta registrado aqui

Sao decisoes de stakeholder que atravessam varios issues (CAM-331, CAM-434, CAM-462 e o caminho critico do lancamento publico) e nao pertencem a nenhum deles sozinho. O canal canonico para decisao de stakeholder e `memory/project_<topico>.md`, conforme a tabela de roteamento de conhecimento em `scripts/cam/CLAUDE.md`.
