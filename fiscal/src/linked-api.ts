import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  fiscalCorrectionLetterRequestSchema,
  fiscalDocumentKindCatalogueSchema,
  fiscalLinkedOriginRequestSchema,
} from '@horizon/contracts'
import { z } from 'zod'
import type { FiscalPermission, FiscalPrincipal } from './auth'
import { may } from './auth'
import { CorrectionLetterError, type FiscalCorrectionLetters } from './correction-letters'
import { DOCUMENT_KINDS, EVENT_FLOWS } from './document-kinds'
import type { FiscalDocumentLinksReader } from './document-links'
import { type FiscalLinkedOrigins, LinkedOriginError } from './linked-origins'

export type LinkedDependencies = {
  origins: Pick<FiscalLinkedOrigins, 'create'>
  links: Pick<FiscalDocumentLinksReader, 'read'>
  correctionLetters?: Pick<FiscalCorrectionLetters, 'request' | 'list'>
}

const PROBLEM_BASE = 'https://horizon.dev/problems/fiscal/linked/'

/** Returns, complements and correction letters; false when the path is not one of them. */
export async function handleLinkedRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  principal: FiscalPrincipal,
  linked: LinkedDependencies,
): Promise<boolean> {
  const tenantId = principal.tenantId
  if (url.pathname === '/document-kinds' && request.method === 'GET') {
    json(
      response,
      200,
      fiscalDocumentKindCatalogueSchema.parse({ kinds: DOCUMENT_KINDS, eventFlows: EVENT_FLOWS }),
    )
    return true
  }
  if (url.pathname === '/linked-origins' && request.method === 'POST') {
    if (!allowed(principal, 'draft:create', response)) return true
    const key = idempotencyKey(request, response)
    if (!key) return true
    try {
      const body = fiscalLinkedOriginRequestSchema.parse(await readJson(request))
      const created = await linked.origins.create({
        tenantId,
        idempotencyKey: key,
        actorId: principal.subject,
        request: body,
      })
      json(response, created.existing ? 200 : 201, created)
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        problem(response, 400, 'Bad Request', 'Invalid linked origin request')
      else if (error instanceof LinkedOriginError)
        coded(
          response,
          error.code === 'LINKED_ORIGIN_CONFLICT' ? 409 : 422,
          error.code,
          error.message,
        )
      else throw error
    }
    return true
  }
  const links = /^\/documents\/([0-9a-f-]{36})\/links$/.exec(url.pathname)
  if (links?.[1] && request.method === 'GET') {
    response.setHeader('cache-control', 'private, no-store')
    const found = await linked.links.read(tenantId, links[1])
    if (found) json(response, 200, found)
    else problem(response, 404, 'Not Found', 'Fiscal document not found')
    return true
  }
  const letters = /^\/documents\/([0-9a-f-]{36})\/correction-letters$/.exec(url.pathname)
  if (!letters?.[1]) return false
  const documentId = letters[1]
  if (!linked.correctionLetters) {
    problem(response, 409, 'Conflict', 'The correction letter flow is not configured')
    return true
  }
  if (request.method === 'GET') {
    response.setHeader('cache-control', 'private, no-store')
    const found = await linked.correctionLetters.list(tenantId, documentId)
    if (found) json(response, 200, found)
    else problem(response, 404, 'Not Found', 'Fiscal document not found')
    return true
  }
  if (request.method !== 'POST') return false
  if (!allowed(principal, 'cancellation:request', response)) return true
  const key = idempotencyKey(request, response)
  if (!key) return true
  try {
    const body = fiscalCorrectionLetterRequestSchema.parse(await readJson(request))
    const queued = await linked.correctionLetters.request({
      tenantId,
      documentId,
      idempotencyKey: key,
      actorId: principal.subject,
      ...body,
    })
    json(response, 202, {
      ...queued,
      documentId,
      statusUrl: `/fiscal/documents/${documentId}/correction-letters`,
      simulated: true,
    })
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      problem(response, 422, 'Unprocessable Content', 'Invalid correction letter request')
    else if (error instanceof Error && error.message === 'Fiscal document not found')
      problem(response, 404, 'Not Found', error.message)
    else if (error instanceof CorrectionLetterError)
      coded(
        response,
        409,
        error.message.startsWith('Conflicting') ? 'IDEMPOTENCY_CONFLICT' : 'CORRECTION_NOT_ALLOWED',
        error.message,
      )
    else throw error
  }
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
    if (size > 256 * 1024) throw new SyntaxError('Fiscal request body is too large')
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
      title: 'Fiscal linked document command failed',
      status,
      code,
      detail,
    }),
  )
}
