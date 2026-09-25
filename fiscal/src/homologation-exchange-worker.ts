import type { HomologationExchangeLedger } from './homologation-exchange-ledger'
import {
  type HomologationExchangeRunner,
  UncertainSefazOutcomeError,
} from './homologation-exchange-runner'
import type { SefazOperationMap } from './nfe55/sefaz-adapter'

/** Processes one prepared exchange only after its capability is homologated. */
export class HomologationExchangeWorker {
  constructor(
    private readonly ledger: Pick<HomologationExchangeLedger, 'nextPreparedForActive'>,
    private readonly runner:
      | Pick<HomologationExchangeRunner, 'resume'>
      | ((
          tenantId: string,
          exchangeId: string,
        ) => Promise<Pick<HomologationExchangeRunner, 'resume'>>),
    private readonly operations: SefazOperationMap,
  ) {}

  async processOne(tenantId: string, workerId: string): Promise<boolean> {
    const exchangeId = await this.ledger.nextPreparedForActive(tenantId)
    if (!exchangeId) return false
    try {
      const runner =
        typeof this.runner === 'function' ? await this.runner(tenantId, exchangeId) : this.runner
      await runner.resume(
        { tenantId, exchangeId, workerId, actorId: `worker:${workerId}` },
        this.operations,
      )
    } catch (error) {
      // Another worker may have inserted the one-send marker first. Its outcome
      // remains uncertain until the stored response or a consultation is observed.
      if (!(error instanceof UncertainSefazOutcomeError)) throw error
      console.warn('Fiscal homologation exchange requires consultation', {
        tenantId,
        exchangeId,
      })
    }
    return true
  }
}
