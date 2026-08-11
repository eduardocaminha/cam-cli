# ADR 0061: Copias identicas de template colapsam em symlink, nao em geracao com gate de drift

## Context

O repositorio mantinha templates/ e as copias instaladas (.claude/, scripts/cam/) como dois conjuntos de documentos editados a mao. A duplicacao nao era acidental: estava escrita como politica em scripts/cam/patterns.md, que mandava toda story que edita prompt de agente editar as duas copias e pedia que o commit declarasse a intencao para o auditor nao sinalizar. A taxa de falha dessa politica foi medida: 117 commits tocaram templates/, 118 tocaram as copias instaladas, 100 se sobrepoem, ou seja 35 edicoes de um lado so, cerca de 26 por cento. O efeito nao era hipotetico: a persona do orquestrador deste repo bootava cega para um marcador de falha vivo que existia apenas no template, enquanto o template mis-documentava um comando variadico ja shipado. Dos 27 pares, 15 eram byte-identicos e mais 3 (os schemas) so divergiam por drift puro. A alternativa considerada foi gerar a copia do repo a partir do template, commitar a saida e vigiar com um gate --check, forma que o repositorio ja domina no embed-vendor:check.

## Decision

Os pares que devem ser identicos passam a ser um unico arquivo: a copia instalada vira symlink rastreado pelo git apontando para o arquivo em templates/. Um gate de integridade afirma as duas direcoes, que esses caminhos estao no indice como link e resolvem para o alvo pretendido, e que os arquivos semente-contra-vivo continuam sendo arquivos independentes. A geracao com gate foi recusada porque deixa aberta a janela entre editar e rodar o gerador, enquanto o link nao tem janela: e o mesmo inode.

## Consequences

Drift deixa de ser detectavel para ser impossivel nesses caminhos, e o gate que sobra e pequeno porque vigia apenas o que nao pode ser eliminado. O custo aparece em quatro pontos medidos. Estes sao os primeiros symlinks rastreados do repositorio, e o suporte do runner de CI nao estava verificado. Uma ferramenta que edite por rename atomico substitui o link por arquivo regular em silencio, que e a razao de o gate de integridade existir mesmo com o colapso feito. Bun.Glob.scanSync omite symlink com opcoes default, medido em 1 de 458 entradas num diretorio com 457 links, o que teria tirado duas personas da superficie de varredura do gate agents-md sem deixar o gate vermelho. E o bit de execucao do hook de allowlist precisa ser movido para o alvo em templates/ antes de o link ser criado, porque o alvo era 100644 enquanto a copia viva era 100755, e inverter a ordem desliga o allowlist da propria sessao que faz a mudanca.
