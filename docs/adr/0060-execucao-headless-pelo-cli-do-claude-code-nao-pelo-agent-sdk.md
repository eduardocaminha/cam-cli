# ADR 0060: Execucao headless pelo CLI do Claude Code, nao pelo Agent SDK

## Context

Com a execucao headless liberada, havia dois caminhos tecnicos para obter eventos estruturados de uma sessao de agente: o Agent SDK da Anthropic, ou o proprio CLI com --output-format stream-json. O SDK e a interface de mais alto nivel e funcionaria tecnicamente, ja que ele mesmo lanca um subprocesso claude que herdaria a credencial. A documentacao do SDK, porem, declara que sem aprovacao previa a Anthropic nao permite que desenvolvedores terceiros ofertem login claude.ai ou os limites desse plano para seus produtos, incluindo agentes construidos sobre o Agent SDK, e a pagina de conformidade e mais direta ao proibir rotear requisicoes atraves de credenciais de plano Free, Pro ou Max em nome dos usuarios. O projeto caminha para lancamento publico, o que o coloca exatamente na figura de desenvolvedor terceiro com um produto. O CLI, por outro lado, tem caminho documentado para uso nao interativo, e o comando de geracao de token de longa duracao existe declaradamente para pipelines de integracao continua, scripts e ambientes sem login por navegador.

## Decision

A execucao headless usa o CLI do Claude Code diretamente, com --print, entrada e saida em stream-json e modo verboso, e nunca o Agent SDK. A decisao e de politica e nao de capacidade.

## Consequences

O projeto assume a leitura e a interpretacao do fluxo NDJSON por conta propria, trabalho que o SDK entregaria pronto, em troca de permanecer no caminho sancionado para um produto distribuido a terceiros. O custo e menor do que a primeira estimativa sugeria: o stream-json ja entrega evento estruturado, identificador de sessao, retomada, uso de tokens e custo acumulado, e o repositorio ja possui leitura madura de JSONL sobre exatamente o mesmo vocabulario de evento, hoje aplicada aos arquivos de transcricao em disco. A alternativa do SDK foi recomendada primeiro nesta mesma sessao e revertida quando se mediu que o argumento que a sustentava, o de que sair para o CLI trocaria uma forma fragil de leitura por outra, nao se aplicava. Fica o risco de acompanhar mudancas de formato do CLI sem a estabilidade de contrato que um SDK versionado ofereceria.
