import { type NextRequest, NextResponse } from 'next/server'
import { hostedDemoEnabled, hostedDemoResponse } from '@/lib/hosted-demo'
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
  const response = await authenticatedFetch(pathname, {
    method: request.method,
    headers,
    ...(hasBody ? { body: await request.arrayBuffer() } : {}),
  })
  const responseHeaders = new Headers()
  for (const name of ['content-type', 'x-request-id']) {
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
