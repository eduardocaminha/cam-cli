# ADR 0071: Arvore vendorizada de terceiro e submetida aos nossos gates, sem isencao

> **Nota de supersessao (2026-08-16, GSHIP-596)**: sem objeto. Nao existe mais
> arvore de terceiro no repositorio, e por consequencia nao existe isencao a
> negar nem pino de invariancia a manter. A parte que sobrevive e generica e nao
> precisa deste ADR para valer: codigo dentro do repositorio passa pelos nossos
> gates.

## Context

A CAM-565 traz para dentro do repositorio uma copia de componentes do monorepo cosscom/coss, sob webui/vendor/coss. A pergunta que precisava de decisao era se essa arvore fica sujeita ao nosso lint, typecheck, detector de codigo morto e metrica de cobertura, ou se recebe isencao.

A convencao da industria empurra para a isencao, e por motivo declarado. A doc do Chromium sobre third_party manda nao reformatar codigo de dependencia, justificando por diff limpo contra o upstream e aplicacao de patch de seguranca. O Go 1.9 tirou vendor/ do alcance de ./... no proprio toolchain. Jest ja traz /node_modules/ como default de coveragePathIgnorePatterns, o nyc forca a exclusao mesmo sem config, e o uploader do codecov hard-codeia vendor/. Entre projetos que copiam componentes shadcn, os que rodam config estrita isentam a arvore, incluindo ai-chatbot e next-forge, ambos da Vercel.

Duas medicoes nossas, de 2026-08-14, desmontaram a aplicacao dessa convencao ao nosso caso. A primeira: os componentes semente baixados no SHA pinado passam com zero diagnostico do tsc sob os flags exatos do webui/tsconfig.app.json, incluindo noUncheckedIndexedAccess, noUnusedParameters e verbatimModuleSyntax, e com zero violacao nas duas regras ativas do biome, com controle negativo aplicado para provar que as regras nao estavam no-opando. Nao ha nada para isentar. A segunda: a isencao de typecheck nem seria possivel, porque a doc oficial do TypeScript afirma que exclude nao impede um arquivo alcancado por import de entrar na compilacao, e skipLibCheck so cobre .d.ts.

A razao de fundo que separa nosso caso do shadcn: a doc do shadcn diz que voce e dono do codigo copiado e deve edita-lo, e por isso o proprio repositorio do shadcn linta o registry que distribui. A nossa arvore e o oposto, e regenerada por script re-executavel num commit pinado e nunca editada a mao, que e exatamente a premissa em que as convencoes de Go e Chromium repousam.

## Decision

Nenhuma exclusao de webui/vendor entra em biome.json, knip.json ou bunfig.toml. A arvore vendorizada passa pelos mesmos gates que o nosso codigo. A decisao e sustentada por um pino de invariancia que falha se qualquer uma das tres configs ganhar uma entrada webui/vendor, e por um pino de idempotencia que falha se a arvore divergir do que o script regenera.

O alcance do knip nao precisa de excecao por construcao: a arvore e o fecho transitivo de uma lista-semente e cada semente tem consumidor, entao todo arquivo e alcancavel. Arquivo inalcancavel passa a significar que o script copiou demais, que e defeito nosso e sinal verdadeiro. Discovery de teste tambem nao precisa: o upstream nao tem nenhum arquivo de teste em apps/ui no SHA pinado, medido pela tree API completa.

## Consequences

Se um re-vendor futuro em SHA novo trouxer codigo que viole nossos flags, o conserto e do lado do upstream ou da selecao de sementes, nunca uma isencao: adicionar exclusao quebra o pino de invariancia, e o gate acusa. O custo dessa rigidez e real e foi aceito de olhos abertos, porque a alternativa e uma isencao que so seria honesta enquanto ninguem editasse a arvore, condicao que sem checagem de maquina nao se sustenta.

A cobertura fica com as linhas de terceiro no denominador. Isso e desvio deliberado da convencao dominante, aceitavel porque os componentes vendorizados sao exercitados pelos testes de renderizacao estatica desta fatia, e portanto contribuem linha coberta e nao so denominador. Se uma vendorizacao futura trouxer superficie grande e nao exercitada, essa premissa cai e a decisao precisa ser revisitada aqui, nao contornada com uma linha de config.
