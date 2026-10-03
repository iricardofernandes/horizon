import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  businessDayOf,
  fiscalNfseRegistryReviewRequestSchema,
  fiscalNfseRegistryVersionRequestSchema,
  fiscalServiceCancellationRequestSchema,
  fiscalServiceDocumentCreateRequestSchema,
  fiscalServiceIntakeListSchema,
  fiscalServiceIntakeStatusSchema,
  fiscalServiceIssuancePolicyRequestSchema,
  fiscalServiceOriginRequestSchema,
  fiscalServiceProfileListSchema,
  fiscalServiceProfileRequestSchema,
  fiscalServiceSubstitutionRequestSchema,
} from '@horizon/contracts'
import { z } from 'zod'
import type { FiscalPermission, FiscalPrincipal } from '../auth'
import { may } from '../auth'
import { canonicalDigest } from '../canonical-json'
import type { FiscalDispatch } from '../dispatch'
import type { FiscalServiceCancellation } from './cancellation'
import type { FiscalServiceDocuments } from './documents'
import {
  MunicipalityUnsupported,
  ServiceCancellationWindowElapsed,
  ServiceProfileMissing,
  SourceKeyConflict,
  SubstitutionNotAllowed,
} from './errors'
import type { FiscalServiceIntakes } from './intake'
import type { FiscalServiceIssuance } from './issuance'
import type { FiscalServiceIssuancePolicies } from './issuance-policies'
import type { FiscalServiceReadiness } from './readiness'
import type { FiscalNfseRegistry } from './registry'
import type { FiscalServiceOrigins } from './service-origins'
import type { FiscalServiceProfiles } from './service-profiles'
import type { FiscalServiceSubstitutions } from './substitution'

const COMPETENCE = /^\d{4}-(0[1-9]|1[0-2])$/

export type ServiceDependencies = {
  profiles: Pick<FiscalServiceProfiles, 'create' | 'list'>
  registry: Pick<FiscalNfseRegistry, 'importVersion' | 'review' | 'resolve'>
  origins: Pick<FiscalServiceOrigins, 'create'>
  documents: Pick<FiscalServiceDocuments, 'createDraft' | 'get'>
  readiness: Pick<FiscalServiceReadiness, 'validate'>
  policies: Pick<FiscalServiceIssuancePolicies, 'read' | 'set'>
  intakes?: Pick<FiscalServiceIntakes, 'list' | 'retry'>
  issuance?: Pick<FiscalServiceIssuance, 'issue'>
  cancellation?: Pick<FiscalServiceCancellation, 'request'>
  substitutions?: Pick<FiscalServiceSubstitutions, 'request'>
  dispatch?: Pick<FiscalDispatch, 'queueStatusQuery'>
}

const PROBLEM_BASE = 'https://horizon.dev/problems/fiscal/service/'

/** National NFS-e routes; false when the path is not one of them. */
export async function handleServiceRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  principal: FiscalPrincipal,
  service: ServiceDependencies,
): Promise<boolean> {
  const tenantId = principal.tenantId
  try {
    if (url.pathname === '/service-profiles' && request.method === 'POST') {
      if (!allowed(principal, 'rules:manage', response)) return true
      const body = fiscalServiceProfileRequestSchema.parse(await readJson(request))
      const saved = await service.profiles.create({
        tenantId,
        actorId: principal.subject,
        request: body,
      })
      json(response, saved.existing ? 200 : 201, saved)
      return true
    }
    const profileList = /^\/service-profiles\/([0-9a-f-]{36})$/.exec(url.pathname)
    if (profileList?.[1] && request.method === 'GET') {
      const itemId = profileList[1]
      json(
        response,
        200,
        fiscalServiceProfileListSchema.parse({
          itemId,
          revisions: await service.profiles.list(tenantId, itemId),
        }),
      )
      return true
    }
    if (url.pathname === '/nfse-registry/versions' && request.method === 'POST') {
      if (!allowed(principal, 'rules:manage', response)) return true
      const body = fiscalNfseRegistryVersionRequestSchema.parse(await readJson(request))
      const saved = await service.registry.importVersion({
        tenantId,
        actorId: principal.subject,
        request: body,
      })
      json(response, saved.existing ? 200 : 201, saved)
      return true
    }
    const review = /^\/nfse-registry\/versions\/([0-9a-f-]{36})\/review$/.exec(url.pathname)
    if (review?.[1] && request.method === 'POST') {
      if (!allowed(principal, 'rules:manage', response)) return true
      const body = fiscalNfseRegistryReviewRequestSchema.parse(await readJson(request))
      json(
        response,
        200,
        await service.registry.review({
          tenantId,
          versionId: review[1],
          actorId: principal.subject,
          interpretation: body.interpretation,
        }),
      )
      return true
    }
    const municipality = /^\/nfse-registry\/municipalities\/(\d{7})$/.exec(url.pathname)
    if (municipality?.[1] && request.method === 'GET') {
      const competenceDate = z.iso
        .date()
        .parse(url.searchParams.get('competenceDate') ?? businessDayOf(new Date()))
      json(response, 200, await service.registry.resolve(tenantId, municipality[1], competenceDate))
      return true
    }
    const policy = /^\/service-issuance-policies\/([0-9a-f-]{36})$/.exec(url.pathname)
    if (policy?.[1] && request.method === 'GET') {
      json(response, 200, await service.policies.read(tenantId, policy[1]))
      return true
    }
    if (policy?.[1] && request.method === 'PUT') {
      if (!allowed(principal, 'rules:manage', response)) return true
      const body = fiscalServiceIssuancePolicyRequestSchema.parse(await readJson(request))
      json(
        response,
        200,
        await service.policies.set({
          tenantId,
          establishmentId: policy[1],
          actorId: principal.subject,
          request: body,
        }),
      )
      return true
    }
    if (url.pathname === '/service-intakes' && request.method === 'GET') {
      if (!service.intakes) return unconfigured(response)
      const status = url.searchParams.get('status')
      const documentType = url.searchParams.get('documentType')
      const period = url.searchParams.get('period')
      json(
        response,
        200,
        fiscalServiceIntakeListSchema.parse({
          data: await service.intakes.list(tenantId, {
            status: status ? fiscalServiceIntakeStatusSchema.parse(status) : undefined,
            documentType: documentType
              ? z.enum(['service-delivery', 'contract-period']).parse(documentType)
              : undefined,
            period: period ? z.string().regex(COMPETENCE).parse(period) : undefined,
          }),
        }),
      )
      return true
    }
    const retry = /^\/service-intakes\/([0-9a-f-]{36})\/retry$/.exec(url.pathname)
    if (retry?.[1] && request.method === 'POST') {
      if (!allowed(principal, 'draft:create', response)) return true
      if (!service.intakes) return unconfigured(response)
      json(response, 200, await service.intakes.retry(tenantId, retry[1], principal.subject))
      return true
    }
    if (url.pathname === '/service-origins' && request.method === 'POST') {
      if (!allowed(principal, 'draft:create', response)) return true
      const key = idempotencyKey(request, response)
      if (!key) return true
      const body = fiscalServiceOriginRequestSchema.parse(await readJson(request))
      const created = await service.origins.create({
        tenantId,
        idempotencyKey: key,
        actorId: principal.subject,
        request: body,
      })
      json(response, created.existing ? 200 : 201, created)
      return true
    }
    if (url.pathname === '/service-documents' && request.method === 'POST') {
      if (!allowed(principal, 'draft:create', response)) return true
      const key = idempotencyKey(request, response)
      if (!key) return true
      const body = fiscalServiceDocumentCreateRequestSchema.parse(await readJson(request))
      const draft = await service.documents.createDraft({
        tenantId,
        serviceOriginId: body.serviceOriginId,
        establishmentId: body.establishmentId,
        series: body.series,
        idempotencyKey: key,
        actorId: principal.subject,
      })
      json(response, draft.existing ? 200 : 201, draft)
      return true
    }
    const route = /^\/service-documents\/([0-9a-f-]{36})(\/[a-z-]+)?$/.exec(url.pathname)
    if (!route?.[1]) return false
    return await documentRoute(request, response, principal, service, route[1], route[2] ?? '')
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      problem(response, 400, 'Bad Request', 'Invalid fiscal service request')
    else if (error instanceof Error && /not found$/.test(error.message))
      problem(response, 404, 'Not Found', error.message)
    else if (error instanceof MunicipalityUnsupported || error instanceof ServiceProfileMissing)
      coded(response, 409, error.code, error.message)
    else if (error instanceof SourceKeyConflict || error instanceof SubstitutionNotAllowed)
      coded(response, 409, error.code, error.message)
    else if (error instanceof ServiceCancellationWindowElapsed)
      coded(response, 409, error.code, error.message)
    else if (error instanceof Error && error.message.startsWith('Conflicting'))
      problem(response, 409, 'Conflict', error.message)
    else if (error instanceof Error && error.message.includes('capability'))
      coded(response, 409, 'CAPABILITY_UNSUPPORTED', error.message)
    else if (error instanceof Error && error.message.includes('does not reconcile'))
      coded(response, 409, 'CALCULATION_MISMATCH', error.message)
    else if (
      error instanceof Error &&
      /projection is unavailable|no longer effective|owner revisions/.test(error.message)
    )
      coded(response, 409, 'DOCUMENT_NOT_READY', error.message)
    else if (
      error instanceof Error &&
      /is not a draft|is not ready|not allowed|not consultable|blocked/.test(error.message)
    )
      coded(response, 409, 'INVALID_STATE_TRANSITION', error.message)
    else if (error instanceof Error && /competence|amount|recipient|Catalog/.test(error.message))
      problem(response, 422, 'Unprocessable Content', error.message)
    else throw error
    return true
  }
}

async function documentRoute(
  request: IncomingMessage,
  response: ServerResponse,
  principal: FiscalPrincipal,
  service: ServiceDependencies,
  documentId: string,
  action: string,
): Promise<boolean> {
  const tenantId = principal.tenantId
  if (action === '' && request.method === 'GET') {
    const found = await service.documents.get(tenantId, documentId)
    if (found) json(response, 200, found)
    else problem(response, 404, 'Not Found', 'Fiscal document not found')
    return true
  }
  if (request.method !== 'POST') return false
  if (action === '/validate') {
    if (!allowed(principal, 'transmission:submit', response)) return true
    const result = await service.readiness.validate({
      tenantId,
      documentId,
      actorId: principal.subject,
    })
    if (!result.supported) {
      response.writeHead(422, { 'content-type': 'application/problem+json; charset=utf-8' })
      response.end(
        JSON.stringify({
          type: `https://horizon.dev/problems/fiscal/${result.code.toLowerCase().replaceAll('_', '-')}`,
          title: 'Fiscal calculation is unsupported',
          status: 422,
          ...result,
        }),
      )
      return true
    }
    json(response, 200, {
      document: await service.documents.get(tenantId, documentId),
      inputDigest: result.inputDigest,
      rulesDigest: result.rulesDigest,
      resultDigest: result.resultDigest,
      reconciliationDigest: result.reconciliationDigest,
    })
    return true
  }
  const key = idempotencyKey(request, response)
  if (!key) return true
  if (action === '/issue') {
    if (!allowed(principal, 'transmission:submit', response)) return true
    if (!service.issuance) return unconfigured(response)
    const result = await service.issuance.issue({
      tenantId,
      documentId,
      idempotencyKey: key,
      actorId: principal.subject,
    })
    json(response, 202, { ...result, statusUrl: `/fiscal/service-documents/${documentId}` })
    return true
  }
  if (action === '/status-queries') {
    if (!allowed(principal, 'transmission:submit', response)) return true
    if (!service.dispatch) return unconfigured(response)
    const queued = await service.dispatch.queueStatusQuery({
      tenantId,
      documentId,
      idempotencyKey: key,
      requestDigest: canonicalDigest({ documentId, kind: 'nfse-status-query' }),
      actorId: principal.subject,
    })
    json(response, 202, { ...queued, statusUrl: `/fiscal/service-documents/${documentId}` })
    return true
  }
  if (action === '/cancellation-requests') {
    if (!allowed(principal, 'cancellation:request', response)) return true
    if (!service.cancellation) return unconfigured(response)
    const body = fiscalServiceCancellationRequestSchema.parse(await readJson(request))
    const queued = await service.cancellation.request({
      tenantId,
      documentId,
      idempotencyKey: key,
      actorId: principal.subject,
      ...body,
    })
    json(response, 202, queued)
    return true
  }
  if (action === '/substitutions') {
    if (!allowed(principal, 'cancellation:request', response)) return true
    if (!service.substitutions) return unconfigured(response)
    const body = fiscalServiceSubstitutionRequestSchema.parse(await readJson(request))
    const draft = await service.substitutions.request({
      tenantId,
      documentId,
      idempotencyKey: key,
      actorId: principal.subject,
      reasonCode: body.reasonCode,
      reason: body.reason ?? null,
      correctedServiceOriginId: body.correctedOrigin.serviceOriginId,
    })
    json(response, draft.existing ? 200 : 201, {
      ...draft,
      statusUrl: `/fiscal/service-documents/${draft.id}`,
    })
    return true
  }
  return false
}

function unconfigured(response: ServerResponse): true {
  coded(response, 409, 'CAPABILITY_UNSUPPORTED', 'The national NFS-e flow is not configured')
  return true
}

function allowed(
  principal: FiscalPrincipal,
  permission: FiscalPermission,
  response: ServerResponse,
): boolean {
  if (may(principal, permission)) return true
  problem(response, 403, 'Forbidden', 'Fiscal role does not permit this operation')
  return false
}

function idempotencyKey(request: IncomingMessage, response: ServerResponse): string | null {
  const key = request.headers['idempotency-key']
  if (typeof key === 'string' && key.length >= 16 && key.length <= 128) return key
  problem(response, 400, 'Bad Request', 'Idempotency-Key must have 16 to 128 characters')
  return null
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 2 * 1024 * 1024) throw new SyntaxError('Fiscal request body is too large')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
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

function coded(response: ServerResponse, status: number, code: string, detail: string): void {
  if (response.headersSent) return
  response.writeHead(status, { 'content-type': 'application/problem+json; charset=utf-8' })
  response.end(
    JSON.stringify({
      type: `${PROBLEM_BASE}${code.toLowerCase().replaceAll('_', '-')}`,
      title: 'Fiscal national NFS-e command failed',
      status,
      code,
      detail,
    }),
  )
}
