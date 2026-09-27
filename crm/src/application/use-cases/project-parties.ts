import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { Account, type PartyFacts } from '@/domain/entities/account'
import type { Clock } from '../ports/clock'
import type { CrmScope } from '../ports/unit-of-work'

/** Who closed a task that was cancelled because its party was erased. */
const PARTY_ERASURE = 'crm:party-erased'

export type ProjectionOutcome = 'projected' | 'refreshed' | 'ignored'

/**
 * Keep CRM's accounts in step with the party registry (ADR 0057).
 *
 * A party that never held a CRM role is not an account and is ignored before anything
 * about it is read; one that was stays, inactive when it no longer holds the role.
 */
export class ProjectPartyUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(
    scope: CrmScope,
    state: PartyFacts & { readonly partyId: string },
  ): Promise<ProjectionOutcome> {
    const { partyId, ...party } = state
    const now = this.clock.now()
    const existing = await scope.accounts.findById(partyId)
    if (existing) {
      if (!existing.refresh(party, now)) return 'ignored'
      await scope.accounts.save(existing)
      return 'refreshed'
    }
    const account = Account.project(
      { tenantId: scope.tenantId, party, now },
      new UniqueEntityID(partyId),
    )
    if (!account) return 'ignored'
    await scope.accounts.create(account)
    return 'projected'
  }
}

/**
 * The registry shredded the party. CRM forgets the account's names and shreds every
 * contact of the account with it: a contact at a company that no longer exists here is
 * data nobody may keep (ADR 0026, ADR 0057).
 *
 * Saving the erased account also destroys the account's key, so the text of its
 * activities, tasks and notes can no longer be read; its open tasks are cancelled first,
 * so no reminder is sent about it (Phase 57).
 */
export class ForgetPartyUseCase {
  constructor(private readonly clock: Clock) {}

  async executeInScope(scope: CrmScope, partyId: string): Promise<number> {
    const account = await scope.accounts.findById(partyId)
    if (!account) return 0
    const now = this.clock.now()
    let shredded = 0
    for (const contact of await scope.contacts.findLiveOf(partyId)) {
      if (contact.erase(now).isLeft()) continue
      await scope.contacts.save(contact)
      shredded += 1
    }
    for (const task of await scope.tasks.findOpenOf(partyId))
      if (task.cancel(PARTY_ERASURE, now).isRight()) await scope.tasks.save(task)
    if (account.erase(now)) await scope.accounts.save(account)
    return shredded
  }
}
