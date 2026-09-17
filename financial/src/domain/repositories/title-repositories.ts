import type { Title, TitleDirection } from '../entities/title'

export abstract class TitlesRepository {
  /** Loads the title and locks it for the rest of the transaction. */
  abstract findForUpdate(id: string): Promise<Title | null>
  abstract findByOrderForUpdate(direction: TitleDirection, orderId: string): Promise<Title | null>
  abstract create(title: Title): Promise<void>
  /** Persists the state and publishes the pending events in the same transaction. */
  abstract save(title: Title): Promise<void>
}

export interface ProjectedParty {
  readonly partyId: string
  readonly legalName: string | null
  readonly roles: readonly string[]
  readonly active: boolean
  readonly erased: boolean
}

/** The parties registry as Financial sees it, fed by `parties.party.*` events (ADR 0040). */
export abstract class PartyProjectionRepository {
  abstract find(partyId: string): Promise<ProjectedParty | null>
  /** Replaces the copy, unless the party was erased: erasure is final. */
  abstract record(party: Omit<ProjectedParty, 'erased'>, now: Date): Promise<'recorded' | 'ignored'>
  abstract forget(partyId: string, now: Date): Promise<void>
}

/**
 * How large a title may be before a second person must approve it, per currency. A
 * workspace with no policy for a currency approves every payable in it: the safe default
 * is the strict one.
 */
export interface ApprovalPolicy {
  readonly direction: TitleDirection
  readonly currency: string
  readonly threshold: bigint
  readonly updatedAt: Date
}

export abstract class ApprovalPoliciesRepository {
  abstract find(direction: TitleDirection, currency: string): Promise<ApprovalPolicy | null>
  abstract list(direction: TitleDirection): Promise<readonly ApprovalPolicy[]>
  abstract save(policy: ApprovalPolicy): Promise<void>
}
