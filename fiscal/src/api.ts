import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  auditQuerySchema,
  fiscalArtifactListV2Schema,
  fiscalCapabilityListV2Schema,
  fiscalCorrectionRequestSchema,
  fiscalDocumentCreateRequestV2Schema,
  fiscalDocumentV3Schema,
  fiscalManualOriginRequestSchema,
  SCOPE_REFUSAL_MESSAGE,
  scopeAllows,
} from '@horizon/contracts'
import { z } from 'zod'
import type { FiscalArtifacts } from './artifacts'
import type { FiscalAuditLog } from './audit-log'
import { type FiscalPermission, type FiscalPrincipal, type FiscalTokenVerifier, may } from './auth'
import type { FiscalCalculations } from './calculations'
import { CancellationWindowElapsed, type FiscalCancellation } from './cancellation'
import { canonicalDigest } from './canonical-json'
import type { FiscalCapabilities } from './capabilities'
import type { FiscalDispatch } from './dispatch'
import { supportedKind } from './document-kinds'
import { documentListQuerySchema, type FiscalDocumentList } from './document-list'
import { type FiscalDocuments, FiscalModelConflict } from './documents'
import type { FiscalEstablishmentCredentials } from './establishment-credentials'
import type { FiscalEstimates } from './estimates'
import { type GovernanceDependencies, handleGovernanceRoute } from './governance-api'
import { handleInboundRoute, type InboundDependencies } from './inbound-api'
import type { FiscalIssuance } from './issuance'
import { handleLinkedRoute, type LinkedDependencies } from './linked-api'
import type { FiscalLinkedOrigins } from './linked-origins'
import type { FiscalManualOrigins } from './manual-origins'
import { ReadinessStale } from './nfce65/build'
import { handleServiceRoute, type ServiceDependencies } from './nfse/api'
import { ConsumerNotEligible, type FiscalReadiness } from './readiness'
import type { FiscalRuleStore } from './rule-store'
import type { FiscalSupport } from './support'
import { taxSupportResponse } from './tax-support-api'

export type FiscalServerDependencies = {
  verifier: Pick<FiscalTokenVerifier, 'verify'>
  documents: Pick<
    FiscalDocuments,
    | 'get'
    | 'timeline'
    | 'createDraft'
    | 'createManualDraft'
    | 'createSuccessor'
    | 'createManualSuccessor'
  > &
    Partial<Pick<FiscalDocuments, 'createLinkedDraft' | 'createLinkedSuccessor'>>
  manualOrigins: Pick<FiscalManualOrigins, 'create'>
  dispatch?: Pick<FiscalDispatch, 'queueStatusQuery' | 'queueCancellationQuery'>
  artifacts: Pick<FiscalArtifacts, 'get' | 'getV2' | 'list' | 'listV2'>
  calculations: Pick<FiscalCalculations, 'preview' | 'get'>
  estimates?: Pick<FiscalEstimates, 'estimate'>
  capabilities: Pick<FiscalCapabilities, 'listActive'>
  readiness: Pick<FiscalReadiness, 'validate'>
  issuance?: Pick<FiscalIssuance, 'issue'>
  cancellation?: Pick<FiscalCancellation, 'request'>
  rules: Pick<FiscalRuleStore, 'proposeOverride'>
  credentials?: Pick<FiscalEstablishmentCredentials, 'list' | 'upload'>
  inbound?: InboundDependencies
  linked?: LinkedDependencies & { origins: Pick<FiscalLinkedOrigins, 'create' | 'kindOf'> }
  service?: ServiceDependencies
  documentList?: Pick<FiscalDocumentList, 'list'>
  support?: Pick<FiscalSupport, 'overview'>
  audit?: Pick<FiscalAuditLog, 'page'>
  governance?: GovernanceDependencies
}

export function createFiscalServer(dependencies: FiscalServerDependencies): Server {
  return createServer((request, response) => {
    void handle(request, response, dependencies).catch(() =>
      problem(response, 500, 'Internal Server Error', 'Fiscal request failed'),
    )
  })
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: FiscalServerDependencies,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://fiscal.local')
  if (request.method === 'GET' && url.pathname === '/health') {
    json(response, 200, { status: 'ok', service: 'fiscal' })
    return
  }
  let principal: FiscalPrincipal
  try {
    principal = await dependencies.verifier.verify(request.headers.authorization)
  } catch {
    problem(response, 401, 'Unauthorized', 'A valid Fiscal access token is required')
    return
  }
  // A key's scopes before any role (ADR 0064), so a read-only key reads the same everywhere.
  if (!scopeAllows(principal.scopes, 'fiscal', request.method ?? 'POST')) {
    problem(response, 403, 'Forbidden', SCOPE_REFUSAL_MESSAGE)
    return
  }
  // Before the general read check: an auditor reads the audit log and nothing else (Phase 69).
  if (request.method === 'GET' && url.pathname === '/audit' && dependencies.audit) {
    if (!requirePermission(principal, 'audit:read', response)) return
    response.setHeader('cache-control', 'private, no-store')
    const query = auditQuerySchema.safeParse(Object.fromEntries(url.searchParams))
    if (!query.success) {
      problem(response, 400, 'Bad Request', 'Invalid Fiscal audit query')
      return
    }
    json(response, 200, await dependencies.audit.page(principal.tenantId, query.data))
    return
  }

  if (!requirePermission(principal, 'read', response)) return
  if (
    dependencies.inbound &&
    (await handleInboundRoute(request, response, url, principal, dependencies.inbound))
  )
    return
  if (
    dependencies.linked &&
    (await handleLinkedRoute(request, response, url, principal, dependencies.linked))
  )
    return
  if (
    dependencies.service &&
    (await handleServiceRoute(request, response, url, principal, dependencies.service))
  )
    return
  if (
    dependencies.governance &&
    (await handleGovernanceRoute(request, response, url, principal, dependencies.governance))
  )
    return

  if (url.pathname === '/establishment-credentials' && dependencies.credentials) {
    response.setHeader('cache-control', 'private, no-store')
    if (request.method === 'GET') {
      if (!requirePermission(principal, 'credentials:manage', response)) return
      json(response, 200, { data: await dependencies.credentials.list(principal.tenantId) })
      return
    }
    if (request.method === 'POST') {
      if (!requirePermission(principal, 'credentials:manage', response)) return
      try {
        const body = z
          .strictObject({
            establishmentId: z.uuid(),
            pfxBase64: z
              .string()
              .min(1)
              .max(700_000)
              .regex(/^[A-Za-z0-9+/]+={0,2}$/),
            password: z.string().min(1).max(1024),
          })
          .parse(await readJson(request))
        const pfx = Buffer.from(body.pfxBase64, 'base64')
        if (pfx.toString('base64') !== body.pfxBase64)
          throw new SyntaxError('Invalid certificate encoding')
        const saved = await dependencies.credentials.upload({
          tenantId: principal.tenantId,
          establishmentId: body.establishmentId,
          pfx,
          password: body.password,
          actorId: principal.subject,
        })
        json(response, 201, saved)
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof SyntaxError)
          problem(response, 400, 'Bad Request', 'Invalid certificate upload')
        else if (error instanceof Error && /certificate|password|Certificate/.test(error.message))
          problem(response, 422, 'Unprocessable Content', error.message)
        else throw error
      }
      return
    }
  }

  if (request.method === 'GET' && url.pathname === '/capabilities') {
    const supported = (await dependencies.capabilities.listActive(principal.tenantId))
      .filter(
        (capability) =>
          capability.model === '55' &&
          capability.environment === 'simulation' &&
          capability.operation === 'normal-sale',
      )
      .map((capability) => ({
        id: capability.id,
        model: '55' as const,
        environment: 'simulation' as const,
        establishmentId: capability.establishmentId,
        jurisdiction: {
          kind: capability.jurisdictionKind as 'uf',
          code: capability.jurisdictionCode,
        },
        operation: 'normal-sale' as const,
        adapterVersion: capability.adapterVersion,
        status: 'simulated' as const,
        sourceManifestDigest: capability.sourceManifestDigest,
        schemaPackageDigest: capability.schemaPackageDigest,
        calculationFixtureId: capability.calculationFixtureId,
        evidenceDigest: capability.evidenceDigest,
        activatedAt: capability.activatedAt,
      }))
    json(response, 200, {
      defaultStatus: 'unsupported',
      supported,
    })
    return
  }

  if (request.method === 'GET' && url.pathname === '/capabilities/v2') {
    const supported = (await dependencies.capabilities.listActive(principal.tenantId))
      .filter(
        (capability) =>
          capability.model === '55' &&
          capability.jurisdictionKind === 'uf' &&
          capability.operation === 'normal-sale' &&
          (capability.environment === 'simulation' || capability.environment === 'homologation'),
      )
      .map((capability) => ({
        id: capability.id,
        model: '55' as const,
        environment: capability.environment,
        establishmentId: capability.establishmentId,
        jurisdiction: { kind: 'uf' as const, code: capability.jurisdictionCode },
        operation: 'normal-sale' as const,
        adapterVersion: capability.adapterVersion,
        status: capability.status,
        sourceManifestDigest: capability.sourceManifestDigest,
        schemaPackageDigest: capability.schemaPackageDigest,
        calculationFixtureId: capability.calculationFixtureId,
        evidenceDigest: capability.evidenceDigest,
        activatedAt: capability.activatedAt,
        fiscalValue: false as const,
      }))
    response.setHeader('cache-control', 'private, no-store')
    json(
      response,
      200,
      fiscalCapabilityListV2Schema.parse({ defaultStatus: 'unsupported', supported }),
    )
    return
  }

  if (request.method === 'POST' && url.pathname === '/estimates' && dependencies.estimates) {
    // An estimate never locks and never transmits (ADR 0073); reading is enough to ask for one.
    if (!requirePermission(principal, 'read', response)) return
    try {
      const body = await readJson(request)
      response.setHeader('cache-control', 'private, no-store')
      json(response, 200, await dependencies.estimates.estimate(principal.tenantId, body))
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        problem(response, 400, 'Bad Request', 'Invalid tax estimate request')
      else throw error
    }
    return
  }

  if (request.method === 'POST' && url.pathname === '/calculations/preview') {
    try {
      const body = await readJson(request)
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SyntaxError()
      const outcome = await dependencies.calculations.preview({
        ...(body as Record<string, unknown>),
        tenantId: principal.tenantId,
      })
      response.setHeader('cache-control', 'private, no-store')
      if (outcome.supported) json(response, 200, outcome)
      else
        fiscalProblem(
          response,
          outcome.code === 'AMBIGUOUS_RULE' || outcome.code === 'SOURCE_NOT_APPROVED' ? 409 : 422,
          outcome,
        )
    } catch (error) {
      if (error instanceof SyntaxError)
        problem(response, 400, 'Bad Request', 'Invalid Fiscal calculation preview request')
      else throw error
    }
    return
  }

  if (request.method === 'POST' && url.pathname === '/rule-overrides') {
    if (!requirePermission(principal, 'rules:manage', response)) return
    try {
      const body = z
        .object({
          predecessorRuleId: z.uuid(),
          proposedDefinition: z.record(z.string(), z.unknown()),
          sourceBasisUri: z.url(),
          sourceBasisSection: z.string().min(1).max(300),
          reason: z.string().min(10).max(1000),
        })
        .parse(await readJson(request))
      const proposal = await dependencies.rules.proposeOverride({
        ...body,
        tenantId: principal.tenantId,
        actorId: principal.subject,
      })
      json(response, 201, proposal)
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        problem(response, 400, 'Bad Request', 'Invalid Fiscal rule override proposal')
      else if (error instanceof Error && error.message.endsWith('not found'))
        problem(response, 404, 'Not Found', 'Fiscal predecessor rule not found')
      else throw error
    }
    return
  }

  if (request.method === 'POST' && url.pathname === '/manual-origins') {
    if (!requirePermission(principal, 'draft:create', response)) return
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || key.length < 16 || key.length > 128) {
      problem(response, 400, 'Bad Request', 'Idempotency-Key must have 16 to 128 characters')
      return
    }
    try {
      const body = fiscalManualOriginRequestSchema.parse(await readJson(request))
      const created = await dependencies.manualOrigins.create({
        ...body,
        tenantId: principal.tenantId,
        idempotencyKey: key,
        actorId: principal.subject,
      })
      json(response, 201, created)
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        problem(response, 422, 'Unprocessable Content', 'Invalid Fiscal manual-origin request')
      else if (error instanceof Error && error.message.startsWith('Conflicting'))
        problem(response, 409, 'Conflict', error.message)
      else if (error instanceof Error && error.message.includes('capability'))
        lifecycleProblem(response, 409, 'CAPABILITY_UNSUPPORTED', error.message)
      else if (error instanceof Error && error.message.includes('unavailable'))
        problem(response, 404, 'Not Found', error.message)
      else if (
        error instanceof Error &&
        (error.message.includes('unsupported') ||
          error.message.includes('mismatch') ||
          error.message.startsWith('Duplicate Fiscal manual'))
      )
        problem(response, 422, 'Unprocessable Content', error.message)
      else throw error
    }
    return
  }

  if (request.method === 'GET' && url.pathname === '/documents' && dependencies.documentList) {
    if (!requirePermission(principal, 'read', response)) return
    response.setHeader('cache-control', 'private, no-store')
    try {
      const query = documentListQuerySchema.parse(Object.fromEntries(url.searchParams))
      json(response, 200, await dependencies.documentList.list(principal.tenantId, query))
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        problem(response, 400, 'Bad Request', 'Invalid Fiscal document list query')
      else throw error
    }
    return
  }

  if (request.method === 'GET' && url.pathname === '/support') {
    if (!requirePermission(principal, 'read', response)) return
    const outcome = taxSupportResponse(url.searchParams)
    if (outcome.status === 400) problem(response, 400, 'Bad Request', outcome.detail)
    else json(response, 200, outcome.body)
    return
  }

  if (request.method === 'GET' && url.pathname === '/support/overview' && dependencies.support) {
    if (!requirePermission(principal, 'read', response)) return
    response.setHeader('cache-control', 'private, no-store')
    json(response, 200, await dependencies.support.overview(principal.tenantId))
    return
  }

  if (request.method === 'POST' && url.pathname === '/documents') {
    if (!requirePermission(principal, 'draft:create', response)) return
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || key.length < 16 || key.length > 128) {
      problem(response, 400, 'Bad Request', 'Idempotency-Key must have 16 to 128 characters')
      return
    }
    try {
      const body = fiscalDocumentCreateRequestV2Schema.parse(await readJson(request))
      const origin = body.origin
      // An NFC-e is a consumer sale: only a Sales intent can become one.
      if (body.model === '65' && origin.kind !== 'sales')
        throw new Error('Fiscal capability is unsupported for model 65 without a Sales origin')
      const linkedKind =
        origin.kind === 'linked'
          ? await dependencies.linked?.origins.kindOf(principal.tenantId, origin.linkedOriginId)
          : null
      if (origin.kind === 'linked' && !linkedKind) throw new Error('Fiscal linked origin not found')
      const operation =
        body.model === '65'
          ? supportedKind('consumer-sale').operation
          : linkedKind
            ? supportedKind(linkedKind).operation
            : 'normal-sale'
      const active = (await dependencies.capabilities.listActive(principal.tenantId)).some(
        (capability) =>
          capability.model === body.model &&
          capability.environment === 'simulation' &&
          capability.establishmentId === body.establishmentId &&
          capability.jurisdictionKind === 'uf' &&
          capability.operation === operation,
      )
      if (!active) throw new Error('Fiscal capability is unsupported')
      if (origin.kind === 'linked' && !dependencies.documents.createLinkedDraft)
        throw new Error('Fiscal capability is unsupported for linked documents')
      const draft =
        origin.kind === 'linked' && dependencies.documents.createLinkedDraft
          ? await dependencies.documents.createLinkedDraft({
              tenantId: principal.tenantId,
              linkedOriginId: origin.linkedOriginId,
              establishmentId: body.establishmentId,
              series: body.series,
              idempotencyKey: key,
              actorId: principal.subject,
            })
          : origin.kind === 'sales'
            ? await dependencies.documents.createDraft({
                tenantId: principal.tenantId,
                intentId: origin.intentId,
                model: body.model,
                environment: 'simulation',
                establishmentId: body.establishmentId,
                series: body.series,
                idempotencyKey: key,
                actorId: principal.subject,
              })
            : await dependencies.documents.createManualDraft({
                tenantId: principal.tenantId,
                manualOriginId: (origin as { manualOriginId: string }).manualOriginId,
                establishmentId: body.establishmentId,
                series: body.series,
                idempotencyKey: key,
                actorId: principal.subject,
              })
      json(response, 201, draft)
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        problem(response, 400, 'Bad Request', 'Invalid fiscal draft request')
      else if (
        error instanceof FiscalModelConflict ||
        ((error as { code?: string }).code === '23514' &&
          String((error as Error).message).includes('keeps the model'))
      )
        lifecycleProblem(
          response,
          409,
          'MODEL_CONFLICT',
          error instanceof FiscalModelConflict
            ? error.message
            : 'Fiscal sale already has a document of the other model',
        )
      else if (error instanceof Error && error.message.startsWith('Conflicting fiscal'))
        problem(response, 409, 'Conflict', error.message)
      else if (error instanceof Error && error.message.includes('capability'))
        lifecycleProblem(response, 409, 'CAPABILITY_UNSUPPORTED', error.message)
      else if (
        error instanceof Error &&
        (error.message === 'Fiscal manual origin not found' ||
          error.message === 'Fiscal linked origin not found')
      )
        problem(response, 404, 'Not Found', error.message)
      else if (
        error instanceof Error &&
        error.message.startsWith('Fiscal origin snapshot unavailable')
      )
        problem(response, 409, 'Conflict', 'Fiscal origin requires owner-event replay')
      else if ((error as { code?: string }).code === '23503')
        problem(response, 404, 'Not Found', 'Fiscal origin is unavailable')
      else throw error
    }
    return
  }

  const artifactListV2 = /^\/documents\/([0-9a-f-]{36})\/artifacts\/v2$/.exec(url.pathname)
  if (request.method === 'GET' && artifactListV2?.[1]) {
    const found = await dependencies.artifacts.listV2(principal.tenantId, artifactListV2[1])
    response.setHeader('cache-control', 'private, no-store')
    const listed = found ? fiscalArtifactListV2Schema.safeParse(found) : null
    // An NFS-e keeps kinds (`nfse_xml`) this NF-e schema does not name: use the v1 list.
    if (!listed?.success) problem(response, 404, 'Not Found', 'Fiscal document not found')
    else json(response, 200, listed.data)
    return
  }

  const artifactList = /^\/documents\/([0-9a-f-]{36})\/artifacts$/.exec(url.pathname)
  if (request.method === 'GET' && artifactList?.[1]) {
    const found = await dependencies.artifacts.list(principal.tenantId, artifactList[1])
    response.setHeader('cache-control', 'private, no-store')
    if (!found) problem(response, 404, 'Not Found', 'Fiscal document not found')
    else json(response, 200, found)
    return
  }

  const artifact =
    /^\/documents\/([0-9a-f-]{36})\/artifacts\/(v2\/)?(xml|response|protocol|pdf|unsigned_xml|signed_xml|issuance_request|issuance_response|authorization_protocol|cancellation_request|cancellation_response|cancellation_protocol|danfe|homologation_request|homologation_response|homologation_protocol|nfse_xml|substitution_event)$/.exec(
      url.pathname,
    )
  if (request.method === 'GET' && artifact) {
    const documentId = artifact[1]
    const v2 = Boolean(artifact[2])
    if (v2 && !requirePermission(principal, 'evidence:read', response)) return
    const kind = artifact[3] as Parameters<FiscalArtifacts['getV2']>[2]
    const digest = url.searchParams.get('digest')
    if (!documentId || !digest) {
      problem(response, 400, 'Bad Request', 'A document and digest are required')
      return
    }
    try {
      const found = await dependencies.artifacts.getV2(principal.tenantId, documentId, kind, digest)
      if (!v2 && found.metadata.environment !== 'simulation') {
        problem(response, 404, 'Not Found', 'Fiscal artifact not found')
        return
      }
      response.writeHead(200, {
        'content-type': found.metadata.mediaType,
        'content-length': found.bytes.length,
        digest: `sha-256=${Buffer.from(found.metadata.digest, 'hex').toString('base64')}`,
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${found.metadata.environment === 'simulation' ? 'simulacao' : 'homologacao-sem-valor-fiscal'}-${kind}-${digest}.${found.metadata.mediaType === 'application/pdf' ? 'pdf' : found.metadata.mediaType.includes('xml') ? 'xml' : 'json'}"`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'sandbox',
      })
      response.end(found.bytes)
    } catch {
      problem(response, 404, 'Not Found', 'Fiscal artifact not found')
    }
    return
  }

  const documentV2 = /^\/documents\/([0-9a-f-]{36})\/v2$/.exec(url.pathname)
  if (request.method === 'GET' && documentV2?.[1]) {
    const found = await dependencies.documents.get(principal.tenantId, documentV2[1])
    // An NFS-e is read from `/service-documents/{id}`.
    if (!found || found.model === 'nfse')
      problem(response, 404, 'Not Found', 'Fiscal document not found')
    else
      json(
        response,
        200,
        fiscalDocumentV3Schema.parse({
          ...found,
          fiscalValue: false,
          statusUrl: `/fiscal/documents/${found.id}/v2`,
        }),
      )
    return
  }

  const document = /^\/documents\/([0-9a-f-]{36})$/.exec(url.pathname)
  if (request.method === 'GET' && document?.[1]) {
    const found = await dependencies.documents.get(principal.tenantId, document[1])
    if (found?.environment !== 'simulation')
      problem(response, 404, 'Not Found', 'Fiscal document not found')
    else json(response, 200, found)
    return
  }

  const timeline = /^\/documents\/([0-9a-f-]{36})\/transitions$/.exec(url.pathname)
  if (request.method === 'GET' && timeline?.[1]) {
    const found = await dependencies.documents.timeline(principal.tenantId, timeline[1])
    if (!found) problem(response, 404, 'Not Found', 'Fiscal document not found')
    else json(response, 200, found)
    return
  }

  const calculation = /^\/documents\/([0-9a-f-]{36})\/calculation(\/explanation)?$/.exec(
    url.pathname,
  )
  if (request.method === 'GET' && calculation?.[1]) {
    const found = await dependencies.calculations.get(principal.tenantId, calculation[1])
    response.setHeader('cache-control', 'private, no-store')
    if (!found) problem(response, 404, 'Not Found', 'Fiscal calculation not found')
    else if (calculation[2])
      json(response, 200, {
        documentId: calculation[1],
        inputDigest: found.inputDigest,
        rulesDigest: found.rulesDigest,
        resultDigest: found.resultDigest,
        explanation: found.explanation,
        sources: [
          ...new Map(
            found.lines
              .flatMap((line) => [...line.components.legacy, ...line.components.ibsCbs])
              .map((component) => [component.source.digest, component.source]),
          ).values(),
        ],
      })
    else json(response, 200, found)
    return
  }

  const readiness = /^\/documents\/([0-9a-f-]{36})\/validate$/.exec(url.pathname)
  if (request.method === 'POST' && readiness?.[1]) {
    if (!requirePermission(principal, 'transmission:submit', response)) return
    try {
      const result = await dependencies.readiness.validate({
        tenantId: principal.tenantId,
        documentId: readiness[1],
        actorId: principal.subject,
      })
      if (result.supported) {
        const document = await dependencies.documents.get(principal.tenantId, readiness[1])
        if (!document) throw new Error('Fiscal document not found')
        json(response, 200, {
          document,
          inputDigest: result.inputDigest,
          rulesDigest: result.rulesDigest,
          resultDigest: result.resultDigest,
          reconciliationDigest: result.reconciliationDigest,
        })
      } else fiscalProblem(response, 422, result)
    } catch (error) {
      if (error instanceof Error && error.message === 'Fiscal document not found')
        problem(response, 404, 'Not Found', error.message)
      else if (error instanceof ConsumerNotEligible)
        lifecycleProblem(response, 422, error.code, error.message)
      else if (error instanceof Error && error.message === 'Fiscal capability is unsupported')
        lifecycleProblem(response, 409, 'CAPABILITY_UNSUPPORTED', error.message)
      else if (error instanceof Error && error.message.includes('does not reconcile'))
        lifecycleProblem(response, 409, 'CALCULATION_MISMATCH', error.message)
      else if (error instanceof Error && error.message.includes('projection is unavailable'))
        lifecycleProblem(response, 409, 'DOCUMENT_NOT_READY', error.message)
      else if (error instanceof Error && error.message === 'Fiscal document is not a draft')
        lifecycleProblem(response, 409, 'INVALID_STATE_TRANSITION', error.message)
      else throw error
    }
    return
  }

  const issuance = /^\/documents\/([0-9a-f-]{36})\/issue$/.exec(url.pathname)
  if (request.method === 'POST' && issuance?.[1] && dependencies.issuance) {
    if (!requirePermission(principal, 'transmission:submit', response)) return
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || key.length < 16 || key.length > 128) {
      problem(response, 400, 'Bad Request', 'Idempotency-Key must have 16 to 128 characters')
      return
    }
    try {
      const result = await dependencies.issuance.issue({
        tenantId: principal.tenantId,
        documentId: issuance[1],
        idempotencyKey: key,
        actorId: principal.subject,
      })
      json(response, 202, {
        commandId: result.commandId,
        documentId: result.documentId,
        status: 'queued',
        statusUrl: `/fiscal/documents/${result.documentId}`,
        simulated: true,
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'Fiscal document not found')
        problem(response, 404, 'Not Found', error.message)
      else if (error instanceof Error && error.message === 'Fiscal document is not ready')
        lifecycleProblem(response, 409, 'DOCUMENT_NOT_READY', error.message)
      else if (error instanceof ReadinessStale)
        lifecycleProblem(response, 409, error.code, error.message)
      else if (error instanceof Error && error.message.includes('capability'))
        lifecycleProblem(response, 409, 'CAPABILITY_UNSUPPORTED', error.message)
      else if (error instanceof Error && error.message.startsWith('Conflicting'))
        problem(response, 409, 'Conflict', error.message)
      else throw error
    }
    return
  }

  const statusQuery = /^\/documents\/([0-9a-f-]{36})\/status-queries$/.exec(url.pathname)
  if (request.method === 'POST' && statusQuery?.[1] && dependencies.dispatch) {
    if (!requirePermission(principal, 'transmission:submit', response)) return
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || key.length < 16 || key.length > 128) {
      problem(response, 400, 'Bad Request', 'Idempotency-Key must have 16 to 128 characters')
      return
    }
    try {
      const result = await dependencies.dispatch.queueStatusQuery({
        tenantId: principal.tenantId,
        documentId: statusQuery[1],
        idempotencyKey: key,
        actorId: principal.subject,
        requestDigest: canonicalDigest({ documentId: statusQuery[1], command: 'status_query' }),
      })
      json(response, 202, {
        commandId: result.commandId,
        documentId: result.documentId,
        status: 'queued',
        statusUrl: `/fiscal/documents/${result.documentId}`,
        simulated: true,
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'Fiscal document not found')
        problem(response, 404, 'Not Found', error.message)
      else if (error instanceof Error && error.message.startsWith('Conflicting'))
        problem(response, 409, 'Conflict', error.message)
      else if (error instanceof Error && error.message.includes('not consultable'))
        lifecycleProblem(response, 409, 'INVALID_STATE_TRANSITION', error.message)
      else throw error
    }
    return
  }

  const cancellationQuery = /^\/documents\/([0-9a-f-]{36})\/cancellation-queries$/.exec(
    url.pathname,
  )
  if (
    request.method === 'POST' &&
    cancellationQuery?.[1] &&
    dependencies.dispatch &&
    dependencies.cancellation
  ) {
    if (!requirePermission(principal, 'cancellation:request', response)) return
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || key.length < 16 || key.length > 128) {
      problem(response, 400, 'Bad Request', 'Idempotency-Key must have 16 to 128 characters')
      return
    }
    try {
      const result = await dependencies.dispatch.queueCancellationQuery({
        tenantId: principal.tenantId,
        documentId: cancellationQuery[1],
        idempotencyKey: key,
        actorId: principal.subject,
        requestDigest: canonicalDigest({
          documentId: cancellationQuery[1],
          command: 'cancellation_query',
        }),
      })
      json(response, 202, {
        commandId: result.commandId,
        documentId: result.documentId,
        status: 'cancellation_pending',
        statusUrl: `/fiscal/documents/${result.documentId}`,
        simulated: true,
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'Fiscal document not found')
        problem(response, 404, 'Not Found', error.message)
      else if (error instanceof Error && error.message.startsWith('Conflicting'))
        problem(response, 409, 'Conflict', error.message)
      else if (error instanceof Error && error.message.includes('not consultable'))
        lifecycleProblem(response, 409, 'INVALID_STATE_TRANSITION', error.message)
      else throw error
    }
    return
  }

  const cancellationRequest = /^\/documents\/([0-9a-f-]{36})\/cancellation-requests$/.exec(
    url.pathname,
  )
  if (request.method === 'POST' && cancellationRequest?.[1] && dependencies.cancellation) {
    if (!requirePermission(principal, 'cancellation:request', response)) return
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || key.length < 16 || key.length > 128) {
      problem(response, 400, 'Bad Request', 'Idempotency-Key must have 16 to 128 characters')
      return
    }
    try {
      const body = z
        .strictObject({ reason: z.string().trim().min(15).max(255) })
        .parse(await readJson(request))
      const result = await dependencies.cancellation.request({
        tenantId: principal.tenantId,
        documentId: cancellationRequest[1],
        idempotencyKey: key,
        actorId: principal.subject,
        reason: body.reason,
      })
      json(response, 202, result)
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        problem(response, 422, 'Unprocessable Content', 'Invalid cancellation request')
      else if (error instanceof CancellationWindowElapsed)
        lifecycleProblem(response, 409, error.code, error.message)
      else if (error instanceof Error && error.message === 'Fiscal document not found')
        problem(response, 404, 'Not Found', error.message)
      else if (error instanceof Error && error.message.startsWith('Conflicting'))
        problem(response, 409, 'Conflict', error.message)
      else if (error instanceof Error && error.message.includes('capability'))
        lifecycleProblem(response, 409, 'CAPABILITY_UNSUPPORTED', error.message)
      else if (
        error instanceof Error &&
        (error.message.includes('not allowed') || error.message.includes('is blocked by'))
      )
        lifecycleProblem(response, 409, 'CANCELLATION_NOT_ALLOWED', error.message)
      else throw error
    }
    return
  }

  const correction = /^\/documents\/([0-9a-f-]{36})\/corrections$/.exec(url.pathname)
  if (request.method === 'POST' && correction?.[1]) {
    if (!requirePermission(principal, 'draft:create', response)) return
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || key.length < 16 || key.length > 128) {
      problem(response, 400, 'Bad Request', 'Idempotency-Key must have 16 to 128 characters')
      return
    }
    try {
      const body = fiscalCorrectionRequestSchema.parse(await readJson(request))
      const shared = {
        tenantId: principal.tenantId,
        documentId: correction[1],
        idempotencyKey: key,
        actorId: principal.subject,
        reason: body.reason,
      }
      const corrected = body.correctedOrigin
      const result =
        corrected.kind === 'sales'
          ? await dependencies.documents.createSuccessor({
              ...shared,
              correctedIntentId: corrected.intentId,
            })
          : corrected.kind === 'manual'
            ? await dependencies.documents.createManualSuccessor({
                ...shared,
                correctedManualOriginId: corrected.manualOriginId,
              })
            : await linkedSuccessor(dependencies, shared, corrected.linkedOriginId)
      json(response, result.existing ? 200 : 201, result)
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        problem(response, 400, 'Bad Request', 'Invalid Fiscal correction request')
      else if (error instanceof Error && error.message === 'Fiscal document not found')
        problem(response, 404, 'Not Found', error.message)
      else if (error instanceof Error && error.message.includes('origin snapshot unavailable'))
        problem(response, 404, 'Not Found', error.message)
      else if (error instanceof Error && error.message.startsWith('Conflicting'))
        problem(response, 409, 'Conflict', error.message)
      else if (error instanceof Error && error.message.includes('rejected Fiscal document'))
        lifecycleProblem(response, 409, 'INVALID_STATE_TRANSITION', error.message)
      else if (
        error instanceof Error &&
        /(manual|linked|Sales) correction requires/.test(error.message)
      )
        lifecycleProblem(response, 409, 'INVALID_STATE_TRANSITION', error.message)
      else throw error
    }
    return
  }

  if (
    request.method === 'POST' &&
    /^\/documents\/[0-9a-f-]{36}\/(issue|cancellation-requests|cancellation-queries)$/.test(
      url.pathname,
    )
  ) {
    const permission: FiscalPermission = url.pathname.includes('/cancellation-')
      ? 'cancellation:request'
      : 'transmission:submit'
    if (!requirePermission(principal, permission, response)) return
    problem(response, 409, 'Conflict', 'No Fiscal authority capability is enabled')
    return
  }
  problem(response, 404, 'Not Found', 'Fiscal route not found')
}

async function linkedSuccessor(
  dependencies: FiscalServerDependencies,
  shared: {
    tenantId: string
    documentId: string
    idempotencyKey: string
    actorId: string
    reason: string
  },
  linkedOriginId: string,
) {
  if (!dependencies.documents.createLinkedSuccessor)
    throw new Error('Fiscal linked correction requires the linked document flow')
  return dependencies.documents.createLinkedSuccessor({
    ...shared,
    expectedLinkedOriginId: linkedOriginId,
  })
}

function lifecycleProblem(
  response: ServerResponse,
  status: number,
  code: string,
  detail: string,
): void {
  response.writeHead(status, { 'content-type': 'application/problem+json; charset=utf-8' })
  response.end(
    JSON.stringify({
      type: `https://horizon.dev/problems/fiscal/${code.toLowerCase().replaceAll('_', '-')}`,
      title: 'Fiscal lifecycle command failed',
      status,
      code,
      detail,
    }),
  )
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 1024 * 1024) throw new SyntaxError('Fiscal request body is too large')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function requirePermission(
  principal: FiscalPrincipal,
  permission: FiscalPermission,
  response: ServerResponse,
): boolean {
  if (may(principal, permission)) return true
  problem(response, 403, 'Forbidden', 'Fiscal role does not permit this operation')
  return false
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function problem(response: ServerResponse, status: number, title: string, detail: string): void {
  if (response.headersSent) return
  response.writeHead(status, { 'content-type': 'application/problem+json; charset=utf-8' })
  response.end(JSON.stringify({ type: 'about:blank', title, status, detail }))
}

function fiscalProblem(
  response: ServerResponse,
  status: number,
  outcome: Extract<Awaited<ReturnType<FiscalCalculations['preview']>>, { supported: false }>,
): void {
  if (response.headersSent) return
  response.writeHead(status, { 'content-type': 'application/problem+json; charset=utf-8' })
  response.end(
    JSON.stringify({
      type: `https://horizon.dev/problems/fiscal/${outcome.code.toLowerCase().replaceAll('_', '-')}`,
      title: 'Fiscal calculation is not supported',
      status,
      ...outcome,
    }),
  )
}
