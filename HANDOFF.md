# HANDOFF: testar os fluxos com o vocabulário Ink já alinhado

Documento de continuidade para uma nova conversa numa branch nova. Lê isto + `lessons.archive.md` + `src/design/tokens.ts`. Não precisa reler o histórico de chat.

## Onde estamos

O alinhamento das telas de print ao vocabulário Ink está COMPLETO e mergeado em `main` (commit `9bc6b32`, push feito em `origin/main`). Duas fases:

- Fase 1 (`279ce2f`): design-system único em `src/design/tokens.ts`; `status` e `stop` alinhados; print path (`color.ts`, `screen.ts`, `help.ts`) e Ink (`theme.ts`, `Section.tsx`) derivam dos tokens.
- Fase 2 (`9bc6b32`): `resume`, `run`, `next`, `plan` alinhados; `previewRun`/`previewNext`/`previewPlan` no harness de preview.

Verificado no merge: `bunx tsc --noEmit` OK, 417 testes/0 falhas, preview confere (39 divisores, todos muted; glifos `✓` accent / `!` warning / `✗` destructive-stderr; nenhum divisor colorido).

## Objetivo desta sessão

Exercitar os fluxos REAIS num terminal de verdade (não só o preview) numa branch nova, e confirmar que cada tela fecha o contrato visual ponta a ponta. Se algo destoar, corrigir cirurgicamente.

## Como rodar (gotcha importante)

O `cam` em `/usr/local/bin/cam` é uma CÓPIA compilada ANTIGA (v0.1.1), NÃO reflete o source. Para ver o comportamento atual use SEMPRE `bun index.ts <cmd>` a partir da raiz do repo.

Preview sem efeitos colaterais (render colorido de todas as telas, fixtures em tmpdir):

```
bun scripts/preview-screens.ts                 # todas
bun scripts/preview-screens.ts [status|stop|resume|run|next|plan]
```

Fluxos reais (cuidado: alguns spawnam tmux/claude de verdade):

```
bun index.ts status                  # read-only, seguro em qualquer cwd
bun index.ts stop                    # cleanup idempotente, seguro
bun index.ts resume --dry-run        # classifica sem mutar/spawnar
bun index.ts resume --mode reset-prd # muta prd.json (use num repo de teste)
bun index.ts run                     # spawna sessão tmux do orchestrator (precisa de projeto cam init)
bun index.ts next                    # ARMA o loop + spawna claude (loop real, use com consciência)
bun index.ts plan                    # sessão claude interativa de planning
```

Cor num pager/pipe: `FORCE_COLOR=1 bun index.ts <cmd> | less -R`.

## Contrato visual a conferir (o que olhar em cada tela)

- Título: accent + bold, col 0, com blank antes.
- Section heading: bold col 2 + divisor col 2, divisor SEMPRE muted (nunca colorido). Esse é o ponto que já mordeu antes (ver `lessons.archive.md` 2026-06-05): sucesso/falha é sinalizado pelo GLIFO, não pela cor do divisor.
- Conteúdo no col 4 via `emit*`: `emitOk` (✓ accent), `emitWarn` (! warning), `emitMutedHint` (muted), `emitContent` (texto), `emitEntry(name, desc)` (Section "Next").
- Estado (igual ao Dashboard): idle `◌` muted, active `●` accent, paused `!` warning.
- Erro fatal que aborta (dependência ausente, parse error): `printError` em stderr, col 0, SEM Section. Decisão travada e confirmada contra o Claude Code (`claude-code-harness/cli/exit.ts`: `cliError` → stderr+exit1, `cliOk` → stdout+exit0; não existe Section "Failed" no print path deles).

Fonte única do contrato: `src/design/tokens.ts` (palette, glyphs, layout, `DIVIDER`). Helpers de print: `src/logging/screen.ts`. Componente Ink: `src/ui/Section.tsx`.

## Checklist por comando (estados a exercitar)

- `status`: idle (sem state file), active, paused. Section "Next" no idle e no paused.
- `stop`: com coisa pra limpar (state file + tmux) e sem nada (fecho "Done" muted nos dois).
- `resume`: idle, respawn, noop, success, prompt (Y/n/reset), e os 3 `--mode reset-*`. Confirmar Section "Done"/"Next" por modo.
- `run`: dry-run (com orchestrator) e fatal (sem `subagent-orchestrator.md` → stderr). Atalho: `CAM_RUN_DRY_RUN=1 bun index.ts run`.
- `next`: tmux-split (dentro e fora de tmux), inline (VS Code/sem tmux), e fatal (hook/settings/state file). Seções "Loop" e "Host".
- `plan`: dispatched, APPROVE→Yes (continua), APPROVE→No (cancela), spawn-fail (stderr). O prompt de aprovação é Ink `promptSelect` num TTY real.

## Gotchas

- Verificar o RENDER real, não confiar em comentário de código nem em mental model (lição 2026-06-05, no `lessons.archive.md`). Antes de afirmar/decidir sobre aparência, renderizar e olhar o output.
- `emitEntry` tem coluna de nome de 12 chars; nome maior cola na descrição. Para comando largo (ex: `git reset --hard origin/main`) usar `emitContent`, não `emitEntry`.
- Sem travessão (—) em arquivo .md persistido (preferência do usuário): dois-pontos, vírgula, parênteses, ponto. Em string de runtime no .ts (mensagem efêmera ao operador) ainda pode.
- Testes de output capturam `process.stdout.write` com `toContain`/`toMatch` lenientes; mudar glifo/layout normalmente não quebra, mas conferir `bun test`.

## Verificação (rodar sempre antes de declarar pronto)

```
bunx tsc --noEmit
bun test
bun scripts/preview-screens.ts            # revisar render com o usuário
```

## Fora de escopo (não mexer sem pedido)

Telas one-shot remanescentes (help, dashboard, init/setup wizard) já eram Ink ou já estavam no vocabulário. Só revisitar se o teste mostrar drift concreto.
