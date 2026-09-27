# Fase 56 — evidências: funis e oportunidades

Status: **concluída em 2026-09-27** (execuções locais entre 15:00 e 15:30 UTC).
Plano: [crm-phase56-implementation-plan.md](crm-phase56-implementation-plan.md).
Decisão: [ADR 0057](adr/0057-crm-accounts-are-parties-with-typed-documents.md).

## O que foi entregue

- **Contratos 0.43.0:** `crm.opportunity.created`, `revised`, `stage-changed`,
  `owner-changed`, `won`, `lost` e `reopened` (v1).
  - Cada evento leva o que a previsão e as métricas vão precisar no momento do fato:
    funil, etapa e probabilidade, owner, origem, valor e motivo de perda.
  - O título e os contatos nunca são publicados, e o schema recusa o campo `title`.
  - Todos os módulos foram fixados em 0.43.0.
- **Funis:**
  - etapas ordenadas, cada uma com probabilidade em pontos-base;
  - as etapas podem ser renomeadas, reordenadas, reponderadas e arquivadas; o funil pode
    ser arquivado;
  - nada é apagado. Etapa arquivada mantém suas oportunidades, deixa sair e não deixa
    entrar;
  - ganho e perdido são desfechos da oportunidade, não etapas. Por isso cada funil tem
    exatamente um de cada.
- **Origens e motivos de perda:** listas do workspace, arquivadas e nunca apagadas, com
  nome único entre as ativas (índice parcial no banco). A conta ganha origem, adiada da
  fase 55.
- **Oportunidades:**
  - dados: conta ativa; contatos vivos da própria conta; owner ativo; origem ativa;
    título; valor esperado (`Money` em unidades mínimas); data prevista de fechamento;
    funil e etapa;
  - operações: revisar, mover, trocar o owner, ganhar, perder com motivo e nota, e reabrir
    em etapa ativa;
  - a criação é idempotente.
  - **O histórico é o agregado.** Os comandos só decidem o fato. `applyFact` é o único
    lugar onde o estado muda, e a linha em `opportunities` é o resultado de aplicar o
    histórico. `opportunity_events` é append-only por trigger.
  - Uma revisão que mudou só título ou contatos entra no histórico, mas não é publicada.
- **Papéis:** nova ação `configure` para `admin` e `manager`, que configuram funis e
  listas. Mover, revisar, ganhar, perder e reabrir exigem `write`; trocar o owner exige
  `assign`.
- **Migração `0001_opportunities`:**
  - `pipelines`, `pipeline_stages` (posição única adiada, para reordenar numa transação),
    `list_entries`, `opportunities` e `opportunity_events`;
  - `accounts.source_id`;
  - checks: desfecho coerente (data de fechamento somente quando fechada, motivo somente
    quando perdida);
  - RLS forçado e grants por coluna.

## Critérios de saída

| Critério | Evidência |
|---|---|
| Arquivar uma etapa mantém as oportunidades nela e seu histórico | unitário e e2e: oportunidade continua na etapa arquivada, sai dela, não volta; smoke: etapa arquivada com a oportunidade dentro, mover para ela devolve `409`, sair funciona |
| Oportunidade perdida mantém o motivo; reabrir mantém as duas perdas no histórico | unitário: perdida, reaberta, perdida de novo, duas entradas `lost`; e2e: histórico `created, stage-changed, lost, reopened, lost`, estado final com o segundo motivo |
| Reaplicar os eventos do CRM dá o mesmo estado | unitário: `foldHistory(histórico) == estado`, também com o histórico embaralhado; e2e: o histórico lido do banco reconstrói a linha gravada |

## Smoke no stack local

`node scripts/phase56-smoke.mjs` (tenant de demonstração), depois de `make up-apps`.
Uma fila de prova ligada a `crm.opportunity.#` é criada e removida pelo script.

| Verificação | Resultado |
|---|---|
| Representante criando funil | `403` |
| Funil com 3 etapas, mais uma adicionada; origem e motivo de perda | criados; origem repetida com outra caixa: `409` |
| Conta nova (prospect no Parties) com origem | projetada e com a origem gravada |
| Oportunidade criada e repetida com a mesma chave | mesmo id |
| Representante move a oportunidade; representante troca o owner | ok; `403` |
| Manager troca o owner, revisa o valor (2.500.000 → 2.800.000), perde com motivo | ok |
| Mover estando perdida | `409` |
| Reabrir, arquivar a etapa, mover para ela, mover para outra, ganhar | reaberta; continua na etapa arquivada; `409`; ok; `won` |
| Histórico | `created, stage-changed, owner-changed, revised, lost, reopened, stage-changed, won` |
| RabbitMQ | os 8 fatos na mesma ordem; nenhum com o título; `won` com valor 2.800.000 BRL e a origem |

Na primeira execução do smoke, repetir a criação com a mesma `Idempotency-Key` pelo Kong
devolveu `409` "already used for a different request". A impressão digital incluía o
contexto do comando, e o `x-request-id` muda a cada requisição (armadilha da fase 50).
Corrigido nos três casos de uso de criação, com teste de regressão. Na segunda execução,
o smoke parou numa chamada malformada do próprio script (PUT com campos da criação), que
foi corrigida. A terceira passou inteira.

## Verificação

- **CRM:**
  - 53 testes unitários: funil, oportunidade (transições, recusas, reconstrução),
    valores, mapa de papéis e casos de uso com o repositório em memória;
  - cobertura de domínio e aplicação em 97% de linhas;
  - e2e com PostgreSQL: 13 testes, 5 novos:
    - histórico reconstruído do banco e protegido contra `UPDATE` e `DELETE`;
    - outbox sem título e sem contatos;
    - etapa arquivada e reordenação numa transação;
    - criação idempotente concorrente;
    - RLS nas tabelas novas.
- **Contratos:** 2 testes novos (probabilidade limitada, `title` recusado, motivo
  obrigatório na perda, status de reabertura).
- **`make check`:** passou.
- **CI local (`make ci-local`):**
  - a primeira execução falhou em "documentation links": ela começou antes de este
    arquivo de evidências existir, e três documentos já apontavam para ele;
  - a segunda, sobre o conteúdo do commit, passou em todas as etapas (repositório, pins,
    compatibilidade de contratos, arquivos gerados, build e testes de todos os projetos,
    e2e de todos os serviços).
- **Job isolado do CRM:** passou (registro descartável, contratos 0.43.0): 53 testes e
  build.
