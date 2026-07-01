# ADR 0005: Verificacao comportamental como gate compartilhado com veredicto independente do reviewer

- **Status**: aceito (implementado em CAM-116)
- **Data**: 2026-07-01

## Contexto

A verificacao comportamental do cam (exercitar a TUI via tmux real, capturar o pane, comparar com criterios esperados) nasceu como ferramenta exclusiva do implementer: a capacidade `runBehavioralGate` foi construida em `src/supervisor/behavioral-gate.ts` e documentada como "Layer A, self-correct, non-official" nos agentes. O reviewer, responsavel pelo veredicto definitivo, nao tinha acesso a esse mecanismo e produzia apenas um parecer textual sem evidencia reproducivel.

Tres gates definem quando uma decisao merece um ADR:

1. **Dificil de reverter**: separar "quem executa o gate" de "quem produz o artefato oficial" afeta o contrato do reviewer agent (`scripts/cam/review-report.json` ganha campo `artifactOfRecord?: string`), o template do reviewer (`templates/agents/subagent-reviewer.md`), a instrucao do implementer (Layer A agora e explicitamente auto-correcao nao-oficial), o step de ship (`cam-ship.md` le `scripts/cam/review-artifact.txt` e posta como comentario no PR), e a convencao de gitignore (dois arquivos efemeros, nao commitados). Reverter exigiria desfazer todos esses contratos em quatro modulos distintos.

2. **Surpreendente sem contexto**: o padrao mais simples seria o reviewer recriar sua propria logica de verificacao independente do implementer, ou confiar apenas na leitura do codigo. A escolha de COMPARTILHAR o harness tmux-real (o mesmo `runBehavioralGate` / `test/integration` que o implementer usa) e NAO commitar o artefato (apenas postar no PR como comentario) parece, sem contexto, inconsistente: se o gate e compartilhado, por que o artefato nao e versionado no repo? A resposta e que o artefato e evidencia de execucao ephemera (varia por ambiente, nao por logica), nao convencao de codigo; commitar artefatos de captura de terminal polui o historico git sem ganho de rastreabilidade.

3. **Trade-off genuino**: o modelo alternativo (verificacao exclusiva do implementer, reviewer confia no green do implementer) e mais simples de implementar e remove a dependencia do reviewer de tmux. Em troca, perde o principal beneficio: o veredicto definitivo passa a depender da honestidade do implementer com si mesmo, o que e exatamente o que a separacao Layer A / Layer B visa evitar. A independencia do reviewer so e real se o reviewer executa os gates de forma autonoma; do contrario o reviewer e apenas um leitor de codigo sem poder de falsificacao.

## Decisao

A verificacao comportamental e um **gate compartilhado e reproducivel**, executado independentemente por dois agentes com responsabilidades distintas:

- **Layer A (implementer)**: executa `runBehavioralGate` localmente como ciclo de auto-correcao. O resultado e informativo: se o gate falha, o implementer corrige a implementacao e re-executa. O output do Layer A NAO e o artefato oficial.

- **Layer B (reviewer)**: executa o mesmo harness (`runBehavioralGate` / `test/integration`) de forma independente, sem ver o output do Layer A. O resultado do reviewer e o **veredicto definitivo**. A saida capturada (capture-pane do tmux, resultado do oracle) e o **artefato-de-registro**: salvo em `scripts/cam/review-artifact.txt` (gitignored), postado como comentario no PR via `gh pr comment --body-file`, nunca commitado no repositorio.

O harness subjacente e o modulo `src/supervisor/behavioral-gate.ts` (construido em CAM-116 US-002), ancorado nos testes de integracao reais de `test/integration/` que exigem um servidor tmux real. Oracles declarativos nos `acceptanceCriteria` das user stories (`[oracle: named-command ...]` e `[oracle: file-assert ...]`) descrevem o comportamento esperado de forma reproducivel; oracles `reviewer-judgment` e `no-oracle` sao pulados por ambas as camadas.

## Consequencias

- **Artefato no PR, nao no repo**: `scripts/cam/review-artifact.txt` e `scripts/cam/review-report.json` sao gitignored em `.gitignore` e `templates/.gitignore`. O step de ship (`cam-ship.md`) le o arquivo e posta como comentario no PR (best-effort: falha nao aborta o ship). O historico de artefatos vive nos comentarios do PR, nao no log git.

- **Reviewer depende de tmux**: o reviewer agent precisa de um servidor tmux acessivel para executar o Layer B. Ambientes sem tmux (CI puro, containers sem unix socket) nao podem executar o Layer B; nesses ambientes o oracle retorna `passed: false` com detalhe `"tmux unavailable"` e o reviewer cai no fallback de leitura de codigo. A questao de isolar o tmux dentro de um container com `seccomp` adequado foi adiada (ver CAM-152).

- **Artefatos de imagem nao suportados**: o `runBehavioralGate` atual captura texto via `tmux capture-pane`. Verificacao de artefatos visuais (screenshots de UI web, imagens geradas por agentes) exigiria uma camada adicional (playwright, agent-browser). Esse downstream de imagens e um forward reference postergado para uma story futura.

- **Independencia Layer A / Layer B e uma convencao, nao enforcement tecnico**: nada impede o implementer de copiar sua propria captura como "artefato de Layer B". A garantia vem do contrato operacional (o reviewer agent e instruido a executar de forma independente) e da visibilidade do PR (o comentario de artefato e publico). Enforcement tecnico mais forte (sandbox de worker, isolamento de filesystem) e o escopo do CAM-152 e das historias de container preflight (CAM-150).

## Alternativas descartadas

- **Verificacao exclusiva do implementer (reviewer confia no green do Layer A)**: o reviewer leria apenas o codigo e o output de gates estaticos (typecheck, tests), sem executar os oracles comportamentais de forma independente. Rejeitada: a separacao Layer A / Layer B perde todo o significado se o veredicto definitivo depende do mesmo agente que produziu a implementacao. O reviewer seria um leitor de codigo, nao um verificador independente. Essa alternativa foi a pratica pre-CAM-116 e foi explicitamente identificada como gap (CAM-116 issue).

- **Artefato commitado no repositorio**: salvar `review-artifact.txt` no repo (versionado, nao gitignored). Rejeitada: capturas de terminal variam por ambiente (resolucao de pane, versao do tmux, velocidade de renderizacao), produzindo diffs de ruido que poluem o historico git. O artefato e evidencia de execucao, nao convencao de codigo. O local correto e o comentario do PR, onde e visivel para revisao humana e descartado apos o merge.

- **Reviewer com logica de verificacao propria (nao compartilhar o harness)**: o reviewer implementaria sua propria forma de verificacao comportamental, independente de `runBehavioralGate`. Rejeitada: dois harnesses divergentes criam drift de criterios ao longo do tempo. O valor do gate compartilhado e exatamente que implementer e reviewer aplicam o MESMO criterio de passagem; divergencia de harness significaria que "passou no Layer A" e "passou no Layer B" poderiam ter semanticas diferentes.

---

*Preocupacoes adiadas registradas acima: (1) artefatos de imagem / playwright / agent-browser (downstream web); (2) isolamento de container com seccomp e unix socket para tmux (CAM-152).*
