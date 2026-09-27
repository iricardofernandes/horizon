import { type Either, left, right } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { Customer } from '@/domain/entities/customer'
import { CustomerEmail, CustomerName, CustomerPhone } from '@/domain/value-objects/sales-values'
import type { Clock } from '../ports/clock'
import type { SalesScope } from '../ports/unit-of-work'

export interface PartyState {
  readonly tenantId: string
  readonly partyId: string
  readonly legalName: string
  /** Null only for a party that is not a customer: the registry requires them for the role. */
  readonly email: string | null
  readonly phone: string | null
  readonly address: string | null
  readonly roles: readonly string[]
  readonly active: boolean
}

export type ProjectionOutcome = 'projected' | 'refreshed' | 'ignored'

/** An absent contact stays absent; a present one must be valid. */
function nullable<T>(
  value: string | null,
  create: (present: string) => Either<InvalidInputError, T>,
): Either<InvalidInputError, T | null> {
  return value === null ? right(null) : create(value)
}

/**
 * Keep Sales' customer projection in step with the party registry.
 *
 * A party that has never been a customer is not Sales' business and is ignored. One that
 * was, and no longer holds the role, stays projected as inactive: its quotes and orders
 * still reference it, but no new document can be issued to it.
 */
export class ProjectPartyUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: SalesScope,
    state: PartyState,
  ): Promise<Either<InvalidInputError, ProjectionOutcome>> {
    const existing = await scope.customers.findById(state.partyId)
    // A prospect known only by name is not Sales' business, so it is never validated here.
    if (!existing && !state.roles.includes('customer')) return right('ignored')
    const name = CustomerName.create(state.legalName)
    if (name.isLeft()) return left(name.value)
    const email = nullable(state.email, CustomerEmail.create)
    if (email.isLeft()) return left(email.value)
    const phone = nullable(state.phone, CustomerPhone.create)
    if (phone.isLeft()) return left(phone.value)

    const details = {
      name: name.value,
      email: email.value,
      phone: phone.value,
      address: state.address,
      active: state.active && state.roles.includes('customer'),
    }
    const now = this.clock.now()
    if (existing) {
      if (!existing.refresh(details, now)) return right('ignored')
      await scope.customers.save(existing)
      return right('refreshed')
    }
    // The registry requires every contact of a customer, so a new one always carries them.
    if (!details.email || !details.phone || !details.address)
      return left(new InvalidInputError('/email', 'a customer needs email, phone and address'))
    await scope.customers.create(
      Customer.project(
        {
          ...details,
          email: details.email,
          phone: details.phone,
          address: details.address,
          tenantId: state.tenantId,
          now,
        },
        new UniqueEntityID(state.partyId),
      ),
    )
    return right('projected')
  }
}

/** The registry destroyed the subject's key; Sales destroys its own copy (ADR 0026). */
export class ForgetPartyUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(scope: SalesScope, partyId: string): Promise<boolean> {
    const customer = await scope.customers.findById(partyId)
    if (!customer || customer.isErased()) return false
    customer.erase(this.clock.now())
    await scope.customers.erase(customer)
    return true
  }
}
