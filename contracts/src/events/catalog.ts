import { z } from 'zod'
import { currencySchema, quantitySchema, uuidSchema } from '../common'
import { defineEvent } from './define'

const itemId = uuidSchema.describe('Catalog item identifier')

export const catalogItemCreated = defineEvent({
  type: 'catalog.item.created',
  version: 1,
  description:
    'A product or service was added to a tenant catalog and may be referenced by downstream modules.',
  payload: z.object({
    itemId,
    kind: z.enum(['product', 'service']),
    sku: z.string().min(1).max(64),
    name: z.string().min(1).max(160),
    unitId: uuidSchema,
    ncm: z
      .string()
      .regex(/^\d{8}$/)
      .nullable(),
  }),
})

export const catalogItemDeactivated = defineEvent({
  type: 'catalog.item.deactivated',
  version: 1,
  description:
    'A catalog item can no longer be added to new business documents; historical references remain valid.',
  payload: z.object({ itemId }),
})

export const catalogPriceChanged = defineEvent({
  type: 'catalog.price.changed',
  version: 1,
  description:
    'The current amount for an item in a price list changed; existing order snapshots remain unchanged.',
  payload: z.object({
    priceListId: uuidSchema,
    itemId,
    amount: z.string().regex(/^\d+$/),
    currency: currencySchema,
  }),
})

const familyId = uuidSchema.describe('Product family identifier')

/**
 * A group of items that differ only along named axes.
 *
 * The family is not a thing anybody stocks or sells: it is how a catalogue says that
 * these forty shirts are one shirt in forty combinations, so a reader can offer the
 * choice without holding forty unrelated products in its head.
 */
export const catalogFamilyDefined = defineEvent({
  type: 'catalog.family.defined',
  version: 1,
  description:
    'A product family and the ordered attributes its variants differ along were defined.',
  payload: z.object({
    familyId,
    name: z.string().min(1).max(160),
    attributes: z.array(z.string().min(1).max(60)).min(1).max(8),
  }),
})

/**
 * An item took its place in a family, as one combination of its attributes.
 *
 * The item keeps its own SKU, its own stock and its own price: a variant is a product in
 * its own right, and the family only says what makes it different from its siblings.
 */
export const catalogVariantAssigned = defineEvent({
  type: 'catalog.variant.assigned',
  version: 1,
  description: 'A catalog item was placed in a product family as one combination of attributes.',
  payload: z.object({
    itemId,
    familyId,
    values: z
      .array(z.object({ attribute: z.string().min(1).max(60), value: z.string().min(1).max(120) }))
      .min(1)
      .max(8),
  }),
})

/**
 * What an item is made of, from a date.
 *
 * `assembled` is a recipe: the parent is stocked in its own right and something has to
 * make it out of the components. `exploded` is a bundle: the parent is never stocked at
 * all, and wherever it is used it stands for the components underneath it.
 *
 * Versioned and effective-dated, because a recipe changes and the goods made under the
 * old one have to stay explicable. A consumer holds the version it acted on rather than
 * asking again later.
 */
export const catalogCompositionDefined = defineEvent({
  type: 'catalog.composition.defined',
  version: 1,
  description: 'A new version of what a catalog item is made of takes effect from a date.',
  payload: z.object({
    compositionId: uuidSchema,
    parentItemId: itemId,
    version: z.number().int().positive(),
    realisation: z.enum(['assembled', 'exploded']),
    effectiveFrom: z.iso.date(),
    lines: z
      .array(z.object({ componentItemId: itemId, quantity: quantitySchema }))
      .min(1)
      .max(200),
  }),
})
