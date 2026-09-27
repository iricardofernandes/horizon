import { type Either, left, right } from '@/core/either'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { Party } from '@/domain/entities/party'
import type { Lookalike } from '@/domain/repositories/parties-repositories'
import { FiscalProfile, type FiscalProfileInput } from '@/domain/value-objects/fiscal-profile'
import {
  PartyAddress,
  PartyDocument,
  type PartyDocumentInput,
  PartyEmail,
  type PartyKind,
  PartyName,
  PartyPhone,
  type PartyRole,
  PartyRoles,
} from '@/domain/value-objects/party-values'
import type { Clock } from '../ports/clock'
import type { PartiesScope, PartiesUnitOfWork } from '../ports/unit-of-work'

export interface PartyDetailsInput {
  readonly legalName: string
  readonly tradeName?: string | null | undefined
  readonly email?: string | null | undefined
  readonly phone?: string | null | undefined
  readonly address?: string | null | undefined
}

type Details = {
  legalName: PartyName
  tradeName: PartyName | null
  email: PartyEmail | null
  phone: PartyPhone | null
  address: PartyAddress | null
}

/** A blank optional field is absent, not invalid: a prospect may be known by name alone. */
function optional<T>(
  value: string | null | undefined,
  create: (present: string) => Either<InvalidInputError, T>,
): Either<InvalidInputError, T | null> {
  return value?.trim() ? create(value) : right(null)
}

function detailsOf(input: PartyDetailsInput): Either<InvalidInputError, Details> {
  const legalName = PartyName.create(input.legalName)
  if (legalName.isLeft()) return left(legalName.value)
  const trade = optional(input.tradeName, (value) => PartyName.create(value, '/tradeName'))
  if (trade.isLeft()) return left(trade.value)
  const email = optional(input.email, PartyEmail.create)
  if (email.isLeft()) return left(email.value)
  const phone = optional(input.phone, PartyPhone.create)
  if (phone.isLeft()) return left(phone.value)
  const address = optional(input.address, PartyAddress.create)
  if (address.isLeft()) return left(address.value)
  return right({
    legalName: legalName.value,
    tradeName: trade.value,
    email: email.value,
    phone: phone.value,
    address: address.value,
  })
}

/** Exactly one of the typed document or the pre-Phase 54 `taxId` shorthand. */
function documentOf(
  request: {
    readonly document?: PartyDocumentInput | undefined
    readonly taxId?: string | undefined
  },
  kind: PartyKind,
): Either<InvalidInputError, PartyDocument> {
  if (request.document && request.taxId !== undefined)
    return left(new InvalidInputError('/document', 'send either document or taxId, not both'))
  if (request.document) return PartyDocument.create(request.document, kind)
  if (request.taxId !== undefined) return PartyDocument.fromTaxId(request.taxId, kind)
  return left(
    new InvalidInputError('/document', 'a document is required; use type none when there is none'),
  )
}

const DUPLICATE_DOCUMENT = 'a party with this document already exists; grant it the role instead'

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
      readonly document?: PartyDocumentInput | undefined
      readonly taxId?: string | undefined
      readonly roles: readonly string[]
    } & PartyDetailsInput,
  ): Promise<Either<InvalidInputError | ConflictError, { partyId: string }>> {
    const details = detailsOf(request)
    if (details.isLeft()) return left(details.value)
    const document = documentOf(request, request.kind)
    if (document.isLeft()) return left(document.value)
    const roles = PartyRoles.of(request.roles)
    if (roles.isLeft()) return left(roles.value)
    const registered = Party.register(
      {
        tenantId: request.tenantId,
        kind: request.kind,
        document: document.value,
        roles: roles.value,
        ...details.value,
        now: this.clock.now(),
      },
      request.partyId ? new UniqueEntityID(request.partyId) : undefined,
    )
    if (registered.isLeft()) return left(registered.value)
    const party = registered.value

    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      if (await scope.parties.findByDocument(document.value))
        return left(new ConflictError(DUPLICATE_DOCUMENT))
      if (request.partyId && (await scope.parties.findById(request.partyId)))
        return left(new ConflictError('party identifier is already in use'))
      await scope.parties.create(party)
      return right({ partyId: party.id.toString() })
    })
  }
}

/** Load, change, save, inside one tenant transaction; a missing party is a 404, not a throw. */
async function withParty<T, E extends ConflictError | InvalidInputError>(
  unitOfWork: PartiesUnitOfWork,
  tenantId: string,
  partyId: string,
  change: (party: Party, scope: PartiesScope) => Either<E, T> | Promise<Either<E, T>>,
): Promise<Either<ResourceNotFoundError | E, T>> {
  return unitOfWork.inTenant(tenantId, async (scope) => {
    const party = await scope.parties.findById(partyId)
    if (!party) return left(new ResourceNotFoundError('party was not found'))
    const outcome = await change(party, scope)
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

/** Give a party registered without a document the one it was missing (ADR 0057). */
export class IdentifyPartyUseCase {
  constructor(
    private readonly unitOfWork: PartiesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    readonly tenantId: string
    readonly partyId: string
    readonly document: PartyDocumentInput
  }): Promise<Either<InvalidInputError | ResourceNotFoundError | ConflictError, void>> {
    const document = PartyDocument.create(request.document)
    if (document.isLeft()) return left(document.value)
    return withParty(this.unitOfWork, request.tenantId, request.partyId, async (party, scope) => {
      const holder = await scope.parties.findByDocument(document.value)
      if (holder && !holder.id.equals(party.id)) return left(new ConflictError(DUPLICATE_DOCUMENT))
      return party.identify(document.value, this.clock.now())
    })
  }
}

export class DescribePartyFiscalProfileUseCase {
  constructor(
    private readonly unitOfWork: PartiesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    readonly tenantId: string
    readonly partyId: string
    readonly profile: FiscalProfileInput
  }): Promise<Either<InvalidInputError | ResourceNotFoundError | ConflictError, number>> {
    const profile = FiscalProfile.create(request.profile)
    if (profile.isLeft()) return left(profile.value)
    return withParty(this.unitOfWork, request.tenantId, request.partyId, (party) =>
      party.describeFiscalProfile(profile.value, this.clock.now()),
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

const LOOKALIKE_LIMIT = 10

/**
 * "Is this already someone we know?" asked before registering (ADR 0057). A match is a
 * warning for the person registering, never a refusal: two companies may share a name.
 */
export class FindLookalikePartiesUseCase {
  constructor(private readonly unitOfWork: PartiesUnitOfWork) {}

  async execute(request: {
    readonly tenantId: string
    readonly legalName: string
    readonly email?: string | null | undefined
    readonly phone?: string | null | undefined
    readonly document?: PartyDocumentInput | undefined
  }): Promise<Either<InvalidInputError, readonly Lookalike[]>> {
    const legalName = PartyName.create(request.legalName)
    if (legalName.isLeft()) return left(legalName.value)
    const document: Either<InvalidInputError, PartyDocument> = request.document
      ? PartyDocument.create(request.document)
      : right(PartyDocument.none())
    if (document.isLeft()) return left(document.value)
    const matches = await this.unitOfWork.inTenant(request.tenantId, (scope) =>
      scope.parties.findLookalikes(
        {
          legalName: legalName.value.value,
          email: request.email ?? null,
          phone: request.phone ?? null,
          document: document.value,
        },
        LOOKALIKE_LIMIT,
      ),
    )
    return right(matches)
  }
}
