import type {
  PartiesRepository,
  PartyEventsRepository,
} from '@/domain/repositories/parties-repositories'

export interface PartiesScope {
  readonly tenantId: string
  readonly parties: PartiesRepository
  readonly events: PartyEventsRepository
}

export abstract class PartiesUnitOfWork {
  abstract inTenant<T>(tenantId: string, work: (scope: PartiesScope) => Promise<T>): Promise<T>
}
