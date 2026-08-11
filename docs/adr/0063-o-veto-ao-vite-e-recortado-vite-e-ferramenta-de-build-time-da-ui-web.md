# ADR 0063: O veto ao vite e recortado, vite e ferramenta de build-time da UI web

## Context

O item 13 de `memory/project_definicoes_web_headless.md` (definicoes confirmadas pelo operador em 2026-08-10) adota vite como ferramenta de build da UI web, com Tailwind v4 CSS-first e shadcn vendorizado. A proibicao ao vite, porem, continuava viva em sete linhas da superficie de instrucao (`CLAUDE.md:2` e `:55`, `scripts/cam/CLAUDE.md:32` e `:64`, `.claude/agents/subagent-planner.md:198` e o espelho em `templates/agents/`, `.claude/agents/subagent-auditor.md:95`), contradizendo a decisao que os agentes leem em tempo de execucao.

A adocao do vite se apoia na medicao de runtime de 2026-08-10:

- A CLI do `bun build --compile` nao roda plugins de bundler.
- Tailwind no Bun depende do bun-plugin-tailwind 0.1.2, parado desde 2025-10, ainda em Tailwind v3, sem peer de tailwindcss.
- Tailwind v4 nao tem integracao de primeira parte com Bun.
- O bug oven-sh/bun#23646 reproduziu neste repo: o binario compilado sobe e serve Tailwind cru nao processado, falha silenciosa.

Sobre a procedencia do texto recortado: a justificativa de boilerplate cobre apenas `CLAUDE.md:55`, que era byte-identica a `node_modules/bun-types/CLAUDE.md:35` (texto do pacote, nao decisao de engenharia). As demais seis superficies eram autorais, e o recorte delas se apoia na medicao acima, nao na procedencia do texto.

## Decision

O veto ao vite sai das sete linhas da superficie de instrucao. A fronteira da decisao: vite e ferramenta de build-time da UI web e nunca entra no binario shipado, entao o invariante Bun de runtime segue intacto. Continuam valendo, sem alteracao: `Bun.spawn` / `Bun.$` / `Bun.file` sobre `node:child_process`, a proibicao de npm e pnpm como gerenciador de pacote, a excecao dos point-reads sincronos deliberados em `node:fs`, e a proibicao de express, `pg`, `ws`, `better-sqlite3`, `ioredis` e execa na regra 20 do auditor.

Em `CLAUDE.md:55` a frase boilerplate cai inteira, as duas metades, porque a segunda metade ("HTML imports fully support React, CSS, Tailwind") foi refutada pela mesma medicao; manter a afirmacao truncada seria trocar uma frase falsa por outra. No lugar entra a ressalva de que o pipeline de HTML imports nao cobre Tailwind v4 e de que a UI web usa vite em build-time, apontando para este ADR.

Este ADR nao supersede nenhum ADR existente. A proibicao ao vite vivia so na superficie de instrucao, nunca num ADR.

## Consequences

A superficie de instrucao deixa de contradizer o item 13, e o oraculo do recorte (grep por `\bvite\b` nas superficies, excluidas as linhas que citam o recorte, build-time ou este ADR) fica em zero linhas. Planner, auditor e worker deixam de recusar stories da UI web por citarem vite. O invariante Bun-only permanece integral para runtime, e qualquer tentativa futura de trazer vite (ou outro bundler) para dentro do binario shipado cruza a fronteira declarada aqui e exige novo ADR.
