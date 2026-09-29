import { z } from 'zod'
import { type FileContent, FileSource } from '@/application/ports'
import type { ServiceGateway } from '@/infrastructure/gateway/service-gateway'

const attachment = z.object({ status: z.string(), contentType: z.string() })
const link = z.object({ url: z.string().startsWith('/files/') })

/**
 * A file's bytes, read through the gateway as a viewer of its module would read them: the
 * attachment, a five-minute link, the content (ADR 0060). The `knowledge` service client
 * holds viewer roles in the attaching modules for exactly this (Phase 74), and nothing more.
 */
export class GatewayFileSource extends FileSource {
  constructor(private readonly gateway: ServiceGateway) {
    super()
  }

  async read(tenantId: string, attachmentId: string): Promise<FileContent> {
    const token = await this.gateway.tokenFor(tenantId)
    const found = await this.gateway.get(`/files/attachments/${attachmentId}`, token)
    if (found.status === 404) return { kind: 'gone' }
    if (!found.ok) throw new Error(`files answered ${found.status}`)
    const described = attachment.parse(await found.json())
    if (described.status !== 'available') return { kind: 'gone' }
    const linked = await this.gateway.get(`/files/attachments/${attachmentId}/link`, token)
    if (linked.status === 404 || linked.status === 409) return { kind: 'gone' }
    if (!linked.ok) throw new Error(`files answered ${linked.status} for a link`)
    const content = await this.gateway.get(link.parse(await linked.json()).url)
    if (content.status === 404) return { kind: 'gone' }
    if (!content.ok) throw new Error(`files answered ${content.status} for the content`)
    return {
      kind: 'content',
      contentType: described.contentType,
      bytes: Buffer.from(await content.arrayBuffer()),
    }
  }
}
