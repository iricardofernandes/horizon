import { sql } from 'drizzle-orm'
import {
  FactorStore,
  InvitationStore,
  MfaPolicies,
  type StoredFactor,
} from '@/application/ports/mfa'
import type { Invitation, InvitationStatus } from '@/domain/mfa/invitation'
import { type MfaPolicy, type MfaPolicyKind, NO_MFA_POLICY } from '@/domain/mfa/mfa-policy'
import type { RoleAssignment } from '@/domain/value-objects/role-assignments'
import type { IdentityDatabase } from './identity-database'

type Row = Record<string, unknown>

const dateOf = (value: unknown): Date | null =>
  value === null || value === undefined ? null : new Date(value as string | Date)
const iso = (value: Date | null) => value?.toISOString() ?? null

function factorOf(row: Row): StoredFactor {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    kind: row.kind as 'totp' | 'passkey',
    label: String(row.label),
    secretSealed: (row.secret_sealed as string | null) ?? null,
    credentialId: (row.credential_id as string | null) ?? null,
    publicKey: (row.public_key as string | null) ?? null,
    signCount: Number(row.sign_count ?? 0),
    transports: (row.transports as string[] | null) ?? [],
    confirmedAt: dateOf(row.confirmed_at),
    lastUsedStep: row.last_used_step === null ? null : Number(row.last_used_step),
    lastUsedAt: dateOf(row.last_used_at),
    createdAt: dateOf(row.created_at) ?? new Date(0),
  }
}

/** Second factors and recovery codes, always inside the account's own RLS context. */
export class SqlFactorStore extends FactorStore {
  constructor(private readonly database: IdentityDatabase) {
    super()
  }

  list(accountId: string): Promise<StoredFactor[]> {
    return this.database.asAccount(accountId, async (run) =>
      (
        await run(sql`select * from account_factors
          where account_id = ${accountId} and removed_at is null order by created_at`)
      ).map(factorOf),
    )
  }

  insert(factor: StoredFactor): Promise<void> {
    return this.database.asAccount(factor.accountId, async (run) => {
      await run(sql`
        insert into account_factors (id, account_id, kind, label, secret_sealed, credential_id,
          public_key, sign_count, transports, confirmed_at, created_at)
        values (${factor.id}, ${factor.accountId}, ${factor.kind}, ${factor.label},
          ${factor.secretSealed}, ${factor.credentialId}, ${factor.publicKey}, ${factor.signCount},
          ${JSON.stringify(factor.transports)}::jsonb, ${iso(factor.confirmedAt)}::timestamptz,
          ${factor.createdAt.toISOString()}::timestamptz)`)
    })
  }

  confirm(accountId: string, factorId: string, step: number, now: Date): Promise<boolean> {
    return this.database.asAccount(accountId, async (run) => {
      const rows = await run(sql`
        update account_factors set confirmed_at = ${now.toISOString()}::timestamptz,
          last_used_step = ${step}, last_used_at = ${now.toISOString()}::timestamptz
        where id = ${factorId} and confirmed_at is null and removed_at is null returning id`)
      return rows.length === 1
    })
  }

  useTotpStep(accountId: string, factorId: string, step: number, now: Date): Promise<boolean> {
    return this.database.asAccount(accountId, async (run) => {
      const rows = await run(sql`
        update account_factors set last_used_step = ${step},
          last_used_at = ${now.toISOString()}::timestamptz
        where id = ${factorId} and removed_at is null
          and (last_used_step is null or last_used_step < ${step}) returning id`)
      return rows.length === 1
    })
  }

  usePasskey(accountId: string, factorId: string, signCount: number, now: Date): Promise<void> {
    return this.database.asAccount(accountId, async (run) => {
      await run(sql`
        update account_factors set sign_count = ${signCount},
          last_used_at = ${now.toISOString()}::timestamptz
        where id = ${factorId} and removed_at is null`)
    })
  }

  remove(accountId: string, factorId: string, now: Date): Promise<boolean> {
    return this.database.asAccount(accountId, async (run) => {
      const rows = await run(sql`
        update account_factors set removed_at = ${now.toISOString()}::timestamptz
        where id = ${factorId} and removed_at is null returning id`)
      return rows.length === 1
    })
  }

  replaceRecoveryCodes(accountId: string, digests: readonly string[], now: Date): Promise<void> {
    return this.database.asAccount(accountId, async (run) => {
      await run(sql`delete from account_recovery_codes where account_id = ${accountId}`)
      for (const digest of digests)
        await run(sql`
          insert into account_recovery_codes (account_id, code_digest, created_at)
          values (${accountId}, ${digest}, ${now.toISOString()}::timestamptz)`)
    })
  }

  useRecoveryCode(accountId: string, digest: string, now: Date): Promise<boolean> {
    return this.database.asAccount(accountId, async (run) => {
      const rows = await run(sql`
        update account_recovery_codes set used_at = ${now.toISOString()}::timestamptz
        where account_id = ${accountId} and code_digest = ${digest} and used_at is null
        returning code_digest`)
      return rows.length === 1
    })
  }

  remainingRecoveryCodes(accountId: string): Promise<number> {
    return this.database.asAccount(accountId, async (run) => {
      const [row] = await run(sql`
        select count(*)::int as left from account_recovery_codes
        where account_id = ${accountId} and used_at is null`)
      return Number(row?.left ?? 0)
    })
  }
}

function invitationOf(row: Row): Invitation {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    email: (row.email as string | null) ?? null,
    maskedEmail: String(row.masked_email),
    name: String(row.name),
    roles: row.roles as RoleAssignment[],
    tokenDigest: String(row.token_digest),
    status: row.status as InvitationStatus,
    invitedBy: String(row.invited_by),
    createdAt: dateOf(row.created_at) ?? new Date(0),
    expiresAt: dateOf(row.expires_at) ?? new Date(0),
    sends: Number(row.sends),
    acceptedUserId: (row.accepted_user_id as string | null) ?? null,
    endedAt: dateOf(row.ended_at),
  }
}

/** Tenant-scoped invitations, with a digest-only directory for the public link. */
export class SqlInvitationStore extends InvitationStore {
  constructor(private readonly database: IdentityDatabase) {
    super()
  }

  insert(invitation: Invitation): Promise<void> {
    return this.database.asTenant(invitation.tenantId, async (run) => {
      await run(sql`
        insert into invitations (id, tenant_id, email, masked_email, name, roles, token_digest,
          status, invited_by, created_at, expires_at, sends)
        values (${invitation.id}, ${invitation.tenantId}, ${invitation.email},
          ${invitation.maskedEmail}, ${invitation.name}, ${JSON.stringify(invitation.roles)}::jsonb,
          ${invitation.tokenDigest}, ${invitation.status}, ${invitation.invitedBy},
          ${invitation.createdAt.toISOString()}::timestamptz,
          ${invitation.expiresAt.toISOString()}::timestamptz, ${invitation.sends})`)
      await run(sql`
        insert into invitation_directory (token_digest, tenant_id, invitation_id)
        values (${invitation.tokenDigest}, ${invitation.tenantId}, ${invitation.id})`)
    })
  }

  find(tenantId: string, id: string): Promise<Invitation | null> {
    return this.database.asTenant(tenantId, async (run) => {
      const [row] = await run(sql`select * from invitations where id = ${id}`)
      return row ? invitationOf(row) : null
    })
  }

  async findByDigest(tokenDigest: string): Promise<Invitation | null> {
    const [entry] = await this.database.asAnyone((run) =>
      run(sql`select tenant_id, invitation_id from invitation_directory
        where token_digest = ${tokenDigest}`),
    )
    if (!entry) return null
    const invitation = await this.find(String(entry.tenant_id), String(entry.invitation_id))
    return invitation?.tokenDigest === tokenDigest ? invitation : null
  }

  list(tenantId: string): Promise<Invitation[]> {
    return this.database.asTenant(tenantId, async (run) =>
      (await run(sql`select * from invitations order by created_at desc limit 200`)).map(
        invitationOf,
      ),
    )
  }

  save(invitation: Invitation): Promise<void> {
    return this.database.asTenant(invitation.tenantId, async (run) => {
      await this.write(run, invitation, null)
    })
  }

  claim(current: Invitation, next: Invitation): Promise<boolean> {
    return this.database.asTenant(current.tenantId, (run) => this.write(run, next, current))
  }

  /** Writes the invitation, and moves its directory entry when the link changed. */
  private async write(
    run: (query: ReturnType<typeof sql>) => Promise<Row[]>,
    invitation: Invitation,
    expected: Invitation | null,
  ): Promise<boolean> {
    const guard = expected
      ? sql` and status = 'pending' and token_digest = ${expected.tokenDigest}`
      : sql``
    const rows = await run(sql`
      update invitations set email = ${invitation.email}, status = ${invitation.status},
        token_digest = ${invitation.tokenDigest},
        expires_at = ${invitation.expiresAt.toISOString()}::timestamptz,
        sends = ${invitation.sends}, accepted_user_id = ${invitation.acceptedUserId},
        ended_at = ${iso(invitation.endedAt)}::timestamptz
      where id = ${invitation.id}${guard} returning id`)
    if (rows.length === 0) return false
    await run(sql`
      update invitation_directory set token_digest = ${invitation.tokenDigest}
      where invitation_id = ${invitation.id}`)
    return true
  }
}

export class SqlMfaPolicies extends MfaPolicies {
  constructor(private readonly database: IdentityDatabase) {
    super()
  }

  find(tenantId: string): Promise<MfaPolicy> {
    return this.database.asTenant(tenantId, async (run) => {
      const [row] = await run(sql`
        select mfa_policy, mfa_grace_days, mfa_policy_changed_at from tenants where id = ${tenantId}`)
      if (!row) return NO_MFA_POLICY
      return {
        policy: row.mfa_policy as MfaPolicyKind,
        graceDays: Number(row.mfa_grace_days),
        changedAt: dateOf(row.mfa_policy_changed_at),
      }
    })
  }

  save(tenantId: string, policy: MfaPolicy): Promise<void> {
    return this.database.asTenant(tenantId, async (run) => {
      await run(sql`
        update tenants set mfa_policy = ${policy.policy}, mfa_grace_days = ${policy.graceDays},
          mfa_policy_changed_at = ${iso(policy.changedAt)}::timestamptz
        where id = ${tenantId}`)
    })
  }
}
