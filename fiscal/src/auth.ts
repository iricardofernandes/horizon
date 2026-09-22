import { roleAssignmentSchema } from '@horizon/contracts'
import Redis from 'ioredis'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { z } from 'zod'

const claimsSchema = z.object({
  sub: z.string().min(1),
  tenant_id: z.uuid(),
  roles: roleAssignmentSchema.array(),
  jti: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  iss: z.string().min(1),
})

export type FiscalPermission =
  | 'read'
  | 'draft:create'
  | 'rules:manage'
  | 'transmission:submit'
  | 'cancellation:request'
  | 'import:review'

export type FiscalPrincipal = {
  tenantId: string
  subject: string
  role: 'admin' | 'issuer' | 'reviewer' | 'viewer'
}

const permissions: Record<FiscalPrincipal['role'], readonly FiscalPermission[]> = {
  admin: [
    'read',
    'draft:create',
    'rules:manage',
    'transmission:submit',
    'cancellation:request',
    'import:review',
  ],
  issuer: ['read', 'draft:create', 'transmission:submit', 'cancellation:request'],
  reviewer: ['read', 'import:review'],
  viewer: ['read'],
}

export function may(principal: FiscalPrincipal, permission: FiscalPermission): boolean {
  return permissions[principal.role].includes(permission)
}

export interface Denylist {
  check(jti: string, subject: string): Promise<boolean>
  close(): Promise<void>
}

export class RedisDenylist implements Denylist {
  private readonly redis: Redis

  constructor(url: string) {
    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
    })
  }

  async check(jti: string, subject: string): Promise<boolean> {
    const segment = (value: string) => Buffer.from(value).toString('base64url')
    const [token, user] = await Promise.all([
      this.redis.exists(`identity:denylist:jti:${segment(jti)}`),
      this.redis.exists(`identity:denylist:subject:${segment(subject)}`),
    ])
    return token === 0 && user === 0
  }

  async close(): Promise<void> {
    this.redis.disconnect()
  }
}

export class FiscalTokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>

  constructor(
    jwksUrl: string,
    private readonly denylist: Denylist,
  ) {
    this.jwks = createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: 3000 })
  }

  async verify(authorization: string | undefined): Promise<FiscalPrincipal> {
    if (!authorization || !/^Bearer [^ ]+$/.test(authorization))
      throw new Error('Invalid fiscal access token')
    try {
      const { payload, protectedHeader } = await jwtVerify(authorization.slice(7), this.jwks, {
        algorithms: ['EdDSA'],
        typ: 'JWT',
        maxTokenAge: '15m',
        requiredClaims: ['sub', 'tenant_id', 'roles', 'jti', 'iss', 'iat', 'exp'],
      })
      const claims = claimsSchema.parse(payload)
      if (
        !protectedHeader.kid ||
        claims.iss !== `horizon-identity-${protectedHeader.kid}` ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > 900
      )
        throw new Error('Invalid fiscal access token')
      if (!(await this.denylist.check(claims.jti, claims.sub)))
        throw new Error('Fiscal access token was revoked')
      const assigned = claims.roles.find((role) => role.module === 'fiscal')
      if (!assigned) throw new Error('Fiscal role is required')
      return { tenantId: claims.tenant_id, subject: claims.sub, role: assigned.role }
    } catch {
      throw new Error('Invalid fiscal access token')
    }
  }
}
