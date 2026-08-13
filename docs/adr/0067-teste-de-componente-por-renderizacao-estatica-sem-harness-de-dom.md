# ADR 0067: Teste de componente por renderizacao estatica, sem harness de DOM

## Context

A camada web introduz componentes React num repositorio cujo runner e o bun test, com cerca de 390 arquivos e 6200 testes rodando num processo unico, quase todos sem qualquer relacao com navegador. A documentacao oficial do Bun recomenda happy-dom como o caminho de teste de DOM, e nao documenta alternativa. A superficie a testar e uma tela READ-ONLY: nenhuma entrada de usuario alem de navegacao, e um unico efeito, que e a leitura periodica.

## Decision

Os componentes sao exercitados por renderToStaticMarkup do react-dom/server, dentro do proprio bun test, sobre cada variante de dado. A logica de leitura periodica e extraida para funcao pura com fetch e temporizador injetados, e testada com relogio falso. Nenhum harness de DOM entra no repositorio, e um pino de invariancia guarda essa ausencia. Assercao por expressao regular sobre texto-fonte de componente fica proibida como oraculo de comportamento. Teste em navegador real, por Playwright contra o SPA construido, fica declarado como camada futura, com gatilho no dia em que layout precisar de cobertura.

## Consequences

Ganha-se execucao real do componente, portanto deteccao de crash de renderizacao e de ramo de estado nao renderizado, ao custo de zero global instalada, zero preload de escopo global e zero vazamento entre os 6200 testes existentes. Perde-se cobertura de efeito, de evento e de layout; para uma tela sem entrada cujo unico efeito foi extraido, a perda relevante e apenas o layout, que harness de DOM simulado tambem nao cobriria. A decisao contraria a recomendacao oficial do fornecedor do runner, e o motivo esta medido: happy-dom nao computa layout nem aplica CSS, o bug aberto oven-sh/bun#21358 descreve exatamente a forma desta suite (document is not defined apenas quando varios arquivos rodam juntos), o preload do bunfig.toml so existe em escopo de execucao inteira, e o custo e 8,58 MB com sete dependencias transitivas. A alternativa de assercao sobre texto-fonte, praticada por um repositorio irmao, foi rejeitada por ser simultaneamente change-detector test, teste de detalhe de implementacao e oraculo fraco no sentido formal, produzindo verde que nao carrega informacao. Consequencia estrutural aceita: componentes precisam nascer com a logica separada da apresentacao, porque so a parte pura e testavel em profundidade.
