/**
 * Fiscal read models as the web shell uses them, and the pure rules the screens apply.
 * Machine values stay in English; the views translate them (ADR 0044). The server still
 * decides every action: these rules only hide what a role or a status cannot do.
 */
export const FISCAL_API = '/api/horizon/fiscal'

export const DOCUMENT_STATUSES = [
  'draft',
  'ready',
  'queued',
  'submitted',
  'unknown',
  'authorized',
  'rejected',
  'cancellation_pending',
  'cancellation_unknown',
  'cancelled',
] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

export const DOCUMENT_MODELS = ['55', '65', 'nfse'] as const
export type DocumentModel = (typeof DOCUMENT_MODELS)[number]

export type FiscalRole = 'admin' | 'issuer' | 'reviewer' | 'viewer'

export type DocumentSummary = {
  id: string
  model: DocumentModel
  environment: 'simulation' | 'homologation'
  simulated: boolean
  fiscalValue: false
  status: DocumentStatus
  originKind: 'sales' | 'manual' | 'linked' | 'service'
  establishmentId: string
  series: number
  number: number | null
  revision: number
  pending: {
    kind: 'issuance' | 'status_query' | 'cancellation' | 'cancellation_query'
    state: 'pending' | 'leased'
    attemptCount: number
    nextAttemptAt: string
  } | null
  lastRejectionCode: string | null
  statusUrl: string
  createdAt: string
  updatedAt: string
}

export type DocumentPage = {
  data: DocumentSummary[]
  page: { hasMore: boolean; nextCursor?: string }
}

export type Transition = {
  id: string
  from: DocumentStatus | null
  to: DocumentStatus
  actorId: string
  commandId: string | null
  occurredAt: string
}

export type Artifact = {
  kind: string
  digest: string
  byteSize: number
  mediaType: string
  createdAt: string
}

export type ExplanationSource = {
  authority?: string
  sourceUri?: string
  digest: string
  [key: string]: unknown
}

export type CalculationExplanation = {
  documentId: string
  inputDigest: string
  rulesDigest: string
  resultDigest: string
  explanation: unknown
  sources: ExplanationSource[]
}

export type SupportOverview = {
  generatedAt: string
  simulationOnly: boolean
  queue: { pending: number; leased: number; oldestDueSeconds: number; maxAttemptCount: number }
  documents: Partial<Record<DocumentStatus, number>>
  unknownOutcomes: number
  rejections: { code: string; count: number; lastObservedAt: string }[]
  certificates: {
    establishmentId: string
    fingerprint: string
    validUntil: string
    daysRemaining: number
    state: CertificateState
  }[]
  imports: { open: number; blocked: number; reconciled: number }
  outbox: { undelivered: number; oldestUndeliveredSeconds: number }
  capabilities: Capability[]
  sourcePackages: {
    id: string
    authority: string
    publishedAt: string
    importedAt: string
    ageDays: number
  }[]
}

export type CertificateState = 'valid' | 'expiring' | 'expired'

export type ImportSummary = {
  id: string
  accessKey: string
  series: number
  number: number
  issuedAt: string
  authorityEnvironment: 'production' | 'homologation'
  supplierPartyId: string | null
  invoiceTotal: string
  lineCount: number
  status: 'open' | 'blocked' | 'reconciled'
  importedAt: string
}

export type Allocation = { receiptId: string; receiptLineId: string; quantity: string }

export type ImportDetail = ImportSummary & {
  supplier: {
    taxId: string
    kind: 'cnpj' | 'cpf'
    legalName: string
    uf: string
    candidatePartyIds: string[]
  }
  lines: {
    number: number
    productCode: string
    description: string
    ncm: string
    cfop: string
    unit: string
    quantity: string
    unitPrice: string
    gross: string
  }[]
  conflicts: {
    id: string
    sourceDigest: string
    receivedAt: string
    dismissed: boolean
    dismissalReason: string | null
  }[]
  proposals: { lineNumber: number; basis: 'mapping' | 'ncm' | 'none'; allocations: Allocation[] }[]
  reconciliation: {
    id: string
    decision: 'matched' | 'overridden'
    comparison: { clean: boolean; invoicedValueMinor: string; expectedValueMinor: string }
    payableTitleIds: string[]
    reviewedBy: string
    reviewedAt: string
  } | null
}

export type Capability = {
  id: string
  model: DocumentModel
  environment: 'simulation' | 'homologation'
  establishmentId: string
  jurisdiction: { kind: string; code: string }
  operation: string
  adapterVersion: string
  status: 'simulated' | 'homologated'
  activatedAt: string
}

export type DocumentKind = {
  model: string
  kind: string
  supported: boolean
  flows?: string[]
  [key: string]: unknown
}

export type MunicipalityResolution = {
  municipalityCode: string
  competenceDate: string
  route: 'national' | 'unsupported'
  reason: string | null
}

/** What a reader sees for a document status: its badge tone and whether it is settled. */
export function statusTone(status: DocumentStatus): string {
  switch (status) {
    case 'authorized':
      return 'approved'
    case 'rejected':
    case 'cancelled':
      return status
    case 'queued':
    case 'submitted':
    case 'unknown':
    case 'cancellation_pending':
    case 'cancellation_unknown':
      return 'pending'
    default:
      return 'open'
  }
}

/** A document the authority has not settled yet; the screen offers no final reading. */
export function isUncertain(status: DocumentStatus): boolean {
  return status === 'unknown' || status === 'cancellation_unknown'
}

export type DocumentAction =
  | 'validate'
  | 'issue'
  | 'consult'
  | 'consultCancellation'
  | 'cancel'
  | 'correctionLetter'
  | 'substitute'

/**
 * The actions a role may attempt on a document in a status. Visibility only: Fiscal refuses
 * what it does not permit, and the screen shows its reason (ADR 0023, ADR 0045).
 */
export function allowedActions(
  role: FiscalRole | null,
  document: Pick<DocumentSummary, 'model' | 'status' | 'environment'>,
): DocumentAction[] {
  if (role !== 'admin' && role !== 'issuer') return []
  if (document.environment !== 'simulation') return []
  const actions: DocumentAction[] = []
  if (document.status === 'draft') actions.push('validate')
  if (document.status === 'ready') actions.push('issue')
  if (document.status === 'unknown' && document.model !== 'nfse') actions.push('consult')
  if (document.status === 'cancellation_unknown' && document.model !== 'nfse')
    actions.push('consultCancellation')
  if (document.status === 'authorized') {
    actions.push('cancel')
    if (document.model === '55') actions.push('correctionLetter')
    if (document.model === 'nfse') actions.push('substitute')
  }
  return actions
}

/**
 * The request body of an action with a form. `read` returns a form field as typed; blank
 * optional fields are left out, and the NFS-e events carry their reason codes.
 */
export function actionBody(
  action: DocumentAction,
  model: DocumentModel,
  read: (name: string) => string,
): Record<string, unknown> | undefined {
  const text = (name: string) => read(name).trim()
  if (action === 'cancel')
    return model === 'nfse'
      ? { reasonCode: text('reasonCode') || '9', reason: text('reason') }
      : { reason: text('reason') }
  if (action === 'correctionLetter')
    return { text: text('text'), attestation: read('attestation') === 'on' }
  if (action === 'substitute')
    return {
      reasonCode: text('reasonCode') || '99',
      ...(text('reason') ? { reason: text('reason') } : {}),
      correctedOrigin: { serviceOriginId: text('serviceOriginId') },
    }
  return undefined
}

/** The label every simulated document carries; it never reads as a valid fiscal document. */
export function simulationLabelKey(document: Pick<DocumentSummary, 'simulated'>): string {
  return document.simulated ? 'simulationLabel' : 'homologationLabel'
}

/** The reading URL of a document of any model. */
export function documentUrl(document: Pick<DocumentSummary, 'id' | 'model'>): string {
  return document.model === 'nfse'
    ? `${FISCAL_API}/service-documents/${document.id}`
    : `${FISCAL_API}/documents/${document.id}`
}

export function fiscalRoleOf(
  roles: readonly { module: string; role: string }[],
): FiscalRole | null {
  const found = roles.find((assignment) => assignment.module === 'fiscal')?.role
  return found === 'admin' || found === 'issuer' || found === 'reviewer' || found === 'viewer'
    ? found
    : null
}

export type PreviewForm = {
  establishmentId: string
  model: DocumentModel
  operation: string
  issueDate: string
  issuerRegime: string
  issuerState: string
  issuerMunicipality: string
  recipientState: string
  recipientMunicipality: string
  recipientTaxpayer: boolean
  lineId: string
  itemId: string
  classification: string
  quantity: string
  unitPrice: string
}

/**
 * Builds the calculation input of a one-line preview. Origin and destination follow the
 * issuer and recipient; a service line is classified by its service code, goods by NCM.
 * The tenant is not sent: Fiscal takes it from the caller's token.
 * Returns the problem key when a field is malformed.
 */
export function buildPreviewInput(
  form: PreviewForm,
): { ok: true; input: Record<string, unknown> } | { ok: false; problem: string } {
  const decimal = /^(0|[1-9]\d*)(\.\d{1,6})?$/
  if (!/^\d{2}$/.test(form.issuerState) || !/^\d{2}$/.test(form.recipientState))
    return { ok: false, problem: 'previewStateInvalid' }
  if (!/^\d{7}$/.test(form.issuerMunicipality) || !/^\d{7}$/.test(form.recipientMunicipality))
    return { ok: false, problem: 'previewMunicipalityInvalid' }
  if (!decimal.test(form.quantity) || !decimal.test(form.unitPrice))
    return { ok: false, problem: 'previewAmountInvalid' }
  const service = form.model === 'nfse'
  if (!service && !/^\d{8}$/.test(form.classification))
    return { ok: false, problem: 'previewNcmInvalid' }
  if (service && !form.classification.trim()) return { ok: false, problem: 'previewServiceInvalid' }
  const place = (state: string, municipality: string) => ({
    countryCode: '1058',
    stateCode: state,
    municipalityCode: municipality,
  })
  return {
    ok: true,
    input: {
      schemaVersion: 1,
      issuerEstablishmentId: form.establishmentId,
      model: form.model,
      environment: 'simulation',
      operation: form.operation.trim(),
      purpose: 'normal',
      issuer: {
        regime: form.issuerRegime,
        stateCode: form.issuerState,
        municipalityCode: form.issuerMunicipality,
      },
      recipient: {
        regime: form.recipientTaxpayer ? 'normal' : 'final-consumer',
        stateCode: form.recipientState,
        municipalityCode: form.recipientMunicipality,
        taxpayer: form.recipientTaxpayer,
      },
      origin: place(form.issuerState, form.issuerMunicipality),
      destination: place(form.recipientState, form.recipientMunicipality),
      issueDate: form.issueDate,
      ...(service ? { competenceDate: form.issueDate } : {}),
      currency: 'BRL',
      lines: [
        {
          id: form.lineId,
          ...(service ? { serviceId: form.itemId } : { itemId: form.itemId }),
          quantity: form.quantity,
          unitPrice: form.unitPrice,
          discount: { amount: '0', currency: 'BRL' },
          charges: { amount: '0', currency: 'BRL' },
          classifications: service
            ? { service: form.classification.trim() }
            : { ncm: form.classification },
          taxFacts: {},
        },
      ],
    },
  }
}

/** Accepts the reconciliation Fiscal proposed: every proposed allocation, the rest unmatched. */
export function reconciliationFromProposals(
  detail: Pick<ImportDetail, 'proposals' | 'lines'>,
  supplierPartyId: string,
  overrideReason?: string,
): Record<string, unknown> {
  const matched = detail.proposals.filter((proposal) => proposal.allocations.length > 0)
  const matchedLines = new Set(matched.map((proposal) => proposal.lineNumber))
  return {
    supplierPartyId,
    lines: matched.flatMap((proposal) =>
      proposal.allocations.map((allocation) => ({
        ...allocation,
        lineNumber: proposal.lineNumber,
      })),
    ),
    unmatchedLines: detail.lines
      .map((line) => line.number)
      .filter((number) => !matchedLines.has(number)),
    rememberMappings: true,
    ...(overrideReason?.trim() ? { overrideReason: overrideReason.trim() } : {}),
  }
}

/** Seconds as the largest whole unit a reader needs: 45 s, 12 min, 3 h, 2 d. */
export function ageParts(seconds: number): {
  value: number
  unit: 'second' | 'minute' | 'hour' | 'day'
} {
  if (seconds < 60) return { value: Math.max(0, Math.floor(seconds)), unit: 'second' }
  if (seconds < 3600) return { value: Math.floor(seconds / 60), unit: 'minute' }
  if (seconds < 86_400) return { value: Math.floor(seconds / 3600), unit: 'hour' }
  return { value: Math.floor(seconds / 86_400), unit: 'day' }
}

/** Certificates this close to expiry are `expiring`, as in the Fiscal support read. */
export const CERTIFICATE_WARNING_DAYS = 30

export function certificateStateOf(validUntil: string, now: Date): CertificateState {
  const remaining = new Date(validUntil).getTime() - now.getTime()
  if (remaining <= 0) return 'expired'
  return remaining <= CERTIFICATE_WARNING_DAYS * 86_400_000 ? 'expiring' : 'valid'
}
