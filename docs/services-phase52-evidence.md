# Fase 52 — evidências do faturamento por período e das rodadas em lote

Status: **concluída em 2026-09-26** (execuções locais entre 02:36 e 02:46 UTC de 27/09).
Plano: [services-phase52-implementation-plan.md](services-phase52-implementation-plan.md).
Decisão: [ADR 0056](adr/0056-services-are-delivered-by-service-orders-inside-sales.md).
Operação: [runbook do faturamento de contratos](services-billing-runbook.md).

## O que foi entregue

- **Contratos `@horizon/contracts` 0.40.0:**
  - eventos `sales.contract-period.billed` e `sales.contract-period.credited`;
  - origem `sales-contract-period` no título do Financeiro;
  - leitura das entradas de serviço do Fiscal com `billedPeriodId` e `contractId`.
    `deliveryId` e `serviceOrderId` passam a aceitar nulo. O gate classifica isso como
    mudança incompatível numa leitura que ninguém fora do Fiscal consome, e por isso a
    versão subiu o número minor.

  Todos os módulos foram fixados na 0.40.0, e o catálogo `docs/events.md` foi gerado de novo.
- **Sales:**
  - migração `0014_contract_billing`:
    - períodos faturados e suas linhas;
    - rodadas de faturamento e seus itens;
    - RLS nas quatro tabelas;
    - um período por contrato e competência;
    - gatilhos que impedem mudar o que foi faturado, reescrever um crédito ou decidir um
      item de rodada duas vezes;
    - o papel do relay só pode contar colunas sem tenant, cliente ou valor;
  - domínio:
    - `contract-billing.ts`: quando um período pode ser faturado e por que não;
    - `ServiceContract.bill` congela revisão, linhas, valores e parcelas;
    - `ServiceContract.credit` credita o período inteiro e o mantém;
    - a regra de mudanças passou a recusar um período já faturado;
  - rodadas:
    - prévia sem gravar nada;
    - início com chave de idempotência, que renova antes os contratos com renovação
      automática;
    - processamento de um contrato por transação, com retomada;
    - uma rodada nova do mesmo mês não fatura nada duas vezes;
  - acompanhamento: o Sales projeta `financial.receivable.posted`,
    `financial.receivable.reversed` e `fiscal.service-document.simulation-outcome` no
    período faturado;
  - rotas:
    - faturar e creditar um período;
    - períodos faturados de um contrato;
    - prévia, início, retomada e leitura das rodadas;
    - `GET /sales/contract-billing/overview`;
  - métricas:
    - `sales_contract_billing_outcomes` (resultado e motivo);
    - `sales_contract_billing_run_duration_seconds`;
    - os gauges `sales_contract_periods_without_receivable` e
      `sales_contract_periods_without_nfse`.
- **Financeiro:**
  - migração `0008_contract_periods`;
  - um título efetivo por período faturado (`CT-…`);
  - no crédito, o título é retirado (rascunho), estornado (lançado sem baixa) ou sinalizado
    (com baixa), com a mesma lógica da entrega cancelada.
- **Fiscal:**
  - migração `0052_phase52_contract_periods`: a entrada de serviço passa a nomear o período
    faturado e o contrato, e guarda o código do cancelamento pedido;
  - cada linha faturada vira uma entrada com chave `sales` / `contract-period` / `entryId` /
    competência e data de competência no primeiro dia do período;
  - o crédito cancela a NFS-e pelo 101101, com motivo 2 (não prestado) ou 1 (erro na
    emissão);
  - `GET /fiscal/service-intakes` filtra por `documentType` e `period`;
  - gauges de entradas bloqueadas e de cancelamento recusado.
- **Alertas:**
  - `sales.rules.yml`: `SalesBillingRefusals`, `SalesPeriodsWithoutReceivable`,
    `SalesPeriodsWithoutNfse`;
  - em `fiscal.rules.yml`: `FiscalServiceIntakesBlocked` e
    `FiscalServiceCancellationRefused`;
  - todos testados com `make test-alerts` (promtool) e com seção no runbook.

## Critérios de saída

| Critério | Evidência |
|---|---|
| Repetir o mês, reprocessar os eventos e retomar uma rodada interrompida geram um título e uma NFS-e por período | e2e do Sales: rodada parada depois de um contrato e terminada pela mesma chave, rodada nova com tudo `already-billed`, e a restrição única recusando uma segunda linha; e2e do Financeiro e do Fiscal: mesmo evento e mesmos fatos com outro id; smoke: mesma chave, chave nova e republicação com novo `eventId` com 1 título e 1 entrada |
| Todo contrato recusado aparece com o motivo | testes de unidade (`customer-inactive`, `service-unavailable`); smoke: o contrato com serviço desativado aparece `refused` / `service-unavailable` na prévia e em todas as rodadas |
| O crédito desfaz título e NFS-e e mantém o período | e2e do Financeiro (título retirado, crédito antes do período refeito pela fila); e2e do Fiscal (NFS-e cancelada com motivo 1, entrada `withdrawn`); e2e do Sales (período mantido, crédito que não se reescreve); smoke: título `cancelled`, NFS-e `cancelled`, 2 períodos mantidos e novo faturamento recusado |

## Verificação

- **Contratos:** 108 testes, sendo 2 novos. O gate mostrou 14 adições e 4 mudanças
  incompatíveis, as anuláveis descritas acima, cobertas pela versão minor.
- **Sales:**
  - 112 testes unitários, sendo 12 novos:
    - 6 de domínio: congelamento, motivos de pulo, mês sem período, aditivo depois do
      faturamento, mudança num período faturado, crédito;
    - 6 de caso de uso: prévia, mês futuro, novas rodadas, retomada, recusas, faturar e
      creditar um período;
  - e2e com PostgreSQL e RabbitMQ: 24 passando, sendo 2 novos:
    - rodada interrompida e retomada, rodada nova, mês anterior, aditivo recusado,
      projeções e lacunas, crédito, gatilhos e restrição única;
    - isolamento entre tenants nas quatro tabelas, o relay sem acesso a tenant ou valor, e
      os gauges.
- **Financeiro:** 37 testes unitários; e2e dos serviços com 5 testes, sendo 2 novos
  (repetição e crédito; crédito antes do período).
- **Fiscal:** 171 testes unitários; e2e de NFS-e com 12 testes, sendo 1 novo (emissão
  automática com repetição, filtro por tipo e mês, crédito com motivo 1, retirada, gatilho).
- **Alertas:** `make test-alerts` com 14 regras do Fiscal e 3 do Sales.
- **Jobs isolados reproduzidos** (checkout só do módulo, contratos 0.40.0 vindos do registro
  local): contratos, Sales, Financeiro e Fiscal, com typecheck, lint, testes e build.
- **CI local (`make ci-local`):**
  - a primeira passagem falhou nas fronteiras: o verificador leu
    `is distinct from 'authorized'`, dentro de duas consultas SQL, como import de um pacote
    `authorized`. O valor passou a ir como parâmetro;
  - o e2e do Sales foi repetido (24 passando), e a segunda passagem foi limpa.

### Smoke no stack local

`scripts/phase52-smoke.mjs`, tenant `01a0c5f8-798b-721e-912e-9b505406e614`, quatro
execuções. A quarta rodou depois da refatoração da entrada do Fiscal, e o smoke da fase 50
foi repetido em seguida (02:46 UTC) para confirmar as entregas. Cada execução:
1. Cria dois serviços com preço e perfil fiscal, e um cliente com perfil fiscal nacional.
2. Põe a política do estabelecimento em `automatic`, série 52. No fim, volta para
   `review`, série 1.
3. Cria dois contratos mensais a partir do mês passado, com cobrança no dia 1. Depois
   desativa no Catálogo o serviço do segundo.
4. A prévia do mês lista o primeiro como `billed` e o segundo como
   `refused` / `service-unavailable`.
5. Roda o mês:
   - com a mesma chave, recebe a mesma rodada;
   - com chave nova, o primeiro contrato aparece `skipped` / `already-billed`;
   - roda também o mês passado;
   - um mês futuro é recusado com `409`.
6. Cada período vira um título em rascunho (`CT-…`) e uma NFS-e autorizada na série 52. A
   chave de origem é `contract-period`, e o Sales passa a mostrar a NFS-e `authorized` em
   cada linha.
7. Republica o fato do mês atual com novo `eventId`. Financeiro e Fiscal consomem, e não
   surge título, entrada nem origem novos.
8. Um aditivo a partir do mês faturado é recusado com `409`. A partir do mês que vem ele é
   aceito, e o cronograma mostra os dois meses faturados na revisão 1 e o seguinte na
   revisão 2.
9. Credita o mês atual (`billing-error`):
   - título `cancelled`;
   - entrada `withdrawn`;
   - NFS-e `cancelled`, e o Sales a mostra `cancelled`;
   - os dois períodos continuam registrados;
   - faturar o mês de novo é recusado.
10. O overview lista a rodada, sem período pendente de título ou NFS-e.

| Execução (UTC) | Contrato faturado | Rodada do mês | Rodada nova | Rodada do mês passado | NFS-e |
|---|---|---|---|---|---|
| 02:36:51 | `01a0e0b8-eabc-782b-99d2-ccaa6125d262` | `01a0e0b8-ef0c-781b-9b6d-eadeba83f216` | `01a0e0b8-ef30-7423-b3d1-375626a729ce` | `01a0e0b8-ef3e-7a47-b519-de68cd8501f1` | 1 e 2 |
| 02:38:37 | `01a0e0ba-998f-7d9d-b8c6-f8e6f7270f20` | `01a0e0ba-9de5-7116-8c75-5ecf1cfca4f4` | `01a0e0ba-9e0e-70c5-ba36-97cb6e86ff22` | `01a0e0ba-9e24-72ce-a2a9-df770c854ddb` | 3 e 4 |
| 02:40:21 | `01a0e0bc-3111-73f6-97f7-ada0d645c215` | `01a0e0bc-355d-7994-93e2-9eb383457c65` | `01a0e0bc-357c-7d0c-a531-ea12bcca8d48` | `01a0e0bc-358c-730f-870a-dabd92c4296f` | 5 e 6 |
| 02:44:33 | `01a0e0c0-0a57-7ce1-90a8-4137a86e43ac` | `01a0e0c0-0ea3-7aca-aab4-933a6d0d508e` | `01a0e0c0-0ec3-77eb-a548-8da45df164f2` | `01a0e0c0-0ed6-7812-be7d-dc2b7736aa9f` | 7 e 8 |

As métricas chegaram ao Prometheus pelo Collector:
- `sales_contract_billing_outcomes_total`, por resultado e motivo;
- `sales_contract_billing_run_duration_seconds`;
- os dois gauges do Sales, em 0 depois dos smokes;
- `fiscal_service_intakes_blocked`, em 2, com as entradas da fase 50 que esperam o dia de
  competência (E0015).

## Pendências e limites

- As telas de rodadas e de períodos faturados são da fase 53. Até lá, a API e o smoke são
  a superfície de operação.
- A rodada é iniciada pela API; não há agendador que rode o mês sozinho.
- O crédito é sempre do período inteiro. Crédito parcial e a substituição da NFS-e
  (105102) pelo Sales ficam fora, como na fase 50.
- As recusas fiscais (perfil de serviço ausente, município sem suporte) continuam no
  Fiscal, como entradas bloqueadas com o motivo. A rodada do Sales mostra as recusas que o
  Sales conhece, e o overview mostra os períodos sem NFS-e autorizada.
- Um título conta como lançado quando uma pessoa o lança: os títulos dos períodos nascem em
  rascunho, como os das entregas.
