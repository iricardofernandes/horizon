# Runbook de serviços e do faturamento de contratos

Operação das ordens de serviço, dos contratos e das rodadas de faturamento (fases 50 a 53,
[ADR 0056](adr/0056-services-are-delivered-by-service-orders-inside-sales.md)). A
referência das rotas está em [services-api.md](services-api.md), e os riscos em
[services-threat-model.md](services-threat-model.md).

## Telas

Todas ficam no grupo Vendas e exigem um papel no Sales. Criar, decidir e faturar pedem
`admin` ou `representative`; `viewer` só lê.

| Tela | Para quê |
|---|---|
| **Ordens de serviço** (`/app/sales/service-orders`) | Quadro por etapa. O detalhe mostra o que foi vendido, entregue e o que falta, e cada entrega com o título e a NFS-e. Abrir, iniciar, registrar entrega, aceitar, cancelar a ordem ou uma entrega. |
| **Contratos** (`/app/sales/contracts`) | Lista com a situação de hoje. O detalhe tem quatro abas: resumo e decisões, revisões (aditivo e renovação), cronograma (faturar um período devido) e faturados (título, NFS-e e crédito). |
| **Faturamento de contratos** (`/app/sales/billing`) | Prévia e rodada de um mês, rodadas recentes e os períodos que esperam título ou NFS-e. |
| **Clientes** → **Serviços** | As ordens de serviço e os contratos de um cliente. |

"Ver no Financeiro" abre o título lançado, ou procura a referência (`SV-…` ou `CT-…`) na
lista de contas a receber quando ele ainda é rascunho. "Ver documento" abre a NFS-e na tela
de documentos do Fiscal. Um título de entrega cancelada ou de período creditado que nunca
foi lançado aparece como "retirado".

## Operação do dia a dia

1. **Serviço avulso:** a proposta aceita vira ordem de serviço (ou a ordem é aberta direto).
   Registre cada entrega no dia em que o trabalho foi feito. O cliente aceita no fim.
2. **Contrato:** crie o rascunho, confira o cronograma e ative. Mudanças valem a partir de
   um período futuro ainda não faturado.
3. **Todo mês:** abra "Faturamento de contratos", veja a prévia do mês e fature. Resolva as
   recusas (abaixo) e fature de novo: o que já foi faturado aparece como pulado.
4. **Semanalmente:** confira os períodos esperando título ou NFS-e. Na política `review`,
   as NFS-e esperam alguém validar e emitir na lista do Fiscal.

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

## Evidências e restauração

- `node scripts/phase53-golden-path.mjs` percorre os dois fluxos pela API:
  - proposta → ordem de serviço → entrega → título e NFS-e;
  - contrato → dois meses faturados → aditivo → rodada repetida sem duplicar → crédito.
- `node web/scripts/services-workflow.e2e.mjs` faz o mesmo pelas telas, em pt-BR e en.
- `scripts/phase53-restore-check.sh [tenant]` restaura um dump do `horizon_sales` num
  PostgreSQL novo. Ele compara o digest de cada tabela de serviço do tenant, vivo contra
  restaurado, e confirma que as guardas continuam valendo:
  - período, linha, entrega e item de rodada recusam reescrita;
  - revisões só aceitam inclusão;
  - outro tenant não vê nada.

  Os efeitos que o Sales acompanha (título lançado e NFS-e) são projeções. Se o backup do
  Sales for mais antigo que o do Financeiro ou o do Fiscal, republicar os eventos dos
  donos os reconstrói.
