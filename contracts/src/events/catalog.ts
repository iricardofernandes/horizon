import { z } from 'zod'
import { currencySchema, uuidSchema } from '../common'
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
