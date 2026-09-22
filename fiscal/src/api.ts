import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import type { FiscalArtifacts } from './artifacts'
import { type FiscalPermission, type FiscalPrincipal, type FiscalTokenVerifier, may } from './auth'
import type { FiscalCalculations } from './calculations'
import { canonicalDigest } from './canonical-json'
import type { FiscalCapabilities } from './capabilities'
import type { FiscalDispatch } from './dispatch'
import type { FiscalDocuments } from './documents'
import type { FiscalIssuance } from './issuance'
import type { FiscalReadiness } from './readiness'
import type { FiscalRuleStore } from './rule-store'

export function createFiscalServer(dependencies: {
  verifier: Pick<FiscalTokenVerifier, 'verify'>
  documents: Pick<FiscalDocuments, 'get' | 'createDraft' | 'createSuccessor'>
  dispatch?: Pick<FiscalDispatch, 'queueStatusQuery'>
  artifacts: Pick<FiscalArtifacts, 'get'>
  calculations: Pick<FiscalCalculations, 'preview' | 'get'>
  capabilities: Pick<FiscalCapabilities, 'listActive'>
  readiness: Pick<FiscalReadiness, 'validate'>
  issuance?: Pick<FiscalIssuance, 'issue'>
  rules: Pick<FiscalRuleStore, 'proposeOverride'>
}): Server {
  return createServer((request, response) => {
    void handle(request, response, dependencies).catch(() =>
      problem(response, 500, 'Internal Server Error', 'Fiscal request failed'),
    )
  })
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: {
    verifier: Pick<FiscalTokenVerifier, 'verify'>
    documents: Pick<FiscalDocuments, 'get' | 'createDraft' | 'createSuccessor'>
    dispatch?: Pick<FiscalDispatch, 'queueStatusQuery'>
    artifacts: Pick<FiscalArtifacts, 'get'>
    calculations: Pick<FiscalCalculations, 'preview' | 'get'>
    capabilities: Pick<FiscalCapabilities, 'listActive'>
    readiness: Pick<FiscalReadiness, 'validate'>
    issuance?: Pick<FiscalIssuance, 'issue'>
    rules: Pick<FiscalRuleStore, 'proposeOverride'>
  },
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
  if (!requirePermission(principal, 'read', response)) return

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

  if (request.method === 'POST' && url.pathname === '/documents') {
    if (!requirePermission(principal, 'draft:create', response)) return
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || key.length < 16 || key.length > 128) {
      problem(response, 400, 'Bad Request', 'Idempotency-Key must have 16 to 128 characters')
      return
    }
    const bodySchema = z.object({
      intentId: z.uuid(),
      model: z.enum(['55', '65', 'nfse']),
      environment: z.literal('simulation'),
      establishmentId: z.uuid(),
      series: z.int().min(0).max(999),
    })
    try {
      const body = bodySchema.parse(await readJson(request))
      const draft = await dependencies.documents.createDraft({
        ...body,
        tenantId: principal.tenantId,
        idempotencyKey: key,
        actorId: principal.subject,
      })
      json(response, 201, draft)
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        problem(response, 400, 'Bad Request', 'Invalid fiscal draft request')
      else if (error instanceof Error && error.message.startsWith('Conflicting fiscal'))
        problem(response, 409, 'Conflict', error.message)
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

  const artifact =
    /^\/documents\/([0-9a-f-]{36})\/artifacts\/(xml|response|protocol|pdf|unsigned_xml|signed_xml|issuance_request|issuance_response|authorization_protocol|cancellation_request|cancellation_response|cancellation_protocol|danfe)$/.exec(
      url.pathname,
    )
  if (request.method === 'GET' && artifact) {
    const documentId = artifact[1]
    const kind = artifact[2] as Parameters<FiscalArtifacts['get']>[2]
    const digest = url.searchParams.get('digest')
    if (!documentId || !digest) {
      problem(response, 400, 'Bad Request', 'A document and digest are required')
      return
    }
    try {
      const found = await dependencies.artifacts.get(principal.tenantId, documentId, kind, digest)
      response.writeHead(200, {
        'content-type': found.metadata.mediaType,
        'content-length': found.bytes.length,
        digest: `sha-256=${Buffer.from(found.metadata.digest, 'hex').toString('base64')}`,
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="${kind}-${digest}"`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'sandbox',
      })
      response.end(found.bytes)
    } catch {
      problem(response, 404, 'Not Found', 'Fiscal artifact not found')
    }
    return
  }

  const document = /^\/documents\/([0-9a-f-]{36})$/.exec(url.pathname)
  if (request.method === 'GET' && document?.[1]) {
    const found = await dependencies.documents.get(principal.tenantId, document[1])
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

  const correction = /^\/documents\/([0-9a-f-]{36})\/corrections$/.exec(url.pathname)
  if (request.method === 'POST' && correction?.[1]) {
    if (!requirePermission(principal, 'draft:create', response)) return
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || key.length < 16 || key.length > 128) {
      problem(response, 400, 'Bad Request', 'Idempotency-Key must have 16 to 128 characters')
      return
    }
    try {
      const body = z
        .strictObject({
          reason: z.string().trim().min(10).max(1000),
          correctedOrigin: z.strictObject({ kind: z.literal('sales'), intentId: z.uuid() }),
        })
        .parse(await readJson(request))
      const result = await dependencies.documents.createSuccessor({
        tenantId: principal.tenantId,
        documentId: correction[1],
        correctedIntentId: body.correctedOrigin.intentId,
        idempotencyKey: key,
        actorId: principal.subject,
        reason: body.reason,
      })
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
      else throw error
    }
    return
  }

  if (
    request.method === 'POST' &&
    /^\/documents\/[0-9a-f-]{36}\/(issue|cancellation-requests)$/.test(url.pathname)
  ) {
    const permission: FiscalPermission = url.pathname.endsWith('/cancellation-requests')
      ? 'cancellation:request'
      : 'transmission:submit'
    if (!requirePermission(principal, permission, response)) return
    problem(response, 409, 'Conflict', 'No Fiscal authority capability is enabled')
    return
  }
  problem(response, 404, 'Not Found', 'Fiscal route not found')
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
