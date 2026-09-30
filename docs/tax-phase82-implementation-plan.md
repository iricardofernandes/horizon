# Phase 82 — Decisions, the reform's source matrix, and a shared catalogue

Status: **delivered on 2026-09-30** ([evidence](tax-phase82-evidence.md)). The first phase of the [tax rules engine plan](tax-engine-plan.md)
(Phase O).

## Result

After this phase:
- **Four decisions are recorded:** ADRs 0070–0073.
- **The reform's sources are pinned:** the constitutional amendment, the complementary law
  and the official calculator, each with a digest, a retrieval date and the sections
  Phase O uses.
- **Tax law lives in one catalogue that every workspace reads and none can write:**
  - a workspace **adopts** a package version from a date, with a named reviewer and an
    interpretation;
  - its own rows stay for what is its own;
  - resolution reads both, with Phase 41's precedence.
- **Phase 41's package is the catalogue's first version,** with its package and rule ids
  preserved. The demo workspace adopts it, its own copy is retired, and the approved
  golden result is reproduced with the same digests.

## Starting point (checked on 2026-09-30)

- `fiscal_source_packages`, `fiscal_reference_entries`, `fiscal_tax_rules`,
  `fiscal_package_reviews` and `fiscal_rule_activation_events` all carry `tenant_id`, under
  forced RLS.
- The local stack holds six packages:
  - Phase 41's, in the demo workspace;
  - five from the Phase 42–47 drills, in one drill workspace.

  There are 22 rules and 95 calculations.
- `FiscalRuleStore.resolve` reads only the tenant's rows. `resolveTaxRules` filters inactive
  rules and refuses unapproved sources and ties.
- A calculation lock stores its input, its resolved rules and its result bytes, and
  `replay` recomputes from them. A lock never depends on the rule tables again.
- The result's `rulesDigest` covers each rule's id and version and its source's package
  id, digest, URI, section and approval, so the golden digests hold only if those survive
  the move.

## Decisions

1. **The catalogue is global and read-only to the application.**
   - `fiscal_catalog_packages`, `fiscal_catalog_references` and `fiscal_catalog_rules` have
     no `tenant_id`.
   - The application role may only `SELECT` them. Publishing uses the migration role, from
     a CLI.
   - Rows are immutable, like every Fiscal record table.
2. **Catalogue rules are law, not a workspace's facts.** Their precedence is `operation`
   or `default`, and a check forbids establishment, party and item scopes.
3. **Adoption is an append-only event per workspace:**
   - `adopt` names the package, the date it applies from, the reviewer, the interpretation
     and the fixtures;
   - `withdraw` names the reason;
   - the latest event decides;
   - adopted rules count as approved, and their window starts at the later of the rule's
     own start and the adoption's.
4. **Adoption refuses a clash.** If an active workspace rule has the same component,
   precedence, priority and scope as a package rule, over an overlapping window, the
   adoption is refused. It would make resolution ambiguous. The workspace retires its copy
   first (a `deactivate` event with a reason).
5. **Identity is preserved for Phase 41.**
   - Catalogue version 1 keeps package `2dd2ffbe-…`, its digest and URI, and the three rule
     ids of the approved fixture.
   - New packages get ids derived from the catalogue, not from a tenant.
6. **The other drill packages stay workspace rows.** They are simulation fixtures of Phases
   42–47. Phases 84–86 publish the law they stand for.

## Proof

- **e2e (`test/catalog.e2e-spec.ts`):**
  - the application role cannot write to the catalogue;
  - two workspaces adopt the same package and calculate the same components and rules
    digest;
  - the fixture's own input reproduces the approved result byte for byte from the
    catalogue;
  - an unadopted workspace is unsupported;
  - a withdrawn adoption stops applying, and a locked calculation still replays;
  - an adoption from a later date does not apply before it;
  - an adoption that clashes with an active workspace rule is refused until that rule is
    retired;
  - a catalogue rule scoped to an establishment is refused.
- **On the stack:**
  - `phase82:catalog publish-phase41`, then the demo workspace's retirement and adoption;
  - a preview of the golden input gives the approved result digest;
  - the Phase 41 document's frozen explanation and replay are unchanged.
- **The source matrix** (`docs/tax-phase82-source-matrix.md` and its JSON manifest), with
  the digests of the files actually retrieved.
