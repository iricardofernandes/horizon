# Runbook do faturamento de contratos

Operação das rodadas de faturamento de contratos de serviço (fase 52). A
[fase 53](services-implementation-plan.md#53--service-screens-golden-path-and-release-evidence)
acrescenta as telas e completa este runbook.

## Onde olhar primeiro

- `GET /sales/contract-billing/overview`: as últimas rodadas e os períodos faturados, sem
  crédito, que passaram do limite sem título lançado (`awaitingReceivable`) ou sem NFS-e
  autorizada em todas as linhas (`awaitingNfse`). O limite padrão é 3 dias
  (`CONTRACT_BILLING_GAP_SECONDS`).
- `GET /sales/billing-runs/{id}`: o resultado de cada contrato na rodada (`billed`,
  `skipped`, `refused`) e o motivo.
- `GET /sales/contracts/{id}/billed-periods`: os períodos faturados de um contrato, com o
  título e a NFS-e de cada um.

## Rodar um mês

1. Veja a prévia: `POST /sales/billing-runs/preview` com `{ "competence": "AAAA-MM" }`. Ela
   não grava nada.
2. Confirme com `POST /sales/billing-runs`, com o mesmo corpo e uma `Idempotency-Key`. Antes
   de faturar, a rodada renova os contratos com renovação automática que chegaram ao último
   período.
3. Se a chamada cair no meio, repita com a **mesma chave** ou chame
   `POST /sales/billing-runs/{id}/resume`. Os contratos já decididos não mudam, e os
   pendentes são faturados.
4. Rodar o mês de novo com outra chave não fatura nada duas vezes: os contratos aparecem
   como `skipped` / `already-billed`.

Um mês que ainda não começou é recusado. Meses anteriores podem ser rodados a qualquer
momento.

## Alertas

### SalesBillingRefusals

**Sintoma:** uma rodada recusou contratos.

**Ação:**
1. Abra a rodada e filtre os itens `refused`:
   - `customer-inactive`: o cliente foi desativado no cadastro de partes. Reative-o ou
     cancele o contrato a partir de um período futuro.
   - `service-unavailable`: um serviço do contrato foi desativado no Catálogo. Reative o
     item ou adite o contrato a partir de um período futuro.
2. Depois da correção, rode o mês de novo ou fature o período sozinho:
   `POST /sales/contracts/{id}/periods/{AAAA-MM}/bill`.

### SalesPeriodsWithoutReceivable

**Sintoma:** períodos faturados passaram do limite sem título lançado no Financeiro.

**Ação:**
1. Veja `awaitingReceivable` no overview.
2. Se o título existe em rascunho (`CT-…` na lista de rascunhos do Financeiro), ele espera
   uma pessoa: revise e lance.
3. Se não existe, o evento `sales.contract-period.billed` não chegou. Confira a fila de
   mensagens mortas do Financeiro e o outbox do Sales. Republicar o mesmo evento é seguro:
   o título é chaveado pelo período faturado.

### SalesPeriodsWithoutNfse

**Sintoma:** períodos faturados passaram do limite sem NFS-e autorizada em todas as linhas.

**Ação:**
1. Veja `awaitingNfse` no overview e, no Fiscal,
   `GET /fiscal/service-intakes?documentType=contract-period&period=AAAA-MM`.
2. Uma entrada `drafted` espera revisão na política `review`: valide e emita pela lista de
   trabalho do Fiscal.
3. Uma entrada `blocked` segue o
   [FiscalServiceIntakesBlocked](fiscal-operations-runbook.md#fiscalserviceintakesblocked).

## Crédito de um período

`POST /sales/contracts/{id}/periods/{AAAA-MM}/credit` com o motivo:
- `reasonCode`: `not-provided` (serviço não prestado) ou `billing-error` (faturado errado);
- `reason`: um texto.

O período continua registrado, marcado como creditado, e não é faturado de novo. No
Financeiro, o título é retirado (rascunho), estornado (lançado sem baixa) ou sinalizado
(com baixa). No Fiscal, a NFS-e é cancelada pelo evento 101101, com motivo 2 ou 1. Fora do
prazo municipal, segue o
[FiscalServiceCancellationRefused](fiscal-operations-runbook.md#fiscalservicecancellationrefused).
