# ADR 0068: O typecheck de arvore nova entra pela segunda invocacao no script da raiz, nao por gate novo no manifesto

## Context

A arvore do cliente web (webui/) precisa de typecheck com lib DOM, enquanto a raiz roda sem DOM (lib ESNext, types bun). O tsconfig da raiz nao tem include nem files, so exclude, entao hoje ele ja alcanca qualquer arvore nova e quebraria em globais de DOM; a arvore precisa ser excluida da raiz, o que a deixa sem typecheck nenhum se nada mais a cobrir. Tres rotas foram medidas em 2026-08-13. (1) Registrar um gate typecheck:ui novo no manifesto GATES. (2) Migrar a raiz para tsc --build sobre um solution file com project references. (3) Fazer o proprio script typecheck da raiz rodar os dois programas encadeados.

## Decision

Adotada a rota (3): o script typecheck da raiz roda tsc --noEmit seguido de tsc -p webui/tsconfig.app.json --noEmit, encadeados de modo que qualquer um dos dois reprovando derruba o gate inteiro. Nenhum gate novo e registrado. O comando do gate typecheck existente no manifesto GATES e re-apontado para bun run typecheck, para que check:all e o CI passem pelo script da raiz. Sem esse re-apontamento, o manifesto continuaria a executar apenas bunx tsc --noEmit e a segunda invocacao ficaria inerte no CI.

## Consequences

A rota (1) foi recusada porque o registro no manifesto e um passo esquecivel e esquecer e invisivel: check-ci-parity so quantifica sobre nomes que ja estao em GATES, sua Rule 2 e codigo morto porque o ci.yml roda bun run check:all (hasSpine verdadeiro), e check:all esta no allowlist da Rule 1. Um script fora do manifesto nunca roda e nada acusa. A rota (2) foi recusada porque, embora composite mais noEmit sob tsc --build funcione no TS 5.9.3 e pegue erro real, ela escreve tsconfig.tsbuildinfo (2002 bytes medidos) e --build pula projeto que julga up-to-date, introduzindo verde-pelo-motivo-errado no comando mais invocado do repo. A rota adotada custa cerca de 3 segundos a mais no gate (a raiz mede 3,3 segundos hoje) e faz o erro chegar de dois programas em sequencia, sem prefixo distinguindo qual reclamou. O criterio que prova que a segunda invocacao nao e decorativa precisa ser discriminante: o oraculo obvio (erro de tipo em webui derruba bun run typecheck) e verde na main por construcao, porque a raiz ja cobre a arvore hoje, medido saindo exit 2; a forma valida exige raiz-sozinha verde e script-completo vermelho.
