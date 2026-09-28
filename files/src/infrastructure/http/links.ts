import { createHmac, timingSafeEqual } from 'node:crypto'

export type LinkKind = 'upload' | 'download'

/** How long each kind of link opens its file (Phase 65). */
export const LINK_TTL_MS: Readonly<Record<LinkKind, number>> = {
  upload: 15 * 60 * 1000,
  download: 5 * 60 * 1000,
}

export interface LinkQuery {
  readonly tenantId: string
  readonly attachmentId: string
  readonly expires: number
  readonly signature: string
}

/**
 * Signs `kind:tenant:attachment:expires` with a secret only `files` holds, so a link does
 * one thing to one file of one tenant until it expires, and a changed character opens
 * nothing. An upload link never downloads, and the other way round.
 */
export class AttachmentLinks {
  constructor(private readonly secret: string) {
    if (secret.length < 32) throw new Error('The files link secret must have 32 characters or more')
  }

  private digest(kind: LinkKind, tenantId: string, attachmentId: string, expires: number) {
    return createHmac('sha256', this.secret)
      .update(`${kind}:${tenantId}:${attachmentId}:${expires}`)
      .digest('hex')
  }

  sign(kind: LinkKind, tenantId: string, attachmentId: string, now: Date) {
    const expires = now.getTime() + LINK_TTL_MS[kind]
    const signature = this.digest(kind, tenantId, attachmentId, expires)
    const query = new URLSearchParams({ tenant: tenantId, expires: String(expires), signature })
    const path =
      kind === 'upload'
        ? `/files/uploads/${attachmentId}?${query}`
        : `/files/attachments/${attachmentId}/content?${query}`
    return {
      method: kind === 'upload' ? ('PUT' as const) : ('GET' as const),
      url: path,
      expiresAt: new Date(expires).toISOString(),
    }
  }

  verify(kind: LinkKind, link: LinkQuery, now: Date): boolean {
    if (!Number.isSafeInteger(link.expires) || link.expires < now.getTime()) return false
    if (link.expires > now.getTime() + LINK_TTL_MS[kind]) return false
    const expected = Buffer.from(
      this.digest(kind, link.tenantId, link.attachmentId, link.expires),
      'hex',
    )
    const presented = Buffer.from(link.signature, 'hex')
    return presented.length === expected.length && timingSafeEqual(presented, expected)
  }
}
