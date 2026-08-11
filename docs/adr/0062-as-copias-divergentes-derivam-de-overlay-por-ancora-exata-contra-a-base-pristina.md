# ADR 0062: As copias divergentes derivam de overlay por ancora exata contra a base pristina

## Context

Quatro documentos precisam mesmo de duas versoes, porque a copia do repo nomeia a stack do cam-cli enquanto a que shipa precisa servir qualquer projeto. A medicao da forma da divergencia decidiu o mecanismo: as quatro compartilham de 83,8 a 98,6 por cento das linhas, e tres delas divergem em blocos contiguos de secao, mas a persona do reviewer diverge em 18 hunks dos quais 11 sao substituicoes de uma unica linha espalhadas pelo documento inteiro, trocando o nome de um comando no meio da prosa. Overlay ancorado em secao nao cobre esse caso sem duplicar o resto da secao, reintroduzindo a duplicacao que se queria eliminar. Slots com marcador no template cobririam, ao custo de editar o template, mudar o conteudo embarcado e mudar o contrato de adaptacao downstream. Manter dois documentos com gate apenas sobre a espinha compartilhada foi descartado por conservar a sincronizacao manual que causou o problema.

## Decision

A copia do repo passa a ser gerada a partir da base em templates/ mais um overlay que declara pares de substituicao de string exata, e a saida e commitada com gate --check. O gerador falha quando uma ancora casa zero vezes ou mais de uma vez, e todo casamento e feito contra a base nao modificada, com todas as ancoras resolvidas antes de qualquer escrita. A base nao e tocada: nenhuma edicao em templates/, nenhuma mudanca no conteudo embarcado, nenhuma mudanca no instalador.

## Consequences

No trecho compartilhado o drift fica impossivel, porque ele e regenerado. No trecho divergente ele fica fail-closed: uma edicao no template que mova a frase ancorada quebra o gerador em vez de divergir em silencio, o que transforma a ancora em detector no instante da edicao. Editar a persona viva do projeto passa a ser editar o overlay, e o arquivo gerado carrega cabecalho declarando isso. A reconciliacao previa derruba o overlay de 39 hunks para 22 pares, e seis dessas ancoras exigem a forma longa porque a curta casa mais de uma vez. Fica registrado um limite honesto: a fronteira do overlay e o que difere, e nao stack-especifico contra agnostico, porque a base ja vaza 22 linhas nomeando bun, tmux e caminhos do cam-cli em texto compartilhado e nao-divergente. Tornar essa fronteira principiada e trabalho separado, rastreado em CAM-533; sem esta declaracao um leitor futuro assume que a linha ja e principiada e re-introduz drift argumentando coerencia.
