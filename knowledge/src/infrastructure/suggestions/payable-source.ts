import { z } from 'zod'
import { type PayableDetail, PayableSource } from '@/application/suggestion-ports'
import type { ServiceGateway } from '@/infrastructure/gateway/service-gateway'

const payable = z.object({
  partyId: z.uuid(),
  partyName: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  documentNumber: z.string().min(1),
  categoryId: z.uuid().nullable().optional(),
})

/** A payable as Financial shows it to a viewer: the `knowledge` service client is one. */
export class GatewayPayableSource extends PayableSource {
  constructor(private readonly gateway: ServiceGateway) {
    super()
  }

  async read(tenantId: string, titleId: string): Promise<PayableDetail | null> {
    const token = await this.gateway.tokenFor(tenantId)
    const answer = await this.gateway.get(`/financial/payables/${titleId}`, token)
    if (answer.status === 404) return null
    if (!answer.ok) throw new Error(`financial answered ${answer.status}`)
    const detail = payable.parse(await answer.json())
    return {
      partyId: detail.partyId,
      partyName: detail.partyName ?? null,
      description: detail.description ?? null,
      documentNumber: detail.documentNumber,
      categoryId: detail.categoryId ?? null,
    }
  }
}
