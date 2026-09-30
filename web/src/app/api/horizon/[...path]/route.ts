import { type NextRequest, NextResponse } from 'next/server'
import { hostedDemoEnabled, hostedDemoResponse } from '@/lib/hosted-demo'
import { askUntilReady, mayAskAgain } from '@/lib/not-ready'
import { authenticatedFetch } from '@/lib/session'
import { buildUpstreamPath } from '@/lib/upstream-path'

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params
  const pathname = buildUpstreamPath(path, request.nextUrl.search)
  if (!pathname) return NextResponse.json({ message: 'Unknown API route.' }, { status: 404 })
  if (hostedDemoEnabled()) return hostedDemoResponse(pathname)
  const headers = new Headers()
  for (const name of ['content-type', 'idempotency-key', 'traceparent', 'tracestate']) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  const hasBody = !['GET', 'HEAD'].includes(request.method)
  const body = hasBody ? await request.arrayBuffer() : undefined
  const send = () =>
    authenticatedFetch(pathname, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
    })
  // A module that has not provisioned a new workspace yet asks for a moment (Phase 80).
  const response = mayAskAgain(request.method, headers) ? await askUntilReady(send) : await send()
  const responseHeaders = new Headers()
  // Artifact downloads keep their file name and digest so a reader can verify the bytes.
  for (const name of [
    'content-type',
    'x-request-id',
    'content-disposition',
    'digest',
    'retry-after',
  ]) {
    const value = response.headers.get(name)
    if (value) responseHeaders.set(name, value)
  }
  return new NextResponse(response.status === 204 ? null : await response.arrayBuffer(), {
    status: response.status,
    headers: responseHeaders,
  })
}

export const GET = proxy
export const POST = proxy
export const PUT = proxy
export const PATCH = proxy
export const DELETE = proxy
