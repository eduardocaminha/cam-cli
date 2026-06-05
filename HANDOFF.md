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

## DECISÃO DE DESIGN (RESOLVIDA): erro fatal vai pra stderr

Para erro fatal que aborta o comando (parse error, dependência ausente): mantém `printError` no col 0 / stderr, NÃO vira Section "Failed". Confirmado contra o Claude Code de-minificado: `cli/exit.ts` separa exatamente isso (`cliError(msg)` escreve em stderr + `exit(1)`; `cliOk(msg)` escreve em stdout + `exit(0)`); os handlers (`cli/handlers/mcp.tsx`, `plugins.ts`) e o `cli/print.ts` reportam toda falha que aborta com `stderr.write("Error: ...")`. NÃO existe Section "Failed" no print path deles. Section de fecho ("Done") fica só pra comando que roda até o fim e reporta resultado (sucesso ou no-op calmo). Aplicar essa regra em run/next/plan.

## Fase 2 COMPLETA: resume, run, next, plan (aprovados, verificados)

Padrão aplicado nos quatro: `printHint`/`printSuccess`/`printWarning` (col 0/2) viraram `emit*` na coluna (col 4); `printError` dos aborts fatais fica em stderr (decisão acima). Verificação global: tsc OK, 417 testes/0 falhas, preview confere em TODAS as telas (39 divisores, todos muted; `✓` accent / `!` warning / `✗` destructive-stderr; ZERO divisor colorido).

- **`src/commands/resume.ts`** (aprovado): fecho por modo, Section "Done" (success / reset / prompt-reset / prompt-n) e "Next" (idle / respawn / noop / prompt-y / reset-current / reset-prd / reset-branch). Imports mortos removidos (`color`, `statSync` + bloco `void statSync`). Comando git do reset-branch sai como `emitContent` (não `emitEntry`: nome largo demais pra coluna de 12, colava na descrição, bug pego no preview).
- **`src/commands/run.ts`**: já estava quase alinhado. Só os 2 `printWarning` não-fatais (split de pane / attach falhou) viraram `emitWarn` no col 4. Pré-flight (tmux/orchestrator ausente) continua `printError` stderr. `printWarning` removido do import.
- **`src/commands/next.ts`**: os `printHint` das falhas não-fatais de tmux split viraram `emitWarn` + `emitMutedHint` no col 4. A falha de spawn do claude continua `printError` stderr, com a orientação ("verify claude is on PATH, re-run cam init") foldada no hint do printError (dropado o `printHint` separado, pra uniformizar com os outros paths fatais do arquivo). `printHint`/`printSuccess` removidos do import.
- **`src/commands/plan.ts`**: o `printSuccess`/`printWarning` do fluxo de approve (APPROVE detected / Continuing / Plan cancelled) viraram `emitOk`/`emitWarn` no col 4. Spawn-fail igual ao next (printError stderr + hint foldado). `printHint`/`printSuccess`/`printWarning` removidos do import.
- **`scripts/preview-screens.ts`**: `previewRun`/`previewNext`/`previewPlan` registrados em `SCREENS`. run via `CAM_RUN_DRY_RUN=1` + fixture (com/sem orchestrator). next via deps injetadas (spawn/writer/hookMaterializer/settingsWriter/hostMode) + `withEnv('TMUX',...)` pra mostrar inside/outside tmux. plan via harness PTY (captura onData, `emitData` injeta a linha APPROVE, `resolveExit` encerra) espelhando `test/plan.test.ts`. `bun scripts/preview-screens.ts [run|next|plan]`.

Nada mais pendente na fase 2. Telas one-shot remanescentes (help, dashboard, init/setup wizard) já eram Ink ou já estavam no vocabulário; não fazem parte do escopo deste handoff.

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
