# ADR 0065: A identidade visual e o COSS UI sobre Base UI, vendorizado do registry publico e nao de um worktree local

> **Nota de supersessao (2026-08-14)**: o ADR-0069 supersede a parte de escopo de
> token e de modo escuro deste ADR. A afirmacao do Context de que os tokens usam
> dois blocos escopados em `[data-coss-root]` foi medida em 2026-08-14 contra
> github.com/cosscom/coss e e falsa nas duas metades: o seletor `[data-coss-root]`
> nao existe no upstream (busca de codigo no repositorio devolve zero resultado),
> e o upstream usa `@theme inline` (packages/ui/src/styles/globals.css, linha 9)
> com `:root` (linha 161) e `.dark` (linha 214) puros. Por consequencia, o
> argumento de re-executabilidade da Consequences se aplica invertido: adotar
> `[data-coss-root]` e que seria a conversao a virar patch local reaplicado a
> cada rodada. Alem disso, a doc oficial do Tailwind v4 registra que `@theme`
> nao pode ser aninhado sob seletor nenhum, entao a forma que este ADR descreve
> e invalida por construcao. Continuam vigentes deste ADR: a restricao a
> `apps/ui/`, a vendorizacao por script re-executavel com versao pinada, a
> primitiva Base UI, e as cinco familias de cor definidas do nosso lado.

## Context

O contrato de arquitetura registrava a identidade como a branch /coss do repositorio cam-dss, com stack Radix mais cva, clsx e tailwind-merge, tokens num unico bloco @theme e modo escuro por atributo data-theme. Quatro dessas afirmacoes nao sobreviveram a medicao de 2026-08-11. Nao existe branch chamada coss: o /coss e uma rota em app/coss/ que esta untracked, viva apenas na working tree de um worktree de plano, e portanto nao sobrevive a um git clean nem existe em clone fresco. Os 53 componentes sao construidos sobre Base UI e nao sobre Radix, o que e incompatibilidade de import e nao de estilo. Os tokens nao usam @theme: usam dois blocos escopados em [data-coss-root]. O modo escuro e por classe .dark e nao por atributo. A fonte real e o COSS UI publico, cujo repositorio e o monorepo cosscom/coss, onde a raiz e AGPLv3 e apenas os diretorios apps/origin/ e apps/ui/ sao MIT. A propria documentacao do COSS declara que o Base UI ainda esta em beta.

## Decision

A identidade e adotada exatamente como o COSS UI publico a define, incluindo a primitiva Base UI, o escopo de tokens em [data-coss-root] e o modo escuro por classe. O contrato de arquitetura e emendado de Radix para Base UI. A vendorizacao e feita por script re-executavel apontado no registry publico, com versao pinada e gate de drift, e nunca por copia do worktree do cam-dss. O script fica restrito a apps/ui/, e o aviso de copyright MIT e copiado para dentro do diretorio vendorizado. As cinco familias de cor que o vendor documenta como ausentes no tema de origem, a saber info, success, warning, destructive-foreground e code, sao definidas no nosso tema em vez de reescritas para sintaxe arbitraria.

## Consequences

Adotar o tema exatamente como esta preserva a re-executabilidade do script, que era a razao de escolher a fonte publica: qualquer conversao de escopo ou de mecanismo de modo escuro viraria um patch local a ser reaplicado a cada rodada, transformando re-vendorizar em re-vendorizar e consertar. Em troca, o contrato perde a uniformidade que pretendia com @theme e data-theme. A restricao a apps/ui/ e necessaria porque a AGPLv3 da raiz e copyleft de rede e o produto e um servidor auto-hospedado, exatamente o formato em que essa licenca incide. Fica registrado que o projeto adota uma dependencia declaradamente em beta logo apos ter rejeitado outra dependencia por ser beta, no caso o sandbox-runtime: os perfis de risco diferem, porque uma primitiva de interface que quebra e visivel e reversivel enquanto um sandbox de seguranca que falha e silencioso, mas a assimetria e escolha consciente e nao acidente. Definir as cinco familias do nosso lado custa uma vez, enquanto reescrever custaria a cada re-vendorizacao, e preserva o token semantico, que e a razao de existir um design system: um painel de loop precisa dizer sucesso, alerta e destrutivo.
