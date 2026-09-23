import type { HomologationExchangeLedger } from './homologation-exchange-ledger'
import type { HomologationExchangeRunner } from './homologation-exchange-runner'
import type { SefazNfe55HomologationAdapter } from './nfe55/sefaz-adapter'

type ConsultationInput = Omit<
  Parameters<HomologationExchangeRunner['execute']>[0],
  'parentExchangeId'
>

/** Selects a receipt or protocol consultation from immutable authorization evidence. */
export class HomologationRecovery {
  constructor(
    private readonly ledger: Pick<HomologationExchangeLedger, 'recoveryTarget'>,
    private readonly adapter: Pick<SefazNfe55HomologationAdapter, 'prepare'>,
    private readonly runner: Pick<HomologationExchangeRunner, 'execute'>,
  ) {}

  async consult(input: ConsultationInput) {
    const target = await this.ledger.recoveryTarget(input.tenantId, input.documentId)
    const prepared = await this.adapter.prepare(
      target.service === 'receipt'
        ? { service: 'receipt', accessKey: target.accessKey, receipt: target.receipt }
        : { service: 'protocol', accessKey: target.accessKey },
    )
    return this.runner.execute({ ...input, parentExchangeId: target.parentExchangeId }, prepared)
  }
}
