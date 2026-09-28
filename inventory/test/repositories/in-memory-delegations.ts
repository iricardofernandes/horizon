import type { ApprovalDelegation } from '@/domain/controls/approval-delegation'
import type { DelegationsRepository } from '@/domain/controls/delegations-repository'

/** Approval delegations kept in memory, for the application tests (ADR 0062). */
export class InMemoryDelegations implements DelegationsRepository {
  constructor(private readonly items: ApprovalDelegation[] = []) {}

  async create(delegation: ApprovalDelegation): Promise<void> {
    this.items.push(delegation)
  }

  async save(): Promise<void> {}

  async findForUpdate(id: string): Promise<ApprovalDelegation | null> {
    return this.items.find((delegation) => delegation.id.toString() === id) ?? null
  }

  async findFor(delegateId: string, permission: string): Promise<readonly ApprovalDelegation[]> {
    return this.items.filter(
      (delegation) =>
        delegation.delegateId === delegateId &&
        delegation.permission === permission &&
        delegation.stateAt(new Date(8.64e15)) !== 'revoked',
    )
  }

  async list(person: string | null): Promise<readonly ApprovalDelegation[]> {
    return this.items.filter(
      (delegation) =>
        person === null || delegation.delegatorId === person || delegation.delegateId === person,
    )
  }
}
