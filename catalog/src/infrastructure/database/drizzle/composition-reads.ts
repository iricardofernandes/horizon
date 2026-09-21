import { sql } from 'drizzle-orm'
import { ComponentQuantity } from '@/domain/value-objects/catalog-values'
import type { Transaction } from './catalog-database'

/**
 * What an item is made of, read rather than rehydrated.
 *
 * A screen asking what goes into a chair has no business loading an aggregate, and the
 * question it really wants answered — what do I need to *make* one, all the way down —
 * is a walk through the graph that no single aggregate can see.
 */

const MICROS = sql.raw('1000000')

/** How deep the walk goes before a catalogue is admitting it has a problem. */
const DEEPEST = sql.raw('32')

const quantity = (micros: string | bigint) =>
  ComponentQuantity.fromMicros(BigInt(micros)).toString()

export interface CompositionComponent {
  readonly componentItemId: string
  readonly sku: string
  readonly name: string
  readonly quantity: string
}

export interface CompositionView {
  readonly compositionId: string
  readonly parentItemId: string
  readonly version: number
  readonly realisation: string
  readonly effectiveFrom: string
  readonly definedBy: string
  readonly components: readonly CompositionComponent[]
}

/** The version in force on a day: the latest one whose date has arrived. */
export async function compositionInForce(
  tx: Transaction,
  request: { parentItemId: string; on: string },
): Promise<CompositionView | null> {
  const [row] = await tx.execute<{
    id: string
    parent_item_id: string
    version: number
    realisation: string
    effective_from: string
    defined_by: string
  }>(sql`
    select c.id, c.parent_item_id, c.version, c.realisation,
      c.effective_from::text, c.defined_by
    from compositions c
    where c.parent_item_id = ${request.parentItemId}
      and c.effective_from <= ${request.on}::date
    order by c.effective_from desc, c.version desc
    limit 1
  `)
  if (!row) return null
  const components = await tx.execute<{
    component_item_id: string
    sku: string
    name: string
    quantity: string
  }>(sql`
    select l.component_item_id, i.sku, i.name, l.quantity::text
    from composition_lines l
    join catalog_items i on i.id = l.component_item_id
    where l.composition_id = ${row.id}
    order by i.sku
  `)
  return {
    compositionId: row.id,
    parentItemId: row.parent_item_id,
    version: row.version,
    realisation: row.realisation,
    effectiveFrom: row.effective_from,
    definedBy: row.defined_by,
    components: [...components].map((component) => ({
      componentItemId: component.component_item_id,
      sku: component.sku,
      name: component.name,
      quantity: quantity(component.quantity),
    })),
  }
}

export interface ExplodedComponent extends CompositionComponent {
  readonly depth: number
  /** Whether this component is itself made of something, at the date asked about. */
  readonly compound: boolean
}

/**
 * Everything one of the parent needs, all the way down.
 *
 * Quantities multiply through the levels, so four legs of two screws each is eight
 * screws, and a part that turns up under two different sub-assemblies is summed rather
 * than listed twice. Only the leaves are returned by default — the things somebody
 * actually has to have in a warehouse — because a list that mixed a chair's sub-assembly
 * with the screws inside it would be double-counting in plain sight.
 *
 * The walk is bounded. A catalogue deep enough to hit the limit has a problem the report
 * cannot fix, and looping forever while it decides would not help anybody.
 */
export async function explodeComposition(
  tx: Transaction,
  request: { parentItemId: string; on: string; leavesOnly: boolean },
): Promise<readonly ExplodedComponent[]> {
  const rows = await tx.execute<{
    component_item_id: string
    sku: string
    name: string
    quantity: string
    depth: number
    compound: boolean
  }>(sql`
    with recursive tree as (
      select l.component_item_id, l.quantity::numeric as quantity, 1 as depth
      from compositions c
      join composition_lines l on l.composition_id = c.id
      where c.id = (
        select c2.id from compositions c2
        where c2.parent_item_id = ${request.parentItemId}
          and c2.effective_from <= ${request.on}::date
        order by c2.effective_from desc, c2.version desc
        limit 1
      )
      union all
      select l.component_item_id,
        -- One of the parent needs this many of the child, of which the parent itself is
        -- needed this many times: the levels multiply rather than add.
        t.quantity * l.quantity / ${MICROS},
        t.depth + 1
      from tree t
      join compositions c on c.id = (
        select c2.id from compositions c2
        where c2.parent_item_id = t.component_item_id
          and c2.effective_from <= ${request.on}::date
        order by c2.effective_from desc, c2.version desc
        limit 1
      )
      join composition_lines l on l.composition_id = c.id
      where t.depth < ${DEEPEST}
    ),
    rolled as (
      select t.component_item_id, sum(t.quantity) as quantity, min(t.depth) as depth
      from tree t
      group by t.component_item_id
    )
    select r.component_item_id, i.sku, i.name, round(r.quantity)::text as quantity, r.depth,
      exists (
        select 1 from compositions c
        where c.parent_item_id = r.component_item_id and c.effective_from <= ${request.on}::date
      ) as compound
    from rolled r
    join catalog_items i on i.id = r.component_item_id
    ${
      request.leavesOnly
        ? sql`where not exists (
      select 1 from compositions c
      where c.parent_item_id = r.component_item_id and c.effective_from <= ${request.on}::date
    )`
        : sql``
    }
    order by r.depth, i.sku
  `)
  return [...rows].map((row) => ({
    componentItemId: row.component_item_id,
    sku: row.sku,
    name: row.name,
    quantity: quantity(row.quantity),
    depth: row.depth,
    compound: row.compound,
  }))
}

export interface VariantRow {
  readonly itemId: string
  readonly sku: string
  readonly name: string
  readonly active: boolean
  readonly values: readonly { attribute: string; value: string }[]
}

/** The items in a family, each with the answers that tell it from its siblings. */
export async function listVariants(
  tx: Transaction,
  request: { familyId: string; limit: number; offset: number },
): Promise<readonly VariantRow[]> {
  const rows = await tx.execute<{
    item_id: string
    sku: string
    name: string
    active: number
    values: { attribute: string; value: string }[]
  }>(sql`
    select v.item_id, i.sku, i.name, i.active, v.values
    from item_variants v
    join catalog_items i on i.id = v.item_id
    where v.family_id = ${request.familyId}
    order by v.combination
    limit ${request.limit} offset ${request.offset}
  `)
  return [...rows].map((row) => ({
    itemId: row.item_id,
    sku: row.sku,
    name: row.name,
    active: row.active === 1,
    values: row.values,
  }))
}
