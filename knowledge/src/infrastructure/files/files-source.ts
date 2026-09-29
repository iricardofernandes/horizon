import { z } from 'zod'
import { type FileContent, FileSource } from '@/application/ports'

const tokenAnswer = z.object({ accessToken: z.string().min(1), accessTokenExpiresAt: z.string() })
const attachment = z.object({ status: z.string(), contentType: z.string() })
const link = z.object({ url: z.string().startsWith('/files/') })

/**
 * A file's bytes, read through the gateway as a viewer of its module would read them: the
 * attachment, a five-minute link, the content (ADR 0060). The `knowledge` service client
 * holds viewer roles in the attaching modules for exactly this (Phase 74), and nothing more.
 */
export class GatewayFileSource extends FileSource {
  readonly #tokens = new Map<string, { token: string; expiresAt: number }>()

  constructor(
    private readonly gatewayUrl: string,
    private readonly secret: string,
    private readonly timeoutMs = 30_000,
  ) {
    super()
  }

  async read(tenantId: string, attachmentId: string): Promise<FileContent> {
    const token = await this.tokenFor(tenantId)
    const found = await this.get(`/files/attachments/${attachmentId}`, token)
    if (found.status === 404) return { kind: 'gone' }
    if (!found.ok) throw new Error(`files answered ${found.status}`)
    const described = attachment.parse(await found.json())
    if (described.status !== 'available') return { kind: 'gone' }
    const linked = await this.get(`/files/attachments/${attachmentId}/link`, token)
    if (linked.status === 404 || linked.status === 409) return { kind: 'gone' }
    if (!linked.ok) throw new Error(`files answered ${linked.status} for a link`)
    const content = await this.get(link.parse(await linked.json()).url)
    if (content.status === 404) return { kind: 'gone' }
    if (!content.ok) throw new Error(`files answered ${content.status} for the content`)
    return {
      kind: 'content',
      contentType: described.contentType,
      bytes: Buffer.from(await content.arrayBuffer()),
    }
  }

  private get(path: string, token?: string): Promise<Response> {
    return fetch(new URL(path, this.gatewayUrl), {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(this.timeoutMs),
    })
  }

  /** The service identity for one tenant (Phase 69), kept until a minute before it ends. */
  private async tokenFor(tenantId: string): Promise<string> {
    const cached = this.#tokens.get(tenantId)
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
    const response = await fetch(new URL('/auth/service-token', this.gatewayUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client: 'knowledge', secret: this.secret, tenantId }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) throw new Error(`service token refused with ${response.status}`)
    const answer = tokenAnswer.parse(await response.json())
    this.#tokens.set(tenantId, {
      token: answer.accessToken,
      expiresAt: Date.parse(answer.accessTokenExpiresAt),
    })
    return answer.accessToken
  }
}
