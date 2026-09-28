import type { ApprovalDelegation } from './approval-delegation'

export abstract class DelegationsRepository {
  abstract create(delegation: ApprovalDelegation): Promise<void>
  abstract save(delegation: ApprovalDelegation): Promise<void>
  abstract findForUpdate(id: string): Promise<ApprovalDelegation | null>
  /** Delegations to this person for this approval that have not been revoked. */
  abstract findFor(delegateId: string, permission: string): Promise<readonly ApprovalDelegation[]>
  /** Newest first; only those naming the person when one is given. */
  abstract list(person: string | null): Promise<readonly ApprovalDelegation[]>
}
