import { type Either, left, right } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import type { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { Party } from '@/domain/entities/party'
import {
  PartyAddress,
  PartyEmail,
  type PartyKind,
  PartyName,
  PartyPhone,
  type PartyRole,
  PartyRoles,
  TaxId,
} from '@/domain/value-objects/party-values'
import type { Clock } from '../ports/clock'
import type { PartiesScope, PartiesUnitOfWork } from '../ports/unit-of-work'

export interface PartyDetailsInput {
  readonly legalName: string
  readonly tradeName?: string | null | undefined
  readonly email: string
  readonly phone: string
  readonly address: string
}

type Details = {
  legalName: PartyName
  tradeName: PartyName | null
  email: PartyEmail
  phone: PartyPhone
  address: PartyAddress
}

function detailsOf(input: PartyDetailsInput): Either<InvalidInputError, Details> {
  const legalName = PartyName.create(input.legalName)
  if (legalName.isLeft()) return left(legalName.value)
  const trade = input.tradeName?.trim() ? PartyName.create(input.tradeName, '/tradeName') : null
  if (trade?.isLeft()) return left(trade.value)
  const email = PartyEmail.create(input.email)
  if (email.isLeft()) return left(email.value)
  const phone = PartyPhone.create(input.phone)
  if (phone.isLeft()) return left(phone.value)
  const address = PartyAddress.create(input.address)
  if (address.isLeft()) return left(address.value)
  return right({
    legalName: legalName.value,
    tradeName: trade?.isRight() ? trade.value : null,
    email: email.value,
    phone: phone.value,
    address: address.value,
  })
}

export class RegisterPartyUseCase {
  constructor(
    private readonly unitOfWork: PartiesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  /**
   * `partyId` is accepted only to adopt an identifier a predecessor already published —
   * the Sales customers that existed before this registry — so documents that reference
   * them keep resolving. A fresh registration omits it.
   */
  async execute(
    request: {
      readonly tenantId: string
      readonly partyId?: string | undefined
      readonly kind: PartyKind
      readonly taxId: string
      readonly roles: readonly string[]
    } & PartyDetailsInput,
  ): Promise<Either<InvalidInputError | ConflictError, { partyId: string }>> {
    const details = detailsOf(request)
    if (details.isLeft()) return left(details.value)
    const taxId = TaxId.create(request.taxId, request.kind)
    if (taxId.isLeft()) return left(taxId.value)
    const roles = PartyRoles.of(request.roles)
    if (roles.isLeft()) return left(roles.value)

    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const existing = await scope.parties.findByTaxId(taxId.value.value)
      if (existing)
        return left(
          new ConflictError(
            'a party with this tax identifier already exists; grant it the role instead',
          ),
        )
      if (request.partyId && (await scope.parties.findById(request.partyId)))
        return left(new ConflictError('party identifier is already in use'))
      const party = Party.register(
        {
          tenantId: request.tenantId,
          kind: request.kind,
          taxId: taxId.value,
          roles: roles.value,
          ...details.value,
          now: this.clock.now(),
        },
        request.partyId ? new UniqueEntityID(request.partyId) : undefined,
      )
      await scope.parties.create(party)
      return right({ partyId: party.id.toString() })
    })
  }
}

/** Load, change, save, inside one tenant transaction; a missing party is a 404, not a throw. */
async function withParty<T>(
  unitOfWork: PartiesUnitOfWork,
  tenantId: string,
  partyId: string,
  change: (party: Party, scope: PartiesScope) => Either<ConflictError, T>,
): Promise<Either<ResourceNotFoundError | ConflictError, T>> {
  return unitOfWork.inTenant(tenantId, async (scope) => {
    const party = await scope.parties.findById(partyId)
    if (!party) return left(new ResourceNotFoundError('party was not found'))
    const outcome = change(party, scope)
    if (outcome.isLeft()) return outcome
    await scope.parties.save(party)
    return outcome
  })
}

export class DescribePartyUseCase {
  constructor(
    private readonly unitOfWork: PartiesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(
    request: { readonly tenantId: string; readonly partyId: string } & PartyDetailsInput,
  ): Promise<Either<InvalidInputError | ResourceNotFoundError | ConflictError, void>> {
    const details = detailsOf(request)
    if (details.isLeft()) return left(details.value)
    return withParty(this.unitOfWork, request.tenantId, request.partyId, (party) =>
      party.describe(details.value, this.clock.now()),
    )
  }
}

export class ChangePartyRoleUseCase {
  constructor(
    private readonly unitOfWork: PartiesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    readonly tenantId: string
    readonly partyId: string
    readonly role: string
    readonly operation: 'grant' | 'revoke'
  }): Promise<Either<InvalidInputError | ResourceNotFoundError | ConflictError, void>> {
    const parsed = PartyRoles.of([request.role])
    if (parsed.isLeft()) return left(parsed.value)
    const role = parsed.value.values[0] as PartyRole
    return withParty(this.unitOfWork, request.tenantId, request.partyId, (party) =>
      request.operation === 'grant'
        ? party.grant(role, this.clock.now())
        : party.revoke(role, this.clock.now()),
    )
  }
}

export class ChangePartyStatusUseCase {
  constructor(
    private readonly unitOfWork: PartiesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    readonly tenantId: string
    readonly partyId: string
    readonly active: boolean
  }): Promise<Either<ResourceNotFoundError | ConflictError, void>> {
    return withParty(this.unitOfWork, request.tenantId, request.partyId, (party) =>
      request.active ? party.reactivate(this.clock.now()) : party.deactivate(this.clock.now()),
    )
  }
}

/** LGPD erasure (ADR 0026): the key is destroyed here and every projection is told to forget. */
export class ErasePartyUseCase {
  constructor(
    private readonly unitOfWork: PartiesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    readonly tenantId: string
    readonly partyId: string
  }): Promise<Either<ResourceNotFoundError | ConflictError, void>> {
    return withParty(this.unitOfWork, request.tenantId, request.partyId, (party) =>
      party.erase(this.clock.now()),
    )
  }
}
