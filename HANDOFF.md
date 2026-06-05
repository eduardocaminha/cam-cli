# HANDOFF: alinhar telas de print ao vocabulário Ink

Documento de continuidade para uma nova conversa. Lê isto + `lessons.md` + os arquivos citados e segue a fase 2. Não precisa reler o histórico de chat.

## Objetivo

Padronizar TODAS as telas do cam-cli num design-system único, seguindo a linha do Claude Code: um conjunto de tokens do qual os dois caminhos de render derivam. NÃO migrar tudo pra Ink. Ink fica só onde re-renderiza/interage (dashboard, prompts, init/setup wizard). Telas one-shot continuam print linear, mas com o MESMO vocabulário visual das Ink.

Referência do modelo Claude Code (de-minificado, neste repo): `claude-code-harness/`. Pontos confirmados: eles têm um design-system (`components/design-system/`, `ink.ts`) e separam interativo (Ink) de print mode (`cli/print.ts`, escreve direto em stdout, sem Ink). Telas estáticas one-shot NÃO usam Ink lá.

## Decisões já travadas com o usuário

1. **Splash só em `init`/`setup`** (entradas). Demais comandos abrem com título `accent + bold` no col 0, sem painel.
2. **Abordagem "referência primeiro":** alinhar 1 tela, aprovar, replicar. Já aprovado via `status` (read-only) + `stop` (operação).
3. **Section "Next" separada** para próximos passos (com divisor, listando comandos), em vez de hint inline.
4. **Fecho de operação:** Section de resultado ("Done" / "Failed") como bloco separado. CORREÇÃO IMPORTANTE (ver lessons.md 2026-06-05): o divisor do fecho é SEMPRE cinza (muted). Sucesso/falha é sinalizado pelo GLIFO no conteúdo (✓ accent, ✗ destructive), NUNCA pela cor do divisor. Nenhum componente Ink colore divisor; o `cam stop` chegou a sair com divisor verde e foi corrigido.

## Padrão canônico (o contract)

Fonte única: `src/design/tokens.ts`.
- **palette** (hex): accent `#4EBE7D`, warning `#FFCB1F`, destructive `#F25F5C`, muted `#808080`.
- **glyphs**: success `✓`, error `✗`, warning `!`, pending `◌` (idle/pending), active `●` (loop rodando), cursor `❯`, input `›`.
- **layout**: dividerWidth 50, headingIndent 2, contentIndent 4. `DIVIDER` pronto.

Estrutura de uma tela print (helpers em `src/logging/screen.ts`):
- `emitTitle('cam <cmd>')`: título accent+bold, col 0, com blank antes.
- `emitSectionHeading('Heading')`: heading bold col 2 + divisor muted col 2 (divisor SEMPRE muted, sem param de tom).
- conteúdo no col 4: `emitOk` (✓ accent), `emitWarn` (! warning), `emitMutedHint` (muted), `emitContent` (texto), `emitEntry(name, desc)` (comando bold + desc muted, para Section "Next").
- `emitTrailingBlank()` no fim.

Regra de coluna: mensagens não-fatais (sucesso, aviso, hint) ficam DENTRO da Section (col 4) via `emit*`. NÃO usar `printHint`/`printWarning` (col 0/2) para conteúdo de tela.

Mapeamento de estado (igual ao Dashboard): idle `◌` muted, active `●` accent, paused `!` warning.

## Já feito (fase 1, verificado: tsc OK, 417 testes/0 falhas)

- `src/design/tokens.ts`: novo, design-system único.
- `src/ui/theme.ts`, `src/ui/Section.tsx`: derivam dos tokens (Ink).
- `src/logging/color.ts`, `src/logging/screen.ts`, `src/logging/help.ts`: derivam dos tokens (print). `screen.ts` ganhou `emitWarn` e `emitEntry`.
- `src/commands/status.ts`: glifos do design-system (◌/●/!), mensagens na coluna, Section "Next" no idle e no paused. Removidos imports mortos pré-existentes (color/printError/printSuccess/statSync + bloco `void`).
- `src/commands/stop.ts`: Section de fecho "Done" (divisor muted), ✓ no sucesso.
- `src/ui/InitScreen.tsx`: comentários corrigidos (diziam "accent divisor", falso).
- `scripts/preview-screens.ts`: NOVO. Preview com cor das telas print (chama run* direto). `bun scripts/preview-screens.ts [status|stop]`. Registry `SCREENS` no fim é onde adicionar run/next/plan/resume.
- Limpeza: removidos 1.4 GB de artefatos de build gitignored (`.bun-build`, `dist/`). Repo 1.5G -> 121M. Removidos órfãos `SECTION_DIVIDER_WIDTH`, `SCREEN_DIVIDER_WIDTH`, `PaletteToken`, `Glyph`, `ThemeColor`.

## Falta (fase 2): run, next, plan, resume

Todos usam `src/logging/screen.ts` + `printError`/`printWarning` de `color.ts`. Aplicar o padrão canônico. Por comando:

- **`src/commands/resume.ts`**: o mais direto (puro print, sem spawn nos paths de reconcile/reset/dry-run). Tem muitos `printHint`/`printSuccess`/`printWarning` no col 0/2 que devem virar `emit*` na coluna. Tem fecho natural ("o que foi feito") e próximos passos (Section "Next"). Bom candidato para começar.
- **`src/commands/run.ts`**: pré-flight com `printError` (tmux/orchestrator ausente, exit 1). DECISÃO PENDENTE: erro fatal continua `printError` em stderr (col 0) ou vira Section "Failed" no stdout? Caminho feliz entrega o TTY pro `tmux attach` (sem fecho). Tem `CAM_RUN_DRY_RUN=1` para preview sem spawnar.
- **`src/commands/next.ts`**: idem run, com vários estágios (materializa hook, arma loop, detecta host). Caminho feliz spawna `claude`. Tem caminhos de erro fatal.
- **`src/commands/plan.ts`**: prompt já é Ink (`promptSelect`). Caminho feliz spawna `claude`. Alinhar o output ao redor.

DECISÃO DE DESIGN a resolver com o usuário no início da fase 2: para erro fatal que aborta o comando (parse error, dependência ausente), manter `printError` no col 0 / stderr (contrato CLI: erros vão pra stderr), OU trazer pra uma Section "Failed" no stdout? Recomendação: manter erros fatais em stderr (col 0) como hoje (são interrupções, devem destoar e ir pro stream certo); usar Section "Failed" só quando o comando roda até o fim e reporta falha como resultado. Confirmar antes de codar.

Depois de cada comando: registrar no `scripts/preview-screens.ts` (via dry-run onde houver) e rodar o preview pra o usuário aprovar o render.

## Gotchas

- O `cam` em `/usr/local/bin/cam` é uma CÓPIA compilada ANTIGA (v0.1.1, mai/2026), NÃO reflete o source. Para ver mudanças use `bun index.ts <cmd>` a partir do repo, nunca `cam`.
- Cor: chalk liga em TTY automático. Para pager/pipe: `FORCE_COLOR=1 bun ... | less -R`.
- Comentário de código pode mentir sobre o render (ver lessons.md). Verificar o output real antes de afirmar/decidir.
- Sem travessão em arquivos .md persistidos (preferência do usuário): usar dois-pontos, vírgula, parênteses, ponto.
- Testes de output (status/stop/run/next/resume) capturam `process.stdout.write` e usam `toContain`/`toMatch` lenientes; mudar glifos/layout normalmente não quebra, mas conferir.

## Verificação (rodar sempre antes de declarar pronto)

```
bunx tsc --noEmit
bun test
bun scripts/preview-screens.ts            # revisar render com o usuário
```

## Estado git no momento do handoff

Modificados: src/commands/status.ts, src/commands/stop.ts, src/logging/color.ts, src/logging/help.ts, src/logging/screen.ts, src/ui/InitScreen.tsx, src/ui/Section.tsx, src/ui/theme.ts, test/status.test.ts. Novos: lessons.md, scripts/preview-screens.ts, src/design/tokens.ts, HANDOFF.md. Nada commitado ainda (usuário não pediu commit).
