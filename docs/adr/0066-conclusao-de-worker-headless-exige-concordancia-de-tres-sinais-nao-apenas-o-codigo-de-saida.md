# ADR 0066: Conclusao de worker headless exige concordancia de tres sinais, nao apenas o codigo de saida

## Context

Ao migrar papeis de worker para execucao headless como processo filho, foi preciso definir como o supervisor decide que uma execucao terminou com sucesso. Tres fontes de evidencia estavam disponiveis e foram medidas em 2026-08-12.

A documentacao oficial do Claude Code afirma que o processo sai com codigo 0 em caso de sucesso e nao-zero em caso de falha, com a recomendacao literal de que scripts ramifiquem pelo status de saida, e documenta que o formato de saida em stream emite um evento result como ultima linha. Ela NAO especifica se um evento de erro pode coexistir com saida zero, nao publica o vocabulario completo de subtipos, e nao documenta nenhum heartbeat.

O prior art disponivel foi o par warren e burrow, projeto irmao do operador. A medicao do codigo deles mostrou dois oraculos de conclusao independentes que podem discordar: burrow decide por codigo de saida e nunca le o evento terminal; warren decide pelo evento terminal e nunca le o codigo de saida, a ponto de nao existir coluna para ele. A direcao perigosa foi medida: filho que sai nao-zero depois de ter emitido um evento terminal limpo e pontuado como sucesso, e o crash fica invisivel. O proprio levantamento recomendou escolher um unico oraculo ou exigir concordancia entre os dois.

Um terceiro dado tornou a questao concreta em vez de teorica. O CLI de codex, que este projeto pretende suportar como backend de primeira classe, carrega um defeito aberto em que a execucao sai com status 0 e zero bytes de saida quando o stdio esta destacado de terminal e o prompt e longo, reportado explicitamente como quebra de orquestracao por processo-pai.

## Decision

Uma execucao de worker headless so e reconhecida como concluida quando tres sinais concordam: o evento terminal foi observado no stream, o processo filho saiu com codigo zero, e o artefato de papel esta presente e valido no schema. Qualquer combinacao divergente produz um desfecho nomeado, signal-disagreement, que carrega os sinais observados, nao produz veredito de papel, e preserva o artefato como evidencia forense.

A divergencia nao e resolvida por precedencia. Nao existe regra de que um sinal vence outro.

## Consequences

O contrato resiste por construcao ao defeito de fornecedor citado no contexto: saida zero sem evento terminal e classificada como falha, nao como sucesso, sem que nada especifico daquele defeito precise ser codificado.

Uma alternativa considerada e rejeitada foi tratar o artefato de papel como vencedor mesmo sobre codigo de saida nao-zero, com o argumento de que o papel pode escrever seu report e morrer logo depois, e descartar o report custaria repetir trabalho longo. Foi rejeitada porque o estado que a produz e tipicamente o agente escrever o artefato e entao esbarrar em limite de turnos: o artefato passa no guarda de schema e ainda assim pode estar semanticamente incompleto, por exemplo um reviewer que examinou parte dos arquivos e devolveu veredito limpo. Aceitar veredito terminal sobre saida nao-zero e fail-open, e este projeto ja registrou um caso de PRD shipado com aprovacao sobre oraculo vermelho.

A alternativa de seguir a documentacao ao pe da letra, decidindo apenas pelo codigo de saida, foi rejeitada porque nao detecta stream truncado, que e exatamente a forma do defeito de fornecedor medido. A alternativa de decidir apenas pelo evento terminal foi rejeitada porque e a metade do desenho de warren que produz a direcao perigosa medida.

O custo aceito e que o supervisor passa a ter mais desfechos nomeados para tratar do que um par sucesso e falha, e que uma execucao legitima que perca um dos tres sinais por razao benigna sera reclassificada como divergencia e exigira nova rodada. Esse custo foi aceito conscientemente: em um sistema onde o ator julgado nao pode escrever o proprio oraculo, falso negativo custa uma repeticao e falso positivo custa um defeito shipado.

O contrato e neutro de backend. O nome concreto do evento terminal e a semantica de codigo de saida sao especificos de cada ferramenta de agente e ficam confinados na camada de classificacao de stream, sem vazar para o supervisor.
