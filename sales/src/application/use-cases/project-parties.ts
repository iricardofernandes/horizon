import { type Either, left, right } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { Customer } from '@/domain/entities/customer'
import { CustomerEmail, CustomerName, CustomerPhone } from '@/domain/value-objects/sales-values'
import type { Clock } from '../ports/clock'
import type { SalesScope } from '../ports/unit-of-work'

export interface PartyState {
  readonly tenantId: string
  readonly partyId: string
  readonly legalName: string
  readonly email: string
  readonly phone: string
  readonly address: string
  readonly roles: readonly string[]
  readonly active: boolean
}

export type ProjectionOutcome = 'projected' | 'refreshed' | 'ignored'

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
    const name = CustomerName.create(state.legalName)
    if (name.isLeft()) return left(name.value)
    const email = CustomerEmail.create(state.email)
    if (email.isLeft()) return left(email.value)
    const phone = CustomerPhone.create(state.phone)
    if (phone.isLeft()) return left(phone.value)

    const details = {
      name: name.value,
      email: email.value,
      phone: phone.value,
      address: state.address,
      active: state.active && state.roles.includes('customer'),
    }
    const now = this.clock.now()
    const existing = await scope.customers.findById(state.partyId)
    if (existing) {
      if (!existing.refresh(details, now)) return right('ignored')
      await scope.customers.save(existing)
      return right('refreshed')
    }
    if (!state.roles.includes('customer')) return right('ignored')
    await scope.customers.create(
      Customer.project(
        { ...details, tenantId: state.tenantId, now },
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
