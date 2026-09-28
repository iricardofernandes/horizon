import { createHash, timingSafeEqual } from 'node:crypto'

import { type Either, left, right } from '@/core/either'
import { InvalidCredentialsError } from '@/domain/errors/invalid-credentials-error'
import type { RoleAssignment } from '@/domain/value-objects/role-assignments'
import type { AccessTokenSigner } from '../ports/access-token-signer'
import type { Clock } from '../ports/clock'
import type { UnitOfWork } from '../ports/unit-of-work'

const viewer = (module: RoleAssignment['module']) => ({ module, role: 'viewer' }) as RoleAssignment
const auditor = (module: RoleAssignment['module']) =>
  ({ module, role: 'auditor' }) as RoleAssignment

/**
 * What each service client may do, fixed here and never configured (ADR 0023). Reporting
 * reads the reports it reconciles and the figures it checks, and every audit log; it
 * changes nothing (Phase 69).
 */
export const SERVICE_GRANTS: Readonly<Record<string, readonly RoleAssignment[]>> = {
  reporting: [
    ...(
      ['sales', 'financial', 'treasury', 'ledger', 'procurement', 'inventory', 'crm'] as const
    ).map(viewer),
    ...(
      [
        'identity',
        'catalog',
        'sales',
        'financial',
        'treasury',
        'ledger',
        'procurement',
        'inventory',
        'fiscal',
        'crm',
        'reporting',
      ] as const
    ).map(auditor),
  ],
}

export interface IssueServiceTokenRequest {
  readonly client: string
  readonly secret: string
  readonly tenantId: string
}

export interface ServiceToken {
  readonly tenantId: string
  readonly accessToken: string
  readonly accessTokenExpiresAt: Date
}

/** `SERVICE_CLIENTS`: `name:sha256hex` pairs, comma-separated. */
export function serviceClientsOf(setting: string | undefined): ReadonlyMap<string, string> {
  const clients = new Map<string, string>()
  for (const entry of (setting ?? '').split(',')) {
    const [name, digest] = entry.trim().split(':')
    if (name && digest && /^[0-9a-f]{64}$/.test(digest)) clients.set(name, digest)
  }
  return clients
}

/**
 * A token for scheduled work in one tenant, for a service client that proves its secret
 * (Phase 69). The subject is `service:<client>`, the roles are the client's grants, and
 * every issue is in the tenant's audit chain.
 */
export class IssueServiceTokenUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly signer: AccessTokenSigner,
    private readonly clients: ReadonlyMap<string, string>,
    private readonly clock: Clock,
  ) {}

  async execute(
    request: IssueServiceTokenRequest,
  ): Promise<Either<InvalidCredentialsError, ServiceToken>> {
    const expected = this.clients.get(request.client)
    const grants = SERVICE_GRANTS[request.client]
    const presented = createHash('sha256').update(request.secret).digest()
    if (!expected || !grants || !timingSafeEqual(presented, Buffer.from(expected, 'hex')))
      return left(new InvalidCredentialsError())
    const now = this.clock.now()
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      if (!(await scope.tenants.findById(request.tenantId)))
        return left(new InvalidCredentialsError())
      const minted = await this.signer.mint(
        { subject: `service:${request.client}`, tenantId: request.tenantId, roles: grants },
        now,
      )
      await scope.audit.append({
        actor: { type: 'system', id: null },
        subjectType: 'ServiceClient',
        subjectId: request.client,
        action: 'service-token.issued',
        after: { jti: minted.jti, expiresAt: minted.expiresAt.toISOString() },
        occurredAt: now,
      })
      return right({
        tenantId: request.tenantId,
        accessToken: minted.token,
        accessTokenExpiresAt: minted.expiresAt,
      })
    })
  }
}
