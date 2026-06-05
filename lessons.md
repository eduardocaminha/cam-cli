# lessons.md (cam-cli)

Diário cronológico de descobertas. A regra acionável de cada entrada vive no local canônico apontado nela.

## 2026-06-05: comentário de código não é prova de comportamento visual

Situação: ao alinhar as telas de print ao vocabulário das telas Ink, decidi (e afirmei ao usuário) que a Section de fecho das telas de operação teria divisor colorido (verde no sucesso, vermelho na falha), "espelhando o All set / Failed do Ink init". A base foi o comentário de cabeçalho de `src/ui/InitScreen.tsx`, que dizia "success Section, accent divisor" e "destructive Section".

Achado: o código real do InitScreen chama `<Section heading="All set">` sem passar `tone`, então o divisor renderiza cinza (muted). Nenhum componente Ink colore divisor. Sucesso e falha são sinalizados pelo glifo (✓ accent, ✗ destructive) na linha de conteúdo, nunca pela cor do divisor. Resultado: o `cam stop` saiu com um divisor verde, o único colorido em todo o projeto, e destoou de todas as outras telas. O usuário pegou pelo screenshot, eu não tinha verificado o render real.

Correção aplicada: removida a infra de `tone` colorido que adicionei ao print path (`src/logging/screen.ts`), `cam stop` voltou a usar divisor cinza, e os comentários enganosos do InitScreen foram corrigidos.

Regra (local canônico): `~/.claude/CLAUDE.md` §"Lições persistentes".
