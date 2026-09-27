import { createHmac, timingSafeEqual } from 'node:crypto'

/** A download link is valid for this long (Phase 63). */
export const LINK_TTL_MS = 15 * 60 * 1000

/**
 * Signs `tenant:job:expires` with a secret only reporting holds, so a link opens exactly
 * one file of one tenant until it expires, and a changed character opens nothing.
 */
export class ExportLinks {
  constructor(private readonly secret: string) {
    if (secret.length < 32)
      throw new Error('The export link secret must have 32 characters or more')
  }

  private digest(tenantId: string, jobId: string, expires: number): string {
    return createHmac('sha256', this.secret).update(`${tenantId}:${jobId}:${expires}`).digest('hex')
  }

  sign(tenantId: string, jobId: string, now: Date) {
    const expires = now.getTime() + LINK_TTL_MS
    const signature = this.digest(tenantId, jobId, expires)
    const query = new URLSearchParams({ tenant: tenantId, expires: String(expires), signature })
    return { path: `/reporting/exports/${jobId}/file?${query}`, expiresAt: new Date(expires) }
  }

  verify(
    input: { tenantId: string; jobId: string; expires: number; signature: string },
    now: Date,
  ): boolean {
    if (!Number.isSafeInteger(input.expires) || input.expires < now.getTime()) return false
    if (input.expires > now.getTime() + LINK_TTL_MS) return false
    const expected = Buffer.from(this.digest(input.tenantId, input.jobId, input.expires), 'hex')
    const presented = Buffer.from(input.signature, 'hex')
    return presented.length === expected.length && timingSafeEqual(presented, expected)
  }
}
