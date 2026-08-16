# ADR 0069: A identidade visual vem do item de registry construido, declarada em :root, e nao do CSS do pacote AGPL

> **Nota de supersessao (2026-08-16, GSHIP-596)**: a decisao de procedencia caiu
> junto com a arvore vendorizada. `webui/src/index.css` passa a ser tema proprio
> do Gateship: um token semantico por papel que a tela nomeia, escrito por nos,
> sem derivacao de item de registry de terceiro e portanto sem fronteira AGPL a
> respeitar. Continuam validas, agora por argumento tecnico proprio e nao por
> procedencia, as duas restricoes de forma que este ADR mediu: `@theme inline` e
> obrigatorio, porque um `@theme` comum resolve a referencia no sitio da
> definicao e o override de `.dark` nunca chega a tela; e o modo escuro fica em
> `@custom-variant dark (&:where(.dark, .dark *))`.

## Context

A Parte B2 do cliente web precisa dos tokens de cor do COSS UI. O caminho obvio e copiar o CSS de tema do upstream. Medicao na fonte em 2026-08-14 mostrou que ha tres candidatos e que dois carregam AGPL: apps/ui/app/globals.css faz @import de @coss/ui/globals.css na primeira linha, e packages/ui/src/styles/globals.css E o arquivo do pacote AGPL. O unico lado MIT que carrega os tokens e o item de registry construido, apps/ui/public/r/style.json, campo cssVars, gerado a partir de apps/ui/registry/registry-styles.ts. A mesma medicao derrubou uma premissa escrita: o seletor [data-coss-root], que o item 13 do contrato manda adotar como esta e nunca converter, NAO existe no upstream, com zero resultados de busca; o upstream usa :root e .dark puros. A justificativa registrada para adota-lo, evitar patch local que precisaria ser reaplicado a cada re-vendorizacao, portanto se aplicava ao contrario do que estava escrito. A doc oficial do Tailwind v4 acrescenta uma restricao dura: @theme nao pode ser aninhado sob seletor nenhum, entao a forma que o contrato descrevia era invalida por construcao.

## Decision

Os tokens vem de apps/ui/public/r/style.json, campo cssVars, e o script de vendorizacao os transforma em CSS. O tema declara os custom properties em :root com override em .dark, expoe por @theme inline os que viram utilitario, e liga o modo escuro pela forma documentada @custom-variant dark (&:where(.dark, .dark *)). O seletor [data-coss-root] fica proibido, e sua ausencia e criterio de aceite. A forma do upstream para o modo escuro, &:is(.dark *), fica rejeitada.

## Consequences

Supersede a parte do ADR-0065 que registra a adocao de [data-coss-root] como esta, e emenda o item 13 do contrato em memory/project_definicoes_web_headless.md; as duas superficies precisam de nota de supersessao, porque a premissa que as sustentava caiu por medicao e nao por mudanca de gosto. Ganha-se o unico caminho de token que nao atravessa a fronteira AGPL, e perde-se a copia direta de CSS: o script passa a precisar de um passo de geracao de JSON para CSS que as alternativas nao exigiriam. @theme inline deixa de ser detalhe e vira obrigatorio, porque sem ele o utilitario resolve a referencia no sitio da definicao e o override de .dark nunca pega. A forma do upstream foi rejeitada por dois defeitos medidos e nao por estilo: :is carrega especificidade onde :where e zero, e .dark * casa somente descendentes, deixando o proprio no .dark sem estilo escuro.
