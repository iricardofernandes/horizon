import { type Either, left, right } from '@/core/either'
import type { UseCaseError } from '@/core/errors/use-case-error'
import { Party } from '@/domain/entities/party'
import type { RowIssue } from '@/domain/imports/import-job'
import {
  type ImportFieldSpec,
  type ImportRecord,
  issue,
  listOf,
  normalizeHeader,
  valueIn,
} from '@/domain/imports/import-values'
import {
  PartyDocument,
  type PartyDocumentInput,
  type PartyKind,
  PartyRoles,
} from '@/domain/value-objects/party-values'
import type { Clock } from '../ports/clock'
import type { PartiesUnitOfWork } from '../ports/unit-of-work'
import { detailsOf, RegisterPartyUseCase } from '../use-cases/manage-parties'
import { type ImportActor, type ImportSession, type RowImporter, type RowKey } from './ports'

const FIELDS: readonly ImportFieldSpec[] = [
  {
    name: 'kind',
    required: true,
    aliases: ['tipo', 'natureza', 'pessoa', 'tipo de pessoa'],
    description: 'organization or person (also PJ or PF)',
  },
  {
    name: 'legalName',
    required: true,
    aliases: ['razao social', 'nome', 'name', 'legal name', 'nome completo'],
    description: 'The registered or full name',
  },
  {
    name: 'tradeName',
    required: false,
    aliases: ['nome fantasia', 'fantasia', 'trade name'],
    description: 'The name the business trades under',
  },
  {
    name: 'documentType',
    required: false,
    aliases: ['tipo de documento', 'tipo documento', 'document type'],
    description: 'cpf, cnpj, foreign or none; inferred from the kind when left out',
  },
  {
    name: 'documentNumber',
    required: false,
    aliases: ['documento', 'cpf/cnpj', 'cpf cnpj', 'cnpj', 'cpf', 'document', 'tax id'],
    description: 'The CPF, CNPJ or foreign identifier',
  },
  {
    name: 'documentCountry',
    required: false,
    aliases: ['pais', 'país do documento', 'country'],
    description: 'Two-letter country of a foreign identifier',
  },
  { name: 'email', required: false, aliases: ['e-mail'], description: 'Email address' },
  {
    name: 'phone',
    required: false,
    aliases: ['telefone', 'fone', 'celular', 'phone number'],
    description: 'Phone number',
  },
  {
    name: 'address',
    required: false,
    aliases: ['endereco', 'endereço'],
    description: 'Postal address in one line',
  },
  {
    name: 'roles',
    required: false,
    aliases: ['papeis', 'papéis', 'papel', 'role'],
    description: 'customer, supplier, carrier, prospect or partner, separated by |',
  },
]

const KINDS: Readonly<Record<string, PartyKind>> = {
  organization: 'organization',
  organizacao: 'organization',
  pj: 'organization',
  juridica: 'organization',
  pessoajuridica: 'organization',
  empresa: 'organization',
  person: 'person',
  pessoa: 'person',
  pf: 'person',
  fisica: 'person',
  pessoafisica: 'person',
}

const ROLES: Readonly<Record<string, string>> = {
  cliente: 'customer',
  fornecedor: 'supplier',
  transportadora: 'carrier',
  prospecto: 'prospect',
  parceiro: 'partner',
}

export interface PartyImportCommand {
  readonly kind: PartyKind
  readonly document: PartyDocumentInput
  readonly roles: readonly string[]
  readonly legalName: string
  readonly tradeName: string | null
  readonly email: string | null
  readonly phone: string | null
  readonly address: string | null
}

/** The use case's JSON pointer, as the importer's field name. */
function issueOf(error: UseCaseError & { field?: string }): RowIssue {
  const pointer = error.field?.split('/').filter(Boolean) ?? []
  const field =
    pointer[0] === 'document'
      ? `document${(pointer[1] ?? 'number').replace(/^./, (c) => c.toUpperCase())}`
      : (pointer[0] ?? null)
  return issue(field, error.message)
}

/**
 * A spreadsheet that stored a document as a number dropped its leading zeros; a number
 * missing more than three is not a document that lost them.
 */
function withLeadingZeros(number: string, length: number): string {
  const lost = length - number.length
  return /^\d+$/.test(number) && lost > 0 && lost <= 3 ? number.padStart(length, '0') : number
}

function documentOf(record: ImportRecord, kind: PartyKind): Either<RowIssue, PartyDocumentInput> {
  const number = valueIn(record, 'documentNumber')
  const stated = valueIn(record, 'documentType')?.toLowerCase() ?? null
  const type = stated ?? (number === null ? 'none' : kind === 'person' ? 'cpf' : 'cnpj')
  if (type === 'none') {
    if (number !== null) return left(issue('documentType', 'a document of type none has no number'))
    return right({ type: 'none' })
  }
  if (number === null) return left(issue('documentNumber', `a ${type} needs its number`))
  if (type === 'cpf' || type === 'cnpj') {
    const padded = withLeadingZeros(number, type === 'cpf' ? 11 : 14)
    return right({ type, number: padded })
  }
  if (type === 'foreign')
    return right({ type, number, country: valueIn(record, 'documentCountry') ?? '' })
  return left(issue('documentType', 'must be cpf, cnpj, foreign or none'))
}

/**
 * Parties with their kind, document, contact details and roles (Phase 64). A row is valid
 * exactly when `Party.register` accepts it; a document already registered is refused
 * when written, by the same check the API makes.
 */
export class PartyImporter implements RowImporter<PartyImportCommand> {
  readonly kind = 'parties'
  readonly fields = FIELDS

  constructor(
    private readonly clock: Clock,
    private readonly rowUnitOfWork: (key: RowKey) => PartiesUnitOfWork,
  ) {}

  async session(context: ImportActor): Promise<ImportSession<PartyImportCommand>> {
    return {
      validate: (record) => this.validate(record, context.tenantId),
      uniqueKey: (command) =>
        command.document.type === 'none'
          ? null
          : `${command.document.type}:${normalizeHeader(command.document.number)}`,
    }
  }

  private validate(
    record: ImportRecord,
    tenantId: string,
  ): Either<readonly RowIssue[], PartyImportCommand> {
    const kind = KINDS[normalizeHeader(valueIn(record, 'kind') ?? '')]
    if (!kind) return left([issue('kind', 'must be organization or person (PJ or PF)')])
    const issues: RowIssue[] = []
    const details = detailsOf({
      legalName: valueIn(record, 'legalName') ?? '',
      tradeName: valueIn(record, 'tradeName'),
      email: valueIn(record, 'email'),
      phone: valueIn(record, 'phone'),
      address: valueIn(record, 'address'),
    })
    if (details.isLeft()) issues.push(issueOf(details.value))
    const documentInput = documentOf(record, kind)
    if (documentInput.isLeft()) issues.push(documentInput.value)
    const document = documentInput.isRight()
      ? PartyDocument.create(documentInput.value, kind)
      : null
    if (document?.isLeft()) issues.push(issueOf(document.value))
    const roleNames = listOf(valueIn(record, 'roles')).map((role) => {
      const normalized = normalizeHeader(role)
      return ROLES[normalized] ?? role.toLowerCase()
    })
    const roles = PartyRoles.of(roleNames)
    if (roles.isLeft()) issues.push(issueOf(roles.value))
    if (
      issues.length > 0 ||
      details.isLeft() ||
      !document ||
      document.isLeft() ||
      documentInput.isLeft() ||
      roles.isLeft()
    )
      return left(issues)
    const registered = Party.register({
      tenantId,
      kind,
      document: document.value,
      roles: roles.value,
      ...details.value,
      now: this.clock.now(),
    })
    if (registered.isLeft()) return left([issueOf(registered.value)])
    return right({
      kind,
      document: documentInput.value,
      roles: roleNames,
      legalName: valueIn(record, 'legalName') ?? '',
      tradeName: valueIn(record, 'tradeName'),
      email: valueIn(record, 'email'),
      phone: valueIn(record, 'phone'),
      address: valueIn(record, 'address'),
    })
  }

  async write(
    command: PartyImportCommand,
    key: RowKey,
    context: ImportActor,
  ): Promise<Either<readonly RowIssue[], string>> {
    const register = new RegisterPartyUseCase(this.rowUnitOfWork(key), this.clock)
    const outcome = await register.execute({ tenantId: context.tenantId, ...command })
    return outcome.isRight() ? right(outcome.value.partyId) : left([issueOf(outcome.value)])
  }
}
