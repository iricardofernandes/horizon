# Glossary

Horizon is written entirely in English — code, identifiers, comments, commits, READMEs
and ADRs. The one exception is **Brazilian fiscal terminology with no English
equivalent**, which stays in its original form because translating it would produce
identifiers that neither a Brazilian accountant nor an international engineer would
recognise.

Those terms are defined here, in universal language. A reviewer who has never worked in
Brazil should be able to read any part of this repository after this page.

---

## Brazilian fiscal and legal terms

### `cnpj`
*Cadastro Nacional da Pessoa Jurídica.* The national registry number identifying a
**legal entity** (a company). Fourteen digits with two check digits. Structurally
comparable to an EIN in the United States, a UK company number, or an EU VAT
identification number — but unlike a VAT number it is mandatory for every registered
company and is the primary key of corporate identity across the entire tax system.

Modelled as a `Cnpj` value object that validates its check digits in the constructor
(ADR 0031). Personal data when it identifies a sole trader, and therefore encrypted
(ADR 0026).

### `cpf`
*Cadastro de Pessoas Físicas.* The equivalent for a **natural person**: eleven digits
with two check digits, comparable to a US Social Security Number or a UK National
Insurance number in role, though used far more widely in commerce. Always personal data.

### `nfe`
*Nota Fiscal Eletrônica.* An **electronic fiscal document** — a legally binding XML
invoice that must be transmitted to and authorised by the tax authority *before* goods
may be shipped. This is the part with no equivalent in most jurisdictions: it is not a
commercial invoice sent to a customer, but a government-authorised document without
which a shipment is contraband. There is a variant for services (`nfse`, municipal) and
one for transport (`cte`).

Out of scope. Generating and transmitting one belongs to `fiscal/`
([roadmap](roadmap.md)), which will scope itself to the calculation engine and document
that certificate handling and transmission are omitted rather than half-implemented.

### `sped`
*Sistema Público de Escrituração Digital.* The **digital bookkeeping regime**: a family
of mandatory periodic filings in which a company submits its accounting and fiscal
ledgers to the tax authority in a fixed layout. Comparable in spirit to SAF-T in the
EU, but broader and with more frequent obligations.

Out of scope, and explicitly listed as an omission of `fiscal/`.

### `icms`
*Imposto sobre Circulação de Mercadorias e Serviços.* A **state-level value-added tax on
goods and some services**. Its rate depends on the origin state, the destination state,
the product classification and the buyer's tax status, and rules differ across 27
jurisdictions — which is why tax in this domain is a rules engine and not a rate column.
Related taxes in the same calculation are `ipi` (federal, manufactured goods), `pis` and
`cofins` (federal, on revenue), and `iss` (municipal, services).

### `ibs` / `cbs`
The **new dual VAT** introduced by Brazil's 2023 tax reform: `ibs` at the
state and municipal level, `cbs` at the federal level, progressively replacing the taxes
above across a transition running to 2033.

This is the fact that makes `fiscal/` interesting rather than tedious: **two complete
tax regimes are simultaneously in force for several years**, with a published phase-in
schedule, and a document must be calculated under whichever combination applied on its
own date — including years later, when it is recalculated for an audit. Framed
universally, that is a versioned, temporally-scoped, jurisdiction-scoped rules engine
with a hard determinism requirement, and almost no portfolio project has a legitimate
reason to build one.

### `cfop`
*Código Fiscal de Operações e Prestações.* A four-digit code classifying **what kind of
transaction** is occurring — sale, return, transfer, consignment, in-state or
interstate. It drives which tax rules apply. Roughly analogous to an EU VAT transaction
type code, but finer-grained and mandatory on every line of a fiscal document.

### `ncm`
*Nomenclatura Comum do Mercosul.* An eight-digit **product classification code**, the
Mercosur extension of the international Harmonised System (HS) used for customs
worldwide. The first six digits are the global HS code; the last two are regional.

This one **is** in scope: `catalog/` stores an item's NCM as a classification. What that
classification implies for tax is `fiscal/`'s problem, not `catalog/`'s.

### `sefaz`
*Secretaria da Fazenda.* A **state tax authority** — the government service that
authorises fiscal documents. There are 27 of them, each with its own endpoints and
availability.

`fiscal/` will define a SEFAZ **port** with a deterministic mock adapter as the default,
so the module is fully testable and demonstrable with no external dependency and no
digital certificate.

### `lgpd`
*Lei Geral de Proteção de Dados.* Brazil's **general data protection law**, closely
modelled on the GDPR. Its Art. 18 erasure right is what makes crypto-shredding
necessary; see [`privacy.md`](privacy.md) and ADR 0026.

---

## Horizon terms

Terms that mean something specific in this codebase.

### Aggregate
A cluster of domain objects treated as one consistency boundary, with a single root
entity through which all changes pass. An `Order` and its `OrderLines` are one
aggregate; a repository loads and saves the whole thing.

### Blind index
A keyed HMAC of a normalised personal value, stored alongside the ciphertext so an
**exact-match** lookup (logging in by email) remains possible on encrypted data. It
supports equality and nothing else — no ranges, no partial matches — and is dropped at
erasure along with the subject's key.

### Golden path
The end-to-end flow that must always work and always be green: create sales order →
reserve stock → confirm order → publish `sales.order.confirmed` → deliver a signed
webhook. It appears as **one trace** in Jaeger crossing three services and RabbitMQ, runs
as a CI job on every push, and is the highest-priority deliverable in the project.

### Inbox
A table with a unique constraint on `(source_module, event_id)`, written inside the same
transaction as the effect a consumed event produces. It is what turns at-least-once
delivery into exactly-once processing.

### Outbox
A table written inside the same transaction as the domain change it announces, drained
by a relay that publishes to RabbitMQ. It is what makes "the state changed" and "the
event exists" a single atomic fact.

### Snapshot
The frozen, read-only struct returned by an aggregate's single `toSnapshot()` method.
Entities expose behaviour rather than accessors, so this is the only sanctioned way data
leaves an aggregate, and it may only be called from `infrastructure/` and tests.

### Tenant
The isolation unit. Every business table carries `tenant_id`, every request resolves one
from its token, and every query runs inside a transaction that has declared it.

### `TenantAwareTransaction`
The only way to reach the database. It opens a transaction, issues
`SET LOCAL app.current_tenant`, and runs the caller's work. The Drizzle client itself is
never exported, so no repository can bypass it.

---

## Registrations

### party
An organization or a natural person the business deals with, recorded once per tax
identifier in `parties/` (ADR 0040). Other contexts reference it by its id and keep their
own projection of the fields they need.

### party role
What a party is to the business: `customer`, `supplier`, `carrier`, `prospect` or
`partner`. A set, not a type — one company being both a customer and a supplier is the
ordinary case, and revoking a role never deletes the party.

---

## Financial

### financial category
What money is for — revenue or expense — as a node in a tree of at most four levels. A
child always shares its parent's nature, so a cash flow or a DRE built on the tree cannot
count an expense as revenue.

### department and project
Who money is for. An amount is allocated across them by percentage, and the allocation
must total exactly 100%.

### payment term
How an amount is split into installments and how many days after issue each falls due —
"30/60/90". Shares total exactly 100%, and the installment amounts are allocated so they
add up to the total to the last minor unit.

### basis point
One hundredth of a percent. Shares are stored as whole basis points (10 000 is 100%) so
that they add up exactly (ADR 0043).


### title
One claim — receivable or payable — split into installments and settled over time. A
draft may be revised or cancelled; once posted it is settled or reversed, never edited
(ADR 0042).

### settlement
Money received or paid against one installment. `received` is the cash that moved,
`discount` reduces what is owed without cash, `interest` and `penalty` add to it. A
settlement is undone by reversing it, with a reason, and stays in the record.

### outstanding balance
What an installment still owes: its amount plus interest and penalties minus receipts and
discounts, over the settlements still in force. Never below zero.

### aging
Outstanding balances grouped by how late they are at a given calendar date: not yet due,
1–30, 31–60, 61–90 and over 90 days.

### approval policy
The amount, per currency, from which a payable needs a second person before it posts.
Below it a payable posts directly and is recorded as exempt; with no policy every payable
needs approval. The person who requests an approval can never decide it (four eyes).

---

## Treasury

### book balance
What an account holds according to Horizon's own journal through a calendar date: inflows
minus outflows by value date. It is always labelled as the ERP's figure and never presented
as the bank's live balance.

### value date
The day money actually moved in or out of an account, which may be earlier or later than
the day it was recorded. Every balance and statement is ordered by it, so a backdated entry
changes later balances without rewriting anything.

### transfer leg
One of the journal entries a transfer is made of: the outflow from the source account, the
inflow into the destination and, when there is one, the fee charged to the source. All of
them are committed together or not at all.
