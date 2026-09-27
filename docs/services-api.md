# Services API reference

Service orders, contracts and billing live in `sales/` ([ADR 0056](adr/0056-services-are-delivered-by-service-orders-inside-sales.md)).
Through Kong every path below is prefixed with `/sales`; the web proxies it as
`/api/horizon/sales`. Money is in minor units as a string, dates are `YYYY-MM-DD` UTC days
and a competence month is `YYYY-MM`.

- **Roles:** `read` routes take any Sales role; `manage` routes take `admin` or
  `representative`.
- **Idempotency:** commands that create something require an `Idempotency-Key` header. A
  retry with the same key and body answers what the first call answered (ADR 0028).
- **Errors:** `400` for invalid input, `404` for an unknown document, `409` for a refusal of
  the document's own state, with its reason in `message`.

Events are listed in [events.md](events.md); operation is in the
[runbook](services-billing-runbook.md).

## Service orders

| Method | Path | Role | Key | What it does |
|---|---|---|---|---|
| `GET` | `/service-orders` | read | | Recent service orders, newest first |
| `GET` | `/service-orders/{id}` | read | | One order: lines with delivered quantities, deliveries, and per delivery `receivable` (`titleId`, `postedAt`, `reversedAt`) and per line `nfse` (`documentId`, `status`) as Financial and Fiscal reported them |
| `POST` | `/service-orders` | manage | yes | Open an order: `customerId`, `lines[]` (`lineId`, `itemId`, `quantity`), optional `terms` (`discount`, `paymentTermDays`) and `scheduledFor` |
| `POST` | `/service-orders/{id}/start` | manage | | `scheduled` → `in_progress` |
| `POST` | `/service-orders/{id}/deliveries` | manage | yes | Record work: `lines[]` (`lineId`, `quantity`) or everything still owed, and `performedOn` |
| `POST` | `/service-orders/{id}/accept` | manage | | Record the customer's acceptance of a completed order |
| `POST` | `/service-orders/{id}/cancel` | manage | | Cancel an order with no active delivery: `reason` |
| `POST` | `/service-orders/{id}/deliveries/{deliveryId}/cancel` | manage | | The work was not provided: `reason`. The delivery stays, cancelled |

A proposal with service lines becomes a service order through
`POST /quotes/{id}/order`; the answer names `orderId` and `serviceOrderId`.

```http
POST /sales/service-orders/0194…/deliveries
Idempotency-Key: 6f1c…
{ "lines": [{ "lineId": "0194…", "quantity": "1" }], "performedOn": "2026-09-27" }

201 { "deliveryId": "0194…", "value": "50000", "status": "in_progress" }
```

## Contracts

| Method | Path | Role | Key | What it does |
|---|---|---|---|---|
| `GET` | `/contracts` | read | | Recent contracts with revisions, suspensions and `status` today |
| `GET` | `/contracts/{id}` | read | | One contract |
| `GET` | `/contracts/{id}/schedule?from=&to=` | read | | Periods in the range: `competence`, `billingOn`, `revision`, `amount`, `billable`, `excluded`, `billedPeriodId`, `credited` |
| `GET` | `/contracts/{id}/billed-periods` | read | | Every billed period, frozen, with `credit`, `receivable` and per line `nfse` |
| `POST` | `/contracts` | manage | yes | Draft: `customerId`, `lines[]` (optional negotiated `unitPrice`), `recurrence`, `startsOn` (a first of month), optional `endsOn` (a period end), `billingDay` (1–28), `autoRenew`, `paymentTermDays` |
| `POST` | `/contracts/{id}/activate` | manage | | Put a draft into effect |
| `POST` | `/contracts/{id}/amendments` | manage | yes | New revision from a future, unbilled period start: `effectiveFrom`, `lines[]`, `recurrence`, `reason` (10+ characters) |
| `POST` | `/contracts/{id}/suspensions` | manage | | Suspend from a period start, optionally `until` another: `from`, `reason` |
| `POST` | `/contracts/{id}/resume` | manage | | End the open suspension at a period start: `at` |
| `POST` | `/contracts/{id}/cancel` | manage | | Stop from a period start: `from`, `reason` |
| `POST` | `/contracts/{id}/renewals` | manage | yes | Renew for the original term: optional `readjustmentBasisPoints`, `reason` |
| `POST` | `/contracts/renewals` | manage | | Renew every self-renewing contract whose last period began |
| `POST` | `/contracts/{id}/periods/{competence}/bill` | manage | yes | Bill one due period now; `409` names why it cannot be billed |
| `POST` | `/contracts/{id}/periods/{competence}/credit` | manage | yes | Credit a billed period in full: `reasonCode` (`not-provided` or `billing-error`), `reason` |

```http
POST /sales/contracts/0194…/periods/2026-09/credit
Idempotency-Key: 9a2e…
{ "reasonCode": "billing-error", "reason": "Faturado com o posto errado" }

201 { "contractId": "0194…", "billedPeriodId": "0194…", "competence": "2026-09" }
```

## Billing runs

| Method | Path | Role | Key | What it does |
|---|---|---|---|---|
| `POST` | `/billing-runs/preview` | read | | What a run of `competence` would do per contract, and why; writes nothing |
| `POST` | `/billing-runs` | manage | yes | Run `competence`: renew due contracts, then bill contract by contract. The same key returns the same run and finishes what is pending |
| `POST` | `/billing-runs/{id}/resume` | manage | | Carry on with a run that stopped midway |
| `GET` | `/billing-runs?competence=` | read | | Recent runs with `totals` |
| `GET` | `/billing-runs/{id}` | read | | One run and its `items` (`outcome`, `reason`, `billedPeriodId`) |
| `GET` | `/contract-billing/overview` | read | | Recent runs, and billed periods past `CONTRACT_BILLING_GAP_SECONDS` without a posted receivable (`awaitingReceivable`) or an authorized NFS-e (`awaitingNfse`) |

Outcomes are `billed`, `skipped` (`already-billed`, `suspended`, `cancelled`,
`not-due-yet`, `nothing-to-bill`) and `refused` (`customer-inactive`,
`service-unavailable`). A month that has not begun answers `409`.

```http
POST /sales/billing-runs
Idempotency-Key: 3b7d…
{ "competence": "2026-09" }

201 {
  "id": "0194…", "competence": "2026-09", "status": "completed",
  "totals": { "pending": 0, "billed": 1, "skipped": 0, "refused": 1 },
  "items": [
    { "contractId": "0194…", "outcome": "billed", "reason": null, "billedPeriodId": "0194…" },
    { "contractId": "0194…", "outcome": "refused", "reason": "service-unavailable", "billedPeriodId": null }
  ]
}
```

## Fiscal intakes

Fiscal's `GET /fiscal/service-intakes` lists the NFS-e intake of every billed line. It
takes the filters `status`, `documentType` (`service-delivery` or `contract-period`) and
`period`. `POST /fiscal/service-intakes/{id}/retry` retries a blocked one.
