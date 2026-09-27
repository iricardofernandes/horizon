# Fase 59 — evidências: previsão e métricas do funil reconstruídas do histórico

Status: **concluída em 2026-09-27** (execuções locais entre 17:20 e 17:45 UTC).
Plano: [crm-phase59-implementation-plan.md](crm-phase59-implementation-plan.md).
Decisão: [ADR 0057](adr/0057-crm-accounts-are-parties-with-typed-documents.md).

## O que foi entregue

- **`metricRowsOf(histórico)`:** função pura do domínio que dá, para uma oportunidade:
  - os estados (cada fato até o próximo);
  - as passagens por etapa (entrada, saída e como saiu: movida, ganha ou perdida);
  - os fechamentos (ganho ou perda, até uma reabertura, ou uma conversão depois de uma
    perda, que os supera).
- **Projeção ao vivo:** ao gravar o histórico, o store substitui as linhas da
  oportunidade na mesma transação (`metric_states`, `metric_stage_visits`,
  `metric_closures`).
- **Leituras num corte:**
  - `GET /forecast`: valor aberto por mês de fechamento previsto, valor ponderado pela
    probabilidade da etapa (arredondado por grupo) e valor ganho no mês do ganho. Agrupa
    por funil, owner ou origem, filtra por qualquer um deles, e soma por moeda;
  - `GET /pipelines/{id}/metrics`: entradas, saídas, quantas estão em cada etapa no corte,
    tempo na etapa (quantidade, média e mediana), conversão entre etapas, taxa de ganho e
    motivos de perda, numa janela de instantes gravados;
  - as duas respostas trazem o `cutoff` e se ele está `settled` (tem mais de 10 minutos).
    Um corte no futuro recebe `400`.
- **Corte fechado imutável:** um trigger recusa um fato do histórico gravado a mais de 2
  minutos do relógio do banco, para trás ou para frente.
- **Reconstrução:**
  - `RebuildMetricsUseCase` percorre as oportunidades por id em lotes, cada lote numa
    transação, com cada oportunidade travada enquanto é comparada e substituída;
  - o CLI `npm run rebuild:metrics -- --tenant <uuid> [--batch] [--verify-only]` imprime o
    progresso, a divergência e a comparação dos números num corte fixo antes e depois.
- **Migração `0004_pipeline_metrics`:** as três tabelas com RLS forçado (o app pode
  `SELECT`, `INSERT` e `DELETE`: são projeções) e o trigger de tolerância.

## Critérios de saída

| Critério | Evidência |
|---|---|
| Apagar e reconstruir as métricas dá os mesmos números da projeção ao vivo | e2e: números de todos os agrupamentos da previsão e das métricas de todos os funis num corte; as três tabelas apagadas (os números mudam); reconstrução em lotes de 2 com progresso `[2, 4]` e 4 divergências; números idênticos (JSON canônico). Uma linha editada à mão aparece como divergência daquela oportunidade e é reparada. Smoke: a segunda reconstrução no container não encontra divergência, e os números da API no mesmo corte ficam idênticos |
| Um evento retroativo ou repetido não muda um corte fechado | e2e: inserção no histórico com `occurred_at` uma hora antes, ou uma hora depois, recusada pelo banco; depois do corte, o `sales.quote.accepted` reentregue (mesmo id e id novo) e uma perda nova não mudam os números no corte, e as métricas de agora mostram a perda nova. Smoke: um corte anterior ao trabalho não mostra nada, um corte de 20 minutos atrás é `settled` e um corte no futuro recebe `400` |

## Números conferidos à mão (e2e)

Funil com etapas A (10%), B (50%) e C (80%) e quatro oportunidades:
1. 100 000, prevista para 12/2026, A→B, aberta;
2. 200 000, prevista para 12/2026, A→B→C, ganha;
3. 50 000, prevista para 01/2027, perdida em A por "preço";
4. 30 000, prevista para 12/2026, perdida em A por "prazo" e reaberta em B.

| Número | Esperado e obtido |
|---|---|
| Previsão 2026-12 | 2 abertas, 130 000, ponderado 65 000 |
| Previsão no mês corrente | 1 ganha, 200 000 |
| Previsão por owner 2 | 30 000, ponderado 15 000 (a perdida não entra) |
| Etapas (entradas / no corte / saídas) | A 4 / 0 / 2 movidas e 2 perdidas; B 3 / 2 / 1 movida; C 1 / 0 / 1 ganha |
| Conversões | A→B 2, B→C 1 |
| Taxa de ganho | 1 ganha e 1 perdida: 5000 bps (a perda da 4, reaberta, não conta) |
| Motivos de perda | "preço" 1 |

## Smoke no stack local

`node scripts/phase59-smoke.mjs` (tenant de demonstração), depois de `make up-apps`.

| Verificação | Resultado |
|---|---|
| Primeira reconstrução, logo depois da migração | 7 oportunidades antigas, 7 sem linhas (divergência esperada), nada pendente, saída 0 |
| Funil novo: uma aberta em Proposta, uma ganha, uma perdida | previsão 12/2026 com 400 000 e ponderado 240 000 (60%); mês corrente com 250 000 ganhos; conversão Qualificação→Proposta 2; ganho 1 e perda 1 (5000 bps); o motivo de perda |
| Segunda reconstrução | 10 oportunidades, 0 divergências, números inalterados; API igual no mesmo corte |
| Cortes anteriores | antes do trabalho: previsão vazia; 20 minutos atrás: `settled`; futuro: `400` |

## Verificação

- **CRM:**
  - 86 testes unitários (7 novos: `metricRowsOf` em 4 cenários, inclusive fatos fora de
    ordem, e a reconstrução com lotes, progresso, divergência e isolamento);
  - cobertura de domínio e aplicação em 97,7% de linhas;
  - e2e com PostgreSQL: 26 testes, 4 novos em `test/metrics.e2e-spec.ts`. O trigger novo
    não quebrou nenhum dos anteriores.
- **`make check`:** passou.
- **CI local (`make ci-local`):** passou em todas as etapas, rodado depois de este arquivo
  existir ("Local code and integration gates passed").
- **Job isolado do CRM:** passou (registro descartável, contratos 0.45.0): 86 testes e build.
