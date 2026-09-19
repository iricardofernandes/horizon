# `procurement/`

Purchasing: what somebody needs, what suppliers would charge for it, and what the company
committed to buy.

An independently deployable NestJS service with its own database, its own container and its
own lifecycle. It is reached through Kong at `/procurement`, never directly, and it shares
no source with any other module (ADR 0001). Suppliers come from `parties/` and items from
`catalog/`, as projections it keeps for itself (ADR 0040); it owns neither.

**Status: phase 27 — requisitions, supplier quotations and their comparison, approval
thresholds, purchase orders, and the receiving that turns them into stock and money.**

---

## What this context owns

- **Requisitions** — a request to buy something, deliberately free of money. What a
  requisition asserts is a need: this item, this quantity, by this date, for this
  warehouse. A need is approved or refused on its merits; what it will cost is discovered
  afterwards by asking suppliers, and is decided again on the order. Keeping the two apart
  is what makes the approval of a need auditable separately from the approval of a
  commitment.
- **Quotations** — what one supplier said it would charge. A quotation is a record of an
  answer, not a commitment, so it is never revised: a supplier that changes its mind sends
  another one, and both stay, so the comparison shows what was actually offered and when.
  Every line priced must be a line that was actually asked for.
- **The comparison** — every offer against every line, side by side, with the cheapest unit
  price per line marked. It is marked per line and deliberately not as a verdict on the
  quotation as a whole: freight, lead time and payment terms are part of the decision and a
  person weighs them. Selecting one offer declines the rest in the same transaction, so a
  requisition never has two selected quotations.
- **Purchase orders** — the commitment. Everything an order says is its own copy: the
  supplier's name, each line's description and price, the tax, the freight, the payment
  terms. Nothing is read back from the catalogue or the registry at display time, because
  an order is a document somebody agreed to and a later price change must not rewrite what
  was agreed. A draft is a working document; from approval onward the order is frozen and a
  change of mind is a cancellation, not an edit.
- **Approval thresholds** — the one purchasing decision a workspace configures: the value,
  per currency, at or above which an order needs a second person. Below it an order is
  committed on the spot and records that nobody was asked, so an audit can tell an exemption
  from an oversight. A currency with no policy requires approval for every order: the safe
  reading of "nobody has decided yet" is that somebody should look.
- **Four eyes** — whoever submitted a requisition cannot decide it, and whoever placed an
  order cannot approve it. Both are enforced in the aggregate, and the order's is checked
  again by a database constraint.
- **Receiving** — a delivery against an order, in part or in full. What the goods make owed
  is their share of the order's total, because tax, freight and the discount were agreed
  for the order as a whole; the share is taken cumulatively, so the parts always add back
  up to the whole and the last delivery of a complete order leaves nothing behind. More may
  arrive than was ordered, and sometimes that is fine — but never silently: it takes a
  reason, and the reason is kept, because a delivery nobody agreed to is a cost nobody
  agreed to.
- **Returns** — a delivery sent back. The goods leave stock again, what they made owed is
  withdrawn, and what the order still expects goes back up by the same amount, because a
  rejected delivery is a delivery the supplier still owes. The receipt and the return both
  stay in the record; neither replaces the other (ADR 0042).
- **Closing** — an order stops expecting anything more, either because everything arrived
  or because a person said so, with a reason. Whatever was still committed stops being
  expected. An order that has taken delivery is closed rather than cancelled: cancelling
  something that already happened is not a thing anyone can do.

## Events

| Event | Meaning |
|---|---|
| `procurement.requisition.submitted` | Somebody asked for something and sent it for a decision |
| `procurement.requisition.approved` | The need was agreed, and is open to being answered |
| `procurement.requisition.rejected` | The need was refused, with the reason |
| `procurement.order.placed` | An order was submitted, saying whether it needs approval |
| `procurement.order.approved` | The company committed to buy, with the dated payment schedule |
| `procurement.order.rejected` | An order waiting for approval was refused |
| `procurement.order.cancelled` | An order was withdrawn, saying whether anything was committed |
| `procurement.receipt.recorded` | Goods arrived: what they are worth, what is still committed |
| `procurement.receipt.returned` | A delivery went back, and what the order expects again |
| `procurement.order.closed` | Nothing more is expected, complete or closed short |

It consumes `parties.party.registered`, `parties.party.updated` and `parties.party.erased`
to keep its supplier projection, and `catalog.item.created` and `catalog.item.deactivated`
to know what an item is called.

`procurement.order.approved` carries the payment schedule the agreed terms imply, already
dated, so no consumer has to know that the terms were expressed as day offsets.
`procurement.receipt.recorded` carries two such schedules: one for what the delivery made
owed, and one for what is still committed and has not arrived. `inventory/` moves the stock
from it and `financial/` raises the payable from it, so the goods on the shelf and the money
owed for them can never disagree about what arrived.

Every command that creates a document requires an `Idempotency-Key` header (ADR 0028); a
decision on a document that already exists does not, because repeating one is refused by
the document's own state. Every command is written to a per-tenant hash-chained audit log.

## Authorization

| Role | Reads | Writes and places | Decides | Sets thresholds |
|---|---|---|---|---|
| `procurement:admin` | yes | yes | yes | yes |
| `procurement:buyer` | yes | yes | — | — |
| `procurement:approver` | yes | — | yes | — |
| `procurement:viewer` | yes | — | — | — |

The split that matters is between placing and deciding: a buyer writes requisitions,
records what suppliers answered, chooses between them and places the order; an approver
decides whether the company will stand behind it. Giving one person both is a workspace
decision — grant them the admin role — but it is never the accident of a role map.

## Running it

```sh
cp .env.example .env
npm install
npm run db:migrate
npm run dev
```

`npm test` runs the domain tests: what a requisition will and will not accept, how a total
is built from lines, tax, charges and a discount, how payment terms split a total that does
not divide evenly without losing a minor unit, and the four-eyes rule on both documents.

`npm run test:e2e` starts PostgreSQL with Testcontainers and proves the path from a need to
a commitment to a delivery — requisition, approval, two quotations, the comparison, the
selection that declines the other, the order written from what was chosen, and two partial
deliveries whose values add back up to the order exactly. It also proves idempotent
creation and idempotent receiving, a requisition being answered by at most one order, a
threshold committing one order and holding another, an over-receipt refused until somebody
says why, a return putting back what it took away, the published payloads matching their
contracts, the lines of a committed order refusing to change under any role, goods refused
against an order nobody committed to, one workspace being invisible to another, and the
audit log refusing to be rewritten.
