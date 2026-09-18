import { type Either, left, right } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { Supplier } from '@/domain/entities/supplier'
import { PartyName } from '@/domain/value-objects/procurement-values'
import type { Clock } from '../ports/clock'
import type { ProcurementScope } from '../ports/unit-of-work'

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
 * Keep Procurement's supplier projection in step with the party registry.
 *
 * A party that has never been a supplier is not Procurement's business and is ignored. One
 * that was, and no longer holds the role, stays projected as inactive: the orders already
 * placed with it still reference it and still have to be readable, but no new order can be
 * written to it.
 */
export class ProjectPartyUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: ProcurementScope,
    state: PartyState,
  ): Promise<Either<InvalidInputError, ProjectionOutcome>> {
    const name = PartyName.create(state.legalName)
    if (name.isLeft()) return left(name.value)
    const details = {
      name: name.value,
      email: state.email,
      phone: state.phone,
      address: state.address,
      active: state.active && state.roles.includes('supplier'),
    }
    const now = this.clock.now()
    const existing = await scope.suppliers.findById(state.partyId)
    if (existing) {
      if (!existing.refresh(details, now)) return right('ignored')
      await scope.suppliers.save(existing)
      return right('refreshed')
    }
    if (!state.roles.includes('supplier')) return right('ignored')
    await scope.suppliers.create(
      Supplier.project(
        { ...details, tenantId: state.tenantId, now },
        new UniqueEntityID(state.partyId),
      ),
    )
    return right('projected')
  }
}

/** The registry destroyed the subject's key; Procurement destroys its own copy (ADR 0026). */
export class ForgetPartyUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(scope: ProcurementScope, partyId: string): Promise<boolean> {
    const supplier = await scope.suppliers.findById(partyId)
    if (!supplier || supplier.isErased()) return false
    supplier.erase(this.clock.now())
    await scope.suppliers.erase(supplier)
    return true
  }
}
