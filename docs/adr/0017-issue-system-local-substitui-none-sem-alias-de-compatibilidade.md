# ADR 0017: issue_system=local substitui none sem alias de compatibilidade

## Context

issue_system=none era enganoso: existe um issue system local completo, mas none sugere ausencia. Renomear tinha duas rotas: manter none como alias normalizado na leitura (back-compat suave) ou remover none de vez (limpo, porem breaking). As comparacoes ===none que gateiam o close/stash do issue local eram hard e espalhadas, e o mergeIntoConfig do init nao reescreve valor existente, entao um rename cru silenciaria o backend local de qualquer project.toml legado com none.

## Decision

Adotar local como valor canonico e novo default, removendo none de todo code path. Centralizar a leitura em readIssueSystem, que faz default local para key ausente e lanca erro ruidoso generico para valor desconhecido. Migrar os project.toml conhecidos no mesmo PR. none sobrevive apenas como nota de breaking no CHANGELOG.

## Consequences

Semantica honesta (local diz o que ativa). Zero none em code path. Um project.toml legado com none passa a falhar de forma ruidosa e recuperavel (troca o silent-skip por erro claro), decisao segura porque o unico projeto com none era o proprio cam-cli, migrado no PR. Alternativa rejeitada: alias none->local normalizado, que manteria none vivo no codigo indefinidamente sem necessidade real dado o universo controlado de projetos.
