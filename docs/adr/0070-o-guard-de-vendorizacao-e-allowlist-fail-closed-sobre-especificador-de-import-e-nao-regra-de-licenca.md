# ADR 0070: O guard de vendorizacao e allowlist fail-closed sobre especificador de import, e nao regra de licenca

> **Nota de supersessao (2026-08-16, GSHIP-596)**: sem arvore vendorizada nao ha
> o que guardar. `scripts/vendor-coss.ts` e seus tres testes foram removidos com
> a superficie que protegiam, e nada os substitui: nem registro de arquivos, nem
> allowlist, nem regex de procedencia, nem gate de vendor. O criterio de aceite
> desta decisao volta a valer apenas se um dia entrar codigo de terceiro copiado
> para dentro do repositorio, e isso e decisao nova.

## Context

A raiz do monorepo cosscom/coss e AGPLv3 e apenas apps/origin/ e apps/ui/ sao MIT, entao a vendorizacao fica restrita a apps/ui/. Um guard so por caminho e insuficiente em tese, porque um arquivo copiado pode puxar modulo AGPL por import com todos os caminhos do manifesto dentro da subarvore MIT. A ferramenta que parece resolver isso e dependency-cruiser com a regra to.license, unica no levantamento que combina grafo de import e licenca. A medicao mostrou que ela FALHA ABERTO neste caso exato: ela le a licenca do package.json do modulo resolvido, e depois de achatar a arvore e reescrever os imports o especificador @coss/ui nao resolve para lugar nenhum, logo nao ha package.json para ler, logo a regra nao casa nada e o build fica verde. Medicao adicional na fonte enfraqueceu tambem a premissa do risco: os 29 hits de @coss/ sob apps/ui/ estao todos na casca do site de docs e nao nos componentes do registry, e o unico hit dentro de registry/ e um registryDependencies, que e namespace de registry do shadcn e nao import npm. O levantamento de prior art confirmou que o shadcn, dominante no modelo de copiar em vez de depender, nao oferece nenhum mecanismo de contencao de import nem de atribuicao de licenca.

## Decision

O script expoe --verify <dir> e falha fechado por ALLOWLIST sobre especificador literal de import: cada especificador ou e caminho relativo que normalizado permanece dentro da raiz verificada, ou e membro de uma lista npm explicita, e qualquer outra coisa reprova. Nao se resolve modulo, nao se consulta base de licenca, nao se le node_modules. O criterio de aceite exercita tres direcoes, e a terceira, um pacote desconhecido que nao pertence a @coss/, e obrigatoria.

## Consequences

A terceira direcao existe porque sem ela o oraculo nao distingue allowlist de denylist. Medido em 2026-08-14: o oraculo fica VERMELHO contra uma implementacao denylist-only, o que prova que ele enforca a semantica escolhida e nao apenas a rejeicao de @coss/. Ganha-se cobertura sobre todo especificador futuro que ninguem previu, que e o modo de falha real de uma re-vendorizacao daqui a meses, e a implementacao cabe em cerca de vinte linhas sem resolver e sem node_modules. Aceita-se que o guard nao diz nada sobre texto copiado do lado AGPL: essa deteccao seria por similaridade de conteudo, e ela e inutil aqui por construcao, porque o script sync-ui.mts do upstream copia o registry MIT para dentro do pacote AGPL, tornando a quase-identidade entre os dois lados esperada. A posicao defensavel contra esse residuo e disciplina de proveniencia e nao deteccao, o que e o motivo de o registro de proveniencia guardar o texto do LICENSING.md e nao apenas o seu SHA.
