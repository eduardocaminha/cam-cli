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
