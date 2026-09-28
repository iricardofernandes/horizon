import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import type { Actor } from '@/domain/audit/audit-entry'
import { InvalidCredentialsError } from '@/domain/errors/invalid-credentials-error'
import { InvitationUnusableError, MailUnavailableError } from '@/domain/errors/mfa-errors'
import {
  ended,
  INVITATION_TTL_MS,
  type Invitation,
  isUsable,
  maskEmail,
  resent,
  statusAt,
} from '@/domain/mfa/invitation'
import type { AccountsRepository } from '@/domain/repositories/accounts-repository'
import type { PasswordHasher } from '@/domain/services/password-hasher'
import type { TokenDigest } from '@/domain/services/token-digest'
import { Email } from '@/domain/value-objects/email'
import { PersonName } from '@/domain/value-objects/person-name'
import type { RoleAssignment } from '@/domain/value-objects/role-assignments'
import type { Clock } from '../../ports/clock'
import type { InvitationStore, Mailer } from '../../ports/mfa'
import type { SecretGenerator } from '../../ports/secret-generator'
import type { UnitOfWork } from '../../ports/unit-of-work'
import type { RegisterUserUseCase } from '../register-user'

const TOKEN_BYTES = 32

export interface InvitationContext {
  readonly tenantId: string
  readonly actor: Actor
  readonly requestId: string | null
}

export interface InvitationView {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly roles: readonly RoleAssignment[]
  readonly status: string
  readonly invitedBy: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly sends: number
}

export function viewOf(invitation: Invitation, now: Date): InvitationView {
  return {
    id: invitation.id,
    email: invitation.maskedEmail,
    name: invitation.name,
    roles: invitation.roles,
    status: statusAt(invitation, now),
    invitedBy: invitation.invitedBy,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    sends: invitation.sends,
  }
}

type InviteFailure = InvalidInputError | ConflictError | MailUnavailableError

/**
 * Invitations replace passwords chosen by an administrator (ADR 0061 §1). The invited person
 * sets their own password through a single-use link valid for 72 hours; only the link's
 * digest is kept, and the email only while the invitation is pending.
 */
export class InvitationsUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly invitations: InvitationStore,
    private readonly mailer: Mailer,
    private readonly digest: TokenDigest,
    private readonly secrets: SecretGenerator,
    private readonly registerUser: RegisterUserUseCase,
    private readonly accounts: AccountsRepository,
    private readonly hasher: PasswordHasher,
    private readonly clock: Clock,
    private readonly webUrl: string,
  ) {}

  async invite(
    context: InvitationContext,
    input: { email: string; name: string; roles: readonly RoleAssignment[] },
  ): Promise<Either<InviteFailure, InvitationView>> {
    const email = Email.create(input.email)
    if (email.isLeft()) return left(email.value)
    const name = PersonName.create(input.name)
    if (name.isLeft()) return left(name.value)
    const now = this.clock.now()
    const taken = await this.unitOfWork.inTenant(context.tenantId, (scope) =>
      scope.users.findByEmail(email.value),
    )
    if (taken)
      return left(new ConflictError('a user with that email already belongs to this workspace'))
    const pending = (await this.invitations.list(context.tenantId)).some(
      (held) => held.email === email.value.value && isUsable(held, now),
    )
    if (pending)
      return left(new ConflictError('that email already has a pending invitation; resend it'))
    const token = this.secrets.token(TOKEN_BYTES)
    const invitation: Invitation = {
      id: this.secrets.identifier(),
      tenantId: context.tenantId,
      email: email.value.value,
      maskedEmail: maskEmail(email.value.value),
      name: input.name.trim(),
      roles: input.roles,
      tokenDigest: this.tokenDigest(token),
      status: 'pending',
      invitedBy: context.actor.id ?? 'system',
      createdAt: now,
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      sends: 1,
      acceptedUserId: null,
      endedAt: null,
    }
    await this.invitations.insert(invitation)
    await this.audit(context, invitation, 'invitation.created', { roles: [...input.roles] })
    const sent = await this.send(invitation, token)
    return sent ? right(viewOf(invitation, now)) : left(new MailUnavailableError())
  }

  async list(tenantId: string): Promise<InvitationView[]> {
    const now = this.clock.now()
    return (await this.invitations.list(tenantId)).map((invitation) => viewOf(invitation, now))
  }

  /** A new link and a new 72 hours; the old link stops working. */
  async resend(
    context: InvitationContext,
    id: string,
  ): Promise<Either<ResourceNotFoundError | ConflictError | MailUnavailableError, InvitationView>> {
    const invitation = await this.invitations.find(context.tenantId, id)
    if (!invitation) return left(new ResourceNotFoundError('invitation'))
    if (invitation.status !== 'pending' || !invitation.email)
      return left(new ConflictError(`the invitation is ${invitation.status}`))
    const now = this.clock.now()
    const token = this.secrets.token(TOKEN_BYTES)
    const next = resent(invitation, this.tokenDigest(token), now)
    await this.invitations.save(next)
    await this.audit(context, next, 'invitation.resent', { sends: next.sends })
    const sent = await this.send(next, token)
    return sent ? right(viewOf(next, now)) : left(new MailUnavailableError())
  }

  async revoke(
    context: InvitationContext,
    id: string,
  ): Promise<Either<ResourceNotFoundError | ConflictError, InvitationView>> {
    const invitation = await this.invitations.find(context.tenantId, id)
    if (!invitation) return left(new ResourceNotFoundError('invitation'))
    const now = this.clock.now()
    if (!isUsable(invitation, now))
      return left(new ConflictError(`the invitation is ${statusAt(invitation, now)}`))
    const next = ended(invitation, 'revoked', now)
    await this.invitations.save(next)
    await this.audit(context, next, 'invitation.revoked', {})
    return right(viewOf(next, now))
  }

  /** What the link's page shows before the person accepts. */
  async lookup(
    token: string,
  ): Promise<
    Either<
      InvitationUnusableError,
      { workspace: string; email: string; name: string; hasAccount: boolean; expiresAt: Date }
    >
  > {
    const found = await this.usable(token)
    if (found.isLeft()) return left(found.value)
    const { invitation } = found.value
    const email = Email.create(invitation.email ?? '')
    const account = email.isRight() ? await this.accounts.findByEmail(email.value) : null
    return right({
      workspace: await this.workspaceName(invitation.tenantId),
      email: invitation.maskedEmail,
      name: invitation.name,
      hasAccount: account !== null,
      expiresAt: invitation.expiresAt,
    })
  }

  /**
   * Accepting: the user joins with the invited roles and the password they chose, or the
   * password of the account they already have. The invitation is claimed first, so two
   * tabs cannot both accept it, and restored if the registration fails.
   */
  async accept(input: {
    token: string
    name: string
    password: string
  }): Promise<
    Either<
      InvitationUnusableError | InvalidCredentialsError | InvalidInputError | ConflictError,
      { userId: string; hasAccount: boolean }
    >
  > {
    const found = await this.usable(input.token)
    if (found.isLeft()) return left(found.value)
    const { invitation } = found.value
    const email = Email.create(invitation.email ?? '')
    if (email.isLeft()) return left(new InvitationUnusableError())
    const account = await this.accounts.findByEmail(email.value)
    if (account && !(await account.verifyPassword(input.password, this.hasher)))
      return left(new InvalidCredentialsError())
    const now = this.clock.now()
    const claimed = ended(invitation, 'accepted', now)
    if (!(await this.invitations.claim(invitation, claimed)))
      return left(new InvitationUnusableError())
    const registered = await this.registerUser.execute({
      tenantId: invitation.tenantId,
      email: email.value.value,
      name: input.name.trim() || invitation.name,
      password: input.password,
      roles: invitation.roles,
      actor: { type: 'user', id: invitation.invitedBy },
    })
    if (registered.isLeft()) {
      await this.invitations.save(invitation)
      return left(registered.value)
    }
    const accepted = { ...claimed, acceptedUserId: registered.value.userId }
    await this.invitations.save(accepted)
    await this.audit(
      {
        tenantId: invitation.tenantId,
        actor: { type: 'user', id: registered.value.userId },
        requestId: null,
      },
      accepted,
      'invitation.accepted',
      { userId: registered.value.userId },
    )
    return right({ userId: registered.value.userId, hasAccount: account !== null })
  }

  private async usable(
    token: string,
  ): Promise<Either<InvitationUnusableError, { invitation: Invitation }>> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return left(new InvitationUnusableError())
    const invitation = await this.invitations.findByDigest(this.tokenDigest(token))
    if (!invitation?.email || !isUsable(invitation, this.clock.now()))
      return left(new InvitationUnusableError())
    return right({ invitation })
  }

  private tokenDigest(token: string): string {
    return this.digest.digest(`invitation:${token}`)
  }

  private async workspaceName(tenantId: string): Promise<string> {
    return this.unitOfWork.inTenant(tenantId, async (scope) => {
      const tenant = await scope.tenants.findById(tenantId)
      return tenant?.displayName() ?? 'Horizon'
    })
  }

  private async send(invitation: Invitation, token: string): Promise<boolean> {
    const workspace = await this.workspaceName(invitation.tenantId)
    const link = `${this.webUrl.replace(/\/$/, '')}/accept-invitation?token=${token}`
    try {
      await this.mailer.send({
        to: invitation.email ?? '',
        subject: `Convite para ${workspace} no Horizon / Invitation to ${workspace} on Horizon`,
        text: [
          `Olá, ${invitation.name}.`,
          `Você foi convidado para o workspace ${workspace} no Horizon.`,
          `Defina sua senha em: ${link}`,
          'O link vale por 72 horas e pode ser usado uma vez.',
          '',
          `Hello, ${invitation.name}.`,
          `You were invited to the ${workspace} workspace on Horizon.`,
          `Set your password at: ${link}`,
          'The link is valid for 72 hours and can be used once.',
        ].join('\n'),
      })
      return true
    } catch {
      return false
    }
  }

  private async audit(
    context: InvitationContext,
    invitation: Invitation,
    action: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    const now = this.clock.now()
    await this.unitOfWork.inTenant(context.tenantId, (scope) =>
      scope.audit.append({
        actor: context.actor,
        subjectType: 'invitation',
        subjectId: invitation.id,
        action,
        after: { email: invitation.maskedEmail, ...after },
        requestId: context.requestId,
        occurredAt: now,
      }),
    )
  }
}
