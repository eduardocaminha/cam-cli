# ADR 0016: Nomeacao de branch derivada em codigo no formato cam/issue-<N>

## Context

Branches orfaos permaneciam no remote porque o nome do branch era autoria do planner LLM, que inventava slugs diferentes a cada tentativa de plan (CAM-66 gerou 3 nomes distintos; delete_branch_on_merge, ja ligado no repo, so removeu o nome que efetivamente mergeou). A nomeacao precisava ser deterministica, rastreavel ao issue e nao ambigua (o antigo cam/pr-<N> usava o numero do issue mas dizia pr).

## Decision

Derivar o nome do branch em codigo (plan-runner) como cam/issue-<prd.issueNumber>, sem slug, mantendo o namespace cam/. Criar a branch com git checkout -B para idempotencia no re-plan do mesmo issue, e barrar o plan quando issueNumber estiver ausente (sem fallback ad-hoc).

## Consequences

Um unico nome por issue: re-plan recria a mesma branch e qualquer merge limpa o remote, eliminando os orfaos na raiz. Zero churn no prefix-matching do namespace cam/ (plan-preflight, prune). Perde-se a legibilidade do slug num git branch, compensada pela rastreabilidade via issue-id e pelo titulo da PR (CAM-235). checkout -B descarta commits nao-pushados de uma tentativa anterior da mesma branch, comportamento intencional num re-plan. Alternativas rejeitadas: issue/cam-<N> quebraria todo o prefix-matching cam/ sem ganho; manter o slug reintroduziria o nao-determinismo que causa os orfaos.
