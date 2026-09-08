import { z } from 'zod'

/**
 * Primitives shared by every event payload and every cross-module HTTP body.
 *
 * These exist so that "an id", "a timestamp" and "an amount of money" have exactly one
 * definition in the system. A module that invents its own is a module whose wire format
 * has quietly diverged.
 */

/**
 * Every public identifier is a UUIDv7 generated in the application layer (ADR 0009).
 * The schema validates the shape, not the version — a v4 arriving from an older record
 * is still a legal identifier, and rejecting it would be a compatibility break with no
 * safety benefit.
 */
export const uuidSchema = z.uuid()

export const tenantIdSchema = uuidSchema.describe('The tenant every row is scoped by')

/**
 * UTC instant, ISO 8601. Storage is `timestamptz` and comparison is always UTC; the
 * tenant's timezone is applied at presentation only (ADR 0011).
 */
export const instantSchema = z.iso.datetime({ offset: true })

/**
 * A calendar date with no instant attached — a due date, a fiscal competence period.
 * Deliberately distinct from `instantSchema`: converting one of these through a timezone
 * corrupts it, producing off-by-one-day errors for tenants west of UTC.
 */
export const dateSchema = z.iso.date()

/** ISO 4217. */
export const currencySchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/)

/**
 * Money crosses the wire as an integer count of minor units **encoded as a string**,
 * plus an explicit currency (ADR 0010).
 *
 * A string because the underlying value is a `bigint`, which JSON cannot represent and
 * `JSON.stringify` throws on. A number would silently lose precision above 2^53, which
 * is exactly the failure the integer representation exists to prevent.
 *
 * The number of minor units per major unit is a property of the currency and is not
 * assumed to be 100.
 */
export const moneySchema = z.object({
  amount: z
    .string()
    .regex(/^-?\d+$/, 'must be an integer count of minor units, as a string')
    .describe('Integer minor units, e.g. "123456" for 1234.56 in a two-decimal currency'),
  currency: currencySchema,
})

export type Money = z.infer<typeof moneySchema>

/** A non-negative decimal quantity, as a string, for the same reason money is. */
export const quantitySchema = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'must be a non-negative decimal with at most 6 places')

export type Uuid = z.infer<typeof uuidSchema>
export type TenantId = z.infer<typeof tenantIdSchema>
export type Instant = z.infer<typeof instantSchema>
