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

### forecast
A title for money the workspace expects rather than is owed: a confirmed sales order before
it is invoiced. A forecast never posts, so it counts as neither a receivable nor a payable
and never reaches the ledger. Invoicing realises it.

### realisation
Turning a forecast into an effective title, in place. The stage of the same title changes
rather than the forecast being closed and a second title raised, so the expected money and
the claim on the party are never both counted at once.

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

### statement line fingerprint
What identifies a bank line across imports: the bank's own reference when it sends one,
otherwise its date, amount, description and position among identical lines in the file.
A line whose fingerprint is already known is counted as a duplicate and not stored.

### reconciliation
A person's statement that bank lines and book entries describe the same movements, or that
bank lines are to be ignored. It always balances, may apply part of a line or entry, and is
undone rather than deleted.

### match suggestion
A proposed reconciliation built deterministically from amount, date, document number,
counterparty and description, with a score and the reasons behind it. It is never confirmed
without a person.

---

## Ledger

### chart of accounts
The tree of accounts a workspace keeps its books in. Each account has a dotted code that is
its place in the tree — `1.01.001` belongs to `1.01` and nowhere else — and one of five
types: asset, liability, equity, revenue or expense.

### postable account
A leaf that takes lines. A parent is not postable: it exists to total its children. An
account that already takes lines can never be given children, so no total is ever counted
twice.

### normal balance
The side that increases an account, fixed by its type: debit for assets and expenses,
credit for liabilities, equity and revenue. Every balance in every report uses it, so a
credit account with a positive balance means what an accountant expects it to mean.

### journal transaction
A balanced set of lines posted on one date in one currency: at least two lines, and debits
equal to credits. It is never edited; a correction is a mirror transaction with every side
swapped (ADR 0042).

### accounting period
A calendar month, derived from the posting date rather than chosen. Closing one refuses
every posting into it and every reversal inside it; reopening it keeps who did it and why.

### trial balance
Per account, the opening balance, the debits and credits inside a range and the closing
balance. Its two totals are equal, or the ledger is wrong — which is the whole reason the
report exists.

### posting rule
How one fact from another module becomes journal lines: which parts are debited and which
credited, and for how much. The rules are fixed code, because a posting rule is accounting
policy and a rule engine a workspace can edit is a ledger nobody can audit.

### account mapping
Which of a workspace's own accounts plays one part in the posting rules — its receivables
account, its cash account for one bank account, its revenue account for one financial
category. Resolution is exact, then the part's default, then suspense.

### suspense account
Where a posting goes when the part it needs has no account yet. The transaction still
balances and the fact is not lost; an accountant reclassifies it later with a manual entry.

### pending fact
A fact the ledger received but could not post — nothing mapped, or the month already
closed. It waits with the numbers it arrived with and is replayed once the workspace fixes
what blocked it, so the queue never stops and nothing is dropped.

### result of the period
Revenue less expense over a range, by account — an income statement, or DRE. Every figure
is the movement inside the range and never a balance carried into it, which is what makes
two consecutive statements add up to the one that spans both.

### realised cash flow
Cash that actually moved, as the ledger recorded it, over the accounts mapped to the `cash`
part of the postings. Its counterpart is the cash flow outlook.

### cash flow outlook
What is still expected to come in and go out, by the date it falls due. What a posted title
says is owed is reported apart from what a forecast merely expects, because a reader
deciding whether next month is affordable needs to know which of the two a figure is.

### drill-down
Following a figure in a report back to the fact behind it: the report to the account, the
account to its lines, and each line to the receivable, settlement or transfer it accounts
for. It is what makes the books auditable rather than merely arithmetically consistent.

---

## Selling

### quote
An offer to a customer: these goods, at this price, until this date. It is priced from the
catalogue as it stands when it is written and then held, so a price list that moves
afterwards does not change what the customer was offered.

### quote version
A sent quote is never rewritten. Answering one produces a new version beside it, which
supersedes the last and shares the first one's identifier — that shared root is what makes
them one offer rather than several unrelated ones. Exactly one version of an offer is
current at any moment.

### discount allowance
How deep a discount a seller may give without asking anybody, in basis points against the
goods. A discount is judged as a share of what is being sold rather than as an amount: ten
percent off is the same decision on a small order as on a large one. Beyond the allowance
the offer waits for a second person, under [four eyes](#four-eyes); within it, the quote
records that nobody was asked.

### conversion
Turning an accepted quote into the order that delivers it: the same lines, at the prices
that were agreed, under the terms that were negotiated. An accepted quote becomes at most
one order, and the order is confirmed at the quoted price even if the catalogue has moved
in between.

### commercial terms
What a quote or an order says beyond the goods themselves — the seller, the discount, the
freight, the carrier, the payment terms and the notes. They are copied onto the order at
conversion, so the order says what was agreed rather than pointing at the offer.

## Purchasing

### purchase requisition
A request to buy something, carrying no prices. What it asserts is a need — this item, this
quantity, by this date, for this warehouse — and a need is approved or refused on its
merits. What it will cost is discovered afterwards, by asking suppliers.

### supplier quotation
What one supplier said it would charge to meet a requisition: a price per line, plus tax,
freight, other charges and a discount, with payment terms and a lead time. It is a record
of an answer, not a commitment, and it is never revised — a supplier that changes its mind
sends another one, and both stay.

### quotation comparison
Every offer against every line of a requisition, side by side, with the cheapest unit price
per line marked. The mark is per line and is deliberately not a verdict on a quotation as a
whole: freight, lead time and payment terms are part of the decision and a person weighs
them.

### purchase order
The company's commitment to buy: this supplier, these goods, this money, these dates. It
holds its own copy of everything it says, so a price change or a rename afterwards cannot
rewrite what was agreed. A draft may be revised; an approved order is frozen, and a change
of mind is a cancellation.

### approval threshold
The value, per currency, at or above which a purchase order needs a second person. Below it
an order is committed on the spot and records that nobody was asked, so an audit can tell
an exemption from an oversight. A currency with no threshold asks somebody about every
order.

### four eyes
The rule that whoever asked for something cannot be the one who agrees to it: the person
who submits a requisition does not decide it, and the person who places an order does not
approve it.

### payment terms
When a supplier expects to be paid, as days after the order is issued — `30/60/90`. Days
rather than dates, because the terms are agreed before anyone knows which day the order
will be issued on; the dates are derived when the payable is raised.

### goods receipt
One delivery against a purchase order, in part or in full: what arrived, on what day, and
what it made owed. It is the record of a physical event, so it is never edited; a delivery
that turns out to be wrong is returned, and both the receipt and the return stay.

### receipt share
What a delivery makes owed. Tax, freight and the discount are agreed for the order as a
whole, so a partial delivery carries them in proportion to the goods in it. The share is
taken cumulatively and the earlier one subtracted, so the parts always add back up to the
whole and the last delivery of a complete order leaves nothing behind.

### over-receipt
More arriving than was ordered. It is accepted only deliberately and only with a reason,
which is kept: a delivery nobody agreed to is a cost nobody agreed to.

### outstanding quantity
How much of an order line has not arrived. Zero once it all has; what a closed order leaves
outstanding is what it will now never receive.
