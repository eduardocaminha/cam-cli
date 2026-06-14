# lessons.md (cam-cli)

Diário cronológico de descobertas. A regra acionável de cada entrada vive no local canônico apontado nela.

## 2026-06-05: comentário de código não é prova de comportamento visual

Situação: ao alinhar as telas de print ao vocabulário das telas Ink, decidi (e afirmei ao usuário) que a Section de fecho das telas de operação teria divisor colorido (verde no sucesso, vermelho na falha), "espelhando o All set / Failed do Ink init". A base foi o comentário de cabeçalho de `src/ui/InitScreen.tsx`, que dizia "success Section, accent divisor" e "destructive Section".

Achado: o código real do InitScreen chama `<Section heading="All set">` sem passar `tone`, então o divisor renderiza cinza (muted). Nenhum componente Ink colore divisor. Sucesso e falha são sinalizados pelo glifo (✓ accent, ✗ destructive) na linha de conteúdo, nunca pela cor do divisor. Resultado: o `cam stop` saiu com um divisor verde, o único colorido em todo o projeto, e destoou de todas as outras telas. O usuário pegou pelo screenshot, eu não tinha verificado o render real.

Correção aplicada: removida a infra de `tone` colorido que adicionei ao print path (`src/logging/screen.ts`), `cam stop` voltou a usar divisor cinza, e os comentários enganosos do InitScreen foram corrigidos.

Regra (local canônico): `~/.claude/CLAUDE.md` §"Lições persistentes".

## 2026-06-05: bun test verde não prova type-safety

Situação: no pré-voo do /cam-next para US-009, `bun run typecheck` falhou com 6 erros TS2322 em `test/attach-hint.test.ts` (callbacks `() => runX({...})` retornam `Promise<number>`, incompatível com o parâmetro `() => void | Promise<void>` do helper `captureStdout`). O implementer de US-008 reportou "typecheck ok" e commitou o arquivo assim mesmo.

Achado: `bun test` roda a suíte verde mesmo quando `tsc --noEmit` falharia, porque o runner não faz type-check completo. Teste verde não é prova de type-safety; o claim "typecheck ok" do implementer escapou porque a suíte passava. Captura de lição reforça o que já estava na CLAUDE.md (Verification Before Done), mas o mecanismo (verdura do bun test mascara erro de tsc) é o detalhe acionável.

Correção aplicada: o parâmetro de `captureStdout` foi alargado para `() => unknown` (o resultado é await-ado e descartado de qualquer forma), zerando os 6 erros sem tocar nos call sites.

Regra (local canônico): `scripts/cam/progress.txt` §"Codebase Patterns" e `scripts/cam/CLAUDE.md` §"Quality Gates" (rodar `bun run typecheck` e confiar no exit code, nunca inferir type-safety da verdura do `bun test`).

## 2026-06-06: binário bun --compile no macOS trava em /usr/local/bin por assinatura inválida

Situação: testando o US-010 (smoke do `cam run` no terminal real), o comando `sudo cp dist/cam-darwin-arm64 /usr/local/bin/cam && cam run` resultou em "zsh: killed". A suspeita inicial foi tmux, mas o tmux estava saudável (3.6a, new-session exit 0).

Achado: `bun build --compile` (macOS arm64) gera um binário cuja assinatura o `codesign -v` marca como inválida ("code or signature have been modified"). O MESMO binário (sha idêntico) roda normal em local user-owned (`dist/`, `~`, `/tmp`), mas em `/usr/local/bin` (root, diretório de sistema) o amfid faz validação síncrona no exec, o processo trava de forma uninterruptível (nem `kill -9` derruba até o amfid soltar) e o SO mata. Re-assinar ad-hoc (`codesign --force --sign -`) deixa o `codesign -v` válido e o binário roda em qualquer destino. Bônus: o `build-release.sh` rodava `cam init` como soft-check dentro do repo, sobrescrevendo a config adaptada (4 subagents + `scripts/cam/CLAUDE.md`) com os templates e tentando spawnar tmux; verificação de build não pode mutar o working tree.

Regra (local canônico): `~/.claude/CLAUDE.md` §"Lições persistentes". Fixes robustos rastreados em CAM-16 (re-sign no build/install) e CAM-15 (soft-check do build-release.sh hermético).

## 2026-06-08: binário cam do PATH pode estar defasado do branch (runaway do stop-hook aposentado)

Situação: pré-voo do /cam-next para US-011. O branch CAM-22 já tinha aposentado o stop-hook driver (US-007) e `src/commands/next.ts` era o supervisor TS novo. Rodei `cam next` (de /usr/local/bin/cam) esperando o gate side-effect-free do supervisor novo ("Worker pane not allocated").

Achado: o binário instalado estava defasado (buildado de um commit anterior ao US-007). Ele executou a arquitetura VELHA: materializou o stop hook, registrou o Stop hook em settings.local.json, armou cam-loop.local.md e spawnou uma sessão claude num tmux session, um runaway do loop aposentado. Pior, o Stop hook registrado dispararia no meu próprio turno. Tive que `tmux -L cam kill-server` e remover os 3 artefatos. Eu li o source do branch mas o runtime era outro binário (eco da lição de 2026-06-05). Sondar arquitetura sem executar: `strings <bin> | grep -c "Materialized stop hook"` (velho) vs `"Worker pane not allocated"` (novo).

Bônus 1 (colisão de concorrência): durante a run, uma sessão `cam run` paralela (humana, no mesmo repo) interleavou o US-011, meu worker fez o feat commit (9eba219), o worker da sessão paralela fez o flip (e8f1012). Antes de dirigir o loop, checar sessões tmux/orchestrator paralelas no socket cam. Dois drivers no mesmo repo é colisão garantida.

Bônus 2 (handshake worker->supervisor): a primeira run real do supervisor reportou um worker que TEVE SUCESSO como `unknown`/blocked, porque o pane do worker morre no instante em que sinaliza o wait-for, e o capture-pane do supervisor lê pane morto. Detalhe e direção de fix em CAM-32.

Regra (local canônico): `~/.claude/CLAUDE.md` §"Lições persistentes" (dogfooding de CLI compilada: o binário do PATH pode lagar o branch; rebuildar+reinstalar com re-sign ANTES, ou rodar via `bun index.ts <cmd>` direto do source). Bugs do supervisor em CAM-32.

## 2026-06-09: review deve rodar antes da cerimônia operator (decide.ts bloqueava; corrigido pra Interpretação B)

Situação: pré-voo do /cam-next com US-001 a US-017 todas passes:true e só US-018 (requires:operator, cerimônia E2E manual) em passes:false, `review:null`. Rodei o `decideNextAction` real sobre o prd.json e voltou `blocked-no-implementable`, não `review`. Três docs afirmavam que, com as não-operator todas verdes, o supervisor "dispara o review cycle": `cam-next.md` (linha PRD_COMPLETE), as notes da US-018 no prd.json, e a "Stop Condition" do `scripts/cam/CLAUDE.md`.

Achado: `src/supervisor/decide.ts` (passo 2, linhas 89-91) trata história operator-pendente como bloqueante e retorna `blocked-no-implementable` ANTES do passo de review/complete. A decisão foi deliberada na implementação da US-005 e está registrada em `scripts/cam/progress.txt:264` ("operator-pending stories block autonomous loop progression"). Ou seja: o review automático NÃO roda enquanto a US-018 estiver em passes:false; o operador precisa fazer a cerimônia, virar a US-018 pra passes:true na mão, e só então re-rodar `cam next` para o review disparar. Eco da lição de 2026-06-05: a doc (contrato) divergia do runtime (decide.ts), e o runtime é a verdade.

Correção aplicada: primeira rodada eu propus só reconciliar os docs ao decide.ts (tratar o bloqueio como canônico). O Eduardo perguntou "isso é correto pensando em resolver o problema?", o que expôs a falha de ordem: a US-018 é uma verificação E2E do próprio supervisor, o review pode mudar o código do supervisor, logo o review TEM que rodar antes da cerimônia (senão a cerimônia valida código que ainda vai mudar). Além disso o critério 5 da própria US-018 ("confirm the review worker runs") pressupõe observar o review, e `review:null` significava que as 17 histórias nunca tinham sido revisadas. Decisão: corrigir o decide.ts (Interpretação B). Reordenado `decideNextAction`: (1) non-operator passes:false -> implement; (2) non-operator todas passam e review não-terminal -> review (operator-pendente NÃO bloqueia); (3) review terminal e operator pendente -> novo estado `await-operator` (carrega `pendingStoryIds`); (4) tudo passa incl. operator e review terminal -> complete. Novo `SupervisorStatus 'awaiting-operator'` em loop.ts (sucesso, não bloqueio) e exit 0 em next.ts com hint de handoff. `blocked-no-implementable` virou só o guard degenerado (história sem id). Docs reconciliados PARA B (não para o bloqueio): `cam-next.md` (tabela Branch decision + PRD_COMPLETE), notes da US-018 no prd.json, "Stop Condition" do `scripts/cam/CLAUDE.md`. Pendência ainda aberta: `templates/commands/cam-next.md` descreve a arquitetura stop-hook aposentada (gap da US-010), follow-up separado.

Regra (local canônico): `scripts/cam/progress.txt` §"Codebase Patterns" (bullet "Operator stories do NOT block review") e a tabela Branch decision de `.claude/commands/cam-next.md`. Regra acionável: história `requires:operator` incompleta NÃO bloqueia o review; o loop implementa tudo, roda review até verdict terminal, e só então sai em `awaiting-operator` (exit 0) entregando a cerimônia ao operador. Lição transversal de processo: reconciliar doc ao código é tratar sintoma; quando o doc e o código divergem, perguntar qual dos dois está CERTO sobre a intenção antes de alinhar (aqui o doc estava certo, o código errado).

## 2026-06-09: claude -p buffera (quieto != morto) + worker silent no-op (CAM-36 spin, CAM-37 review)

Situação: marathon de dogfood dirigindo o loop autônomo (`cam next` / `bun index.ts next`) pra fechar o CAM-28 (dashboard liveness, US-001 + US-002). Ao monitorar os workers headless, a tela do supervisor ficava parada com o cursor piscando e o out-log 0 bytes por minutos; diagnostiquei "travado/morto" várias vezes e o Eduardo corrigiu cada uma ("n fiz nada, continua piscando").

Achado 1 (diagnóstico): `claude -p` buffera o stdout até o fim da sessão, então pane vazio + out-log vazio + `pane=zsh` são o estado NORMAL de um worker trabalhando, não morte. O sinal de vida real é o mtime do transcript da sessão (`~/.claude-pessoal/projects/<slug>/<uuid>.jsonl`), que cresce a cada tool call. Também errei cortando `ps | head -N` e declarando o supervisor morto quando ele estava só fora do head.

Achado 2 (dois bugs reais do supervisor, mesma classe "worker no-opa silencioso"): um `claude -p` que sai instantâneo (sem transcript) faz o `readWorkerOutcome` state-primary reportar pass stale da última história. (a) CAM-36: o implement path spinava re-dispachando a mesma história passes:false até MAX_ITERATIONS (26-30 dispatches em 18s); fix = guard de no-progress (bloqueia após 2 passes sem avanço no PRD). (b) CAM-37: o review path não tinha out-log nem retry, então um reviewer no-op bloqueava o loop na hora (matou a iteração 2 do run de US-002, Blocked com tudo passando); fix = out-log durável pro reviewer + retry bounded, espelhando o implementer. Bônus: o cam-review pegou um CRITICAL de integração (o guard do CAM-36, ao mergear no CAM-28, retornava blocked sem `notifyTerminal`, deixando state file stale).

Regra (local canônico): MEMORY.md detail files [[claude-p-buffers-transcript-liveness]] (diagnóstico) e [[worker-silent-noop-resilience]] (CAM-36/37 + how-to). Fixes shipados em PR #19 (CAM-36) e #21 (CAM-37); CAM-28 em #20.

## 2026-06-10: wake espurio do tmux wait-for lido como sinal; supervisor bloqueou com worker vivo

Situação: dogfood do CAM-16. O supervisor despachou o worker de US-001 e o `tmux wait-for` retornou 28min depois SEM ninguém ter sinalizado o canal (o claude do worker ainda estava vivo: transcript quente, commit e out-log com sentinel DONE chegaram 5 min depois). O adapter waitFor de src/commands/next.ts só checa result.signal, nunca result.status, então qualquer saída anômala do client tmux vira "sinalizado". O supervisor leu pane vazio (claude -p buffera) + handoff inexistente, deu outcome unknown e bloqueou. O trabalho da story completou perfeito depois, com o sinal real perdido (sem waiter).

Achado: wake de wait-for não é prova de sinal, e outcome unknown não é prova de worker morto. Antes de bloquear, checar liveness (pane vivo / mtime do transcript) e re-armar o wait com o budget restante. A mesma lição do diagnóstico humano (pane quieto não é morte) vale pro código do supervisor.

Regra (local canônico): issue CAM-39 em scripts/cam/issues.local.json (fix: waitFor com estado triplo signaled|timeout|error + re-arm em unknown com pane vivo).

## 2026-06-13: close de issues irmas no issues.local.json nao landou (atropelo entre commits)

Situacao: no ciclo CAM-42 fechei CAM-39/40/41 (superseded) + CAM-42 (shipped) num passo python, e tambem appendei CAM-43/44 em outros commits do mesmo branch. Apos o merge (PR #31), os appends landaram mas os closes NAO: CAM-39/40/41/42 voltaram a aparecer como open no main. O commit de close nao existe no historico squashado.

Achado: edits de scripts/cam/issues.local.json espalhados por varios commits do MESMO branch se atropelam quando um rewrite python posterior carrega um snapshot anterior ao close (load-modify-write nao-atomico, sem rebase do estado intermediario). A etapa de close do cam-ship cobre/testa so a issue PRIMARIA do PRD; closes de issues IRMAS (superseded) sao manuais e nao tem gate.

Regra (acionavel): (1) fazer todos os edits de issues.local.json (close primario + closes de irmas + appends de follow-ups) num UNICO commit por ciclo, nunca espalhados; (2) apos merge de um PR cam, VERIFICAR no main que as issues que deviam fechar estao closed (jq filter), nao confiar que o commit pegou. Local canonico: este lessons.md (workflow do projeto).

## 2026-06-13: build smoke hermetico (CAM-15) implementa a regra do 2026-06-06

Situacao: o AC4 do scripts/build-release.sh rodava `cam init` com cwd no REPO_ROOT como soft-check de build. `cam init` encadeia runSetup, que copia templates por cima dos arquivos versionados (relativo ao cwd) e, sem --no-tmux, spawna sessao tmux + agente claude. Mordeu o operador 2x (clobber de 10 arquivos versionados + sessao cam-setup com claudes vivos; recovery via git restore + kill).

Achado: a regra ja estava registrada no 2026-06-06 ("smoke nunca roda comando mutante contra o repo; usar cwd temporario"), mas o AC4 nunca foi consertado. Fix (CAM-15): rodar o smoke num mktemp -d como cwd, com binario por path absoluto, `init --no-tmux --existing --issue-system none </dev/null` (as flags zeram o wizard interativo do collectSetupAnswers; so --no-tmux nao basta, ele ainda bloquearia nas perguntas), trap de rm -rf no EXIT. Guard estatico em test/build-release-smoke.test.ts assere a hermeticidade pra travar regressao. Validado em runtime: ./scripts/build-release.sh deixa git status intacto.

Regra (local canonico): a regra-mae vive no ~/.claude/CLAUDE.md "Licoes persistentes" / lessons.md 2026-06-06. Esta entrada so confirma que o cam-cli agora a cumpre, e que --no-tmux sozinho e insuficiente (precisa das flags de modo+issue pra nao-interatividade).

## 2026-06-14: issues pre-CAM-42 precisam de verificacao de arquitetura viva antes de implementar

Situacao: ao fechar o backlog, varias issues filadas antes do CAM-42 (migracao pra TUI + sentinel) propunham mecanismos que a arquitetura posterior tornou proibidos ou desnecessarios. CAM-4 (eventos estruturados via -p stream-json): -p proibido + terminacao/outcome ja state-primary -> re-escopo pra limpeza + doc. CAM-5 (--max-turns/--max-budget-usd): print-mode-only (exigem -p) -> re-escopo pra teto de tokens via poll do transcript. CAM-31 (aposentar progress.txt): valida, mas o framing citava progress.txt como vivo. CAM-12 (approve via flag-file): o objetivo (decisao concentrada no orquestrador) ja e atendido pelo dispatch SlashCommand in-session -> fechada como superseded.

Achado: o campo description de uma issue de backlog reflete o estado do mundo na data em que foi filada, nao hoje. Para qualquer issue anterior a uma mudanca arquitetural grande (aqui: CAM-42), o mecanismo proposto pode estar (a) proibido por uma regra que entrou depois, (b) ja implementado por outro caminho, ou (c) obsoleto. Sempre verificar o codigo/fluxo VIVO no Step 3/4 do plan antes de gerar PRD; nunca planejar contra a description stale. Quando o mecanismo evaporou, o caminho honesto e re-escopar (entregar o espirito pelo meio disponivel) ou fechar como superseded com rationale, nao implementar o caminho morto.

Regra (local canonico): este lessons.md (workflow do projeto). Reforca a regra universal ja em ~/.claude/CLAUDE.md sobre comentario/descricao nao provar comportamento (lição 2026-06-05): vale tambem pra issues de backlog, nao so comentarios de codigo.

## 2026-06-14: next_id stale por filagem manual colide com cam issue; cam run vivo e multi-writer no working tree

Situacao: ao zerar o backlog filei CAM-39..47 editando scripts/cam/issues.local.json a mao (ids explicitos) sem avancar o campo next_id, que ficou stale em 39 enquanto as issues iam ate 47. Durante o dogfood do cam run (CAM-47), o orquestrador rodou /cam-issue create e alocou o id a partir de next_id=39, colidindo com a CAM-39 ja fechada: o issues.local.json passou a ter duas CAM-39 (uma closed, uma open). A colisao so apareceu quando o passo de bookkeeping reportou CAM-39 como open de novo. Alem disso, essa sessao cam run viva escreveu no MESMO issues.local.json do working tree em que eu estava commitando o branch do CAM-47 (dois escritores concorrentes no mesmo arquivo).

Achado: (1) cam issue / /cam-issue create alocam o id a partir de next_id e bumpam; filagem MANUAL com id explicito que nao avanca next_id deixa o contador stale e a proxima alocacao automatica colide com um id existente. (2) Um cam run ativo e um escritor de issues.local.json (via /cam-issue), concorrente com qualquer edicao manual no mesmo working tree.

Regra (local canonico): scripts/cam/patterns.md (gotcha durável de issues.local.json: avancar next_id ao filar a mao; nao hand-editar com sessao cam run viva). Reforca a regra de 2026-06-13 (todos os edits de issues.local.json num unico commit + verificar no main pos-merge): some-se o invariante de next_id e a hipotese single-writer.
