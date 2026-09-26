import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  fiscalInboundConflictDismissalRequestSchema,
  fiscalInboundImportStatusSchema,
  fiscalInboundReconciliationRequestSchema,
} from '@horizon/contracts'
import { z } from 'zod'
import type { FiscalPrincipal } from './auth'
import { may } from './auth'
import type { FiscalInboundImports } from './inbound-imports'
import {
  type FiscalInboundReconciliations,
  InboundReconciliationError,
} from './inbound-reconciliations'
import { INBOUND_XML_LIMIT, InboundRejection } from './nfe55/inbound'

export type InboundDependencies = {
  imports: Pick<FiscalInboundImports, 'import' | 'list' | 'get' | 'xml' | 'dismissConflict'>
  reconciliations: Pick<FiscalInboundReconciliations, 'reconcile'>
}

const PROBLEM_BASE = 'https://horizon.dev/problems/fiscal/inbound/'

/** Supplier NF-e routes; returns false when the path is not an inbound route. */
export async function handleInboundRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  principal: FiscalPrincipal,
  inbound: InboundDependencies,
): Promise<boolean> {
  const item = /^\/imports\/([0-9a-f-]{36})(\/xml|\/reconciliation|\/conflict-dismissals)?$/.exec(
    url.pathname,
  )
  if (url.pathname !== '/imports' && !item) return false
  response.setHeader('cache-control', 'private, no-store')
  if (!may(principal, 'import:review')) {
    problem(response, 403, 'Forbidden', 'Fiscal role does not permit this operation')
    return true
  }
  const tenantId = principal.tenantId

  if (url.pathname === '/imports' && request.method === 'POST') {
    await createImport(request, response, principal, inbound)
    return true
  }
  if (url.pathname === '/imports' && request.method === 'GET') {
    try {
      const query = z
        .strictObject({
          status: fiscalInboundImportStatusSchema.optional(),
          cursor: z.string().min(1).max(512).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        })
        .parse(Object.fromEntries(url.searchParams))
      json(response, 200, await inbound.imports.list(tenantId, compact(query)))
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        problem(response, 400, 'Bad Request', 'Invalid Fiscal import list query')
      else throw error
    }
    return true
  }

  const importId = item?.[1] as string
  const suffix = item?.[2]
  if (!suffix && request.method === 'GET') {
    const found = await inbound.imports.get(tenantId, importId)
    if (found) json(response, 200, found)
    else problem(response, 404, 'Not Found', 'Supplier NF-e import not found')
    return true
  }
  if (suffix === '/xml' && request.method === 'GET') {
    const found = await inbound.imports.xml(tenantId, importId)
    if (!found) {
      problem(response, 404, 'Not Found', 'Supplier NF-e import not found')
      return true
    }
    response.writeHead(200, {
      'content-type': 'application/xml; charset=utf-8',
      'content-length': found.bytes.length,
      digest: `sha-256=${Buffer.from(found.digest, 'hex').toString('base64')}`,
      'content-disposition': `attachment; filename="nfe-entrada-${importId}.xml"`,
      'x-content-type-options': 'nosniff',
    })
    response.end(found.bytes)
    return true
  }
  if (suffix === '/conflict-dismissals' && request.method === 'POST') {
    try {
      const body = fiscalInboundConflictDismissalRequestSchema.parse(await readJson(request))
      const outcome = await inbound.imports.dismissConflict({
        tenantId,
        importId,
        conflictId: body.conflictId,
        reason: body.reason,
        actorId: principal.subject,
      })
      json(response, outcome === 'dismissed' ? 201 : 200, { conflictId: body.conflictId, outcome })
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        problem(response, 400, 'Bad Request', 'Invalid conflict dismissal')
      else if (error instanceof Error && error.message.endsWith('not found'))
        problem(response, 404, 'Not Found', error.message)
      else throw error
    }
    return true
  }
  if (suffix === '/reconciliation' && request.method === 'POST') {
    await reconcile(request, response, principal, importId, inbound)
    return true
  }
  problem(response, 405, 'Method Not Allowed', 'Fiscal import route does not accept this method')
  return true
}

async function createImport(
  request: IncomingMessage,
  response: ServerResponse,
  principal: FiscalPrincipal,
  inbound: InboundDependencies,
): Promise<void> {
  const type = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
  if (type !== 'application/xml' && type !== 'text/xml') {
    problem(
      response,
      415,
      'Unsupported Media Type',
      'Supplier NF-e must be sent as application/xml',
    )
    return
  }
  const declared = Number(request.headers['content-length'] ?? 0)
  if (declared > INBOUND_XML_LIMIT) {
    tooLarge(response)
    return
  }
  const xml = await readBounded(request)
  if (!xml) {
    tooLarge(response)
    return
  }
  try {
    const outcome = await inbound.imports.import({
      tenantId: principal.tenantId,
      xml,
      actorId: principal.subject,
    })
    if (outcome.outcome === 'conflict') {
      inboundProblem(
        response,
        409,
        'CONFLICTING_DUPLICATE',
        'Another signed NF-e with this access key was already imported; this copy is kept and blocks reconciliation until reviewed',
        { importId: outcome.importId, conflictId: outcome.conflictId },
      )
      return
    }
    json(response, outcome.outcome === 'created' ? 201 : 200, outcome)
  } catch (error) {
    if (error instanceof InboundRejection)
      inboundProblem(
        response,
        error.code === 'XML_TOO_LARGE' ? 413 : 422,
        error.code,
        error.message,
      )
    else throw error
  }
}

async function reconcile(
  request: IncomingMessage,
  response: ServerResponse,
  principal: FiscalPrincipal,
  importId: string,
  inbound: InboundDependencies,
): Promise<void> {
  const key = request.headers['idempotency-key']
  if (typeof key !== 'string' || key.length < 16 || key.length > 128) {
    problem(response, 400, 'Bad Request', 'Idempotency-Key must have 16 to 128 characters')
    return
  }
  try {
    const body = fiscalInboundReconciliationRequestSchema.parse(await readJson(request))
    const { reconciliation, replayed } = await inbound.reconciliations.reconcile({
      tenantId: principal.tenantId,
      importId,
      request: compact(body),
      idempotencyKey: key,
      actorId: principal.subject,
    })
    json(response, replayed ? 200 : 201, reconciliation)
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      problem(response, 400, 'Bad Request', 'Invalid supplier NF-e reconciliation')
    else if (error instanceof InboundReconciliationError) {
      const status =
        error.code === 'NOT_FOUND'
          ? 404
          : error.code === 'ALLOCATION_INVALID' || error.code === 'NO_RECEIPT'
            ? 422
            : 409
      inboundProblem(
        response,
        status,
        error.code,
        error.message,
        error.comparison ? { comparison: error.comparison } : {},
      )
    } else throw error
  }
}

/** Streams the body and stops reading once it passes the limit. */
async function readBounded(request: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > INBOUND_XML_LIMIT) {
      request.resume()
      return null
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const bytes = await readBounded(request)
  if (!bytes) throw new SyntaxError('Fiscal request body is too large')
  return JSON.parse(bytes.toString('utf8'))
}

/** Drops undefined members so optional contract fields fit exact optional types. */
function compact<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>
  }
}

function tooLarge(response: ServerResponse): void {
  response.setHeader('connection', 'close')
  inboundProblem(response, 413, 'XML_TOO_LARGE', 'Supplier NF-e XML must not exceed 1 MiB')
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

function inboundProblem(
  response: ServerResponse,
  status: number,
  code: string,
  detail: string,
  extra: Record<string, unknown> = {},
): void {
  if (response.headersSent) return
  response.writeHead(status, { 'content-type': 'application/problem+json; charset=utf-8' })
  response.end(
    JSON.stringify({
      type: `${PROBLEM_BASE}${code.toLowerCase().replaceAll('_', '-')}`,
      title: 'Supplier NF-e was not accepted',
      status,
      code,
      detail,
      ...extra,
    }),
  )
}
