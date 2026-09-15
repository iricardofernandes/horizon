import { createRemoteJWKSet, jwtVerify } from 'jose'
import { z } from 'zod'

const claimsSchema = z.object({
  sub: z.string().min(1),
  tenant_id: z.uuid(),
  roles: z.array(z.object({ module: z.string(), role: z.string() })).max(50),
  jti: z.string().min(1),
  iss: z.string().min(1),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
})

export type AccessClaims = Readonly<{
  subject: string
  tenantId: string
  roles: readonly { module: string; role: string }[]
}>

export class AccessTokenVerifier {
  readonly #keys: ReturnType<typeof createRemoteJWKSet>

  constructor(
    url: string,
    private readonly maxAgeSeconds: number,
  ) {
    this.#keys = createRemoteJWKSet(new URL(url), { timeoutDuration: 5000 })
  }

  async verify(token: string): Promise<AccessClaims> {
    const { payload, protectedHeader } = await jwtVerify(token, this.#keys, {
      algorithms: ['EdDSA'],
      typ: 'JWT',
      maxTokenAge: this.maxAgeSeconds,
      requiredClaims: ['sub', 'tenant_id', 'roles', 'jti', 'iss', 'iat', 'exp'],
    })
    const claims = claimsSchema.parse(payload)
    if (claims.iss !== `horizon-identity-${protectedHeader.kid ?? ''}`)
      throw new Error('Invalid token issuer')
    if (claims.exp <= claims.iat || claims.exp - claims.iat > this.maxAgeSeconds)
      throw new Error('Invalid token lifetime')
    return { subject: claims.sub, tenantId: claims.tenant_id, roles: claims.roles }
  }
}
