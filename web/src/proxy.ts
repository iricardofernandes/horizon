import { type NextRequest, NextResponse } from 'next/server'
import {
  contentSecurityPolicy,
  isCrossSiteWrite,
  STRICT_TRANSPORT_SECURITY,
  telemetryOriginOf,
} from '@/lib/edge-policy'

/**
 * Before any route (Phase 80): refuse a write another site started, and give every page a
 * content security policy with a fresh nonce, which Next puts on its own scripts.
 */
export function proxy(request: NextRequest) {
  if (
    isCrossSiteWrite({
      method: request.method,
      pathname: request.nextUrl.pathname,
      secFetchSite: request.headers.get('sec-fetch-site'),
      origin: request.headers.get('origin'),
      host: request.headers.get('host'),
    })
  )
    return NextResponse.json({ message: 'Cross-site request refused.' }, { status: 403 })

  const https = process.env.HORIZON_COOKIE_SECURE === 'true'
  const policy = contentSecurityPolicy({
    nonce: Buffer.from(crypto.randomUUID()).toString('base64'),
    development: process.env.NODE_ENV === 'development',
    https,
    telemetryOrigin: telemetryOriginOf(
      process.env.NEXT_PUBLIC_OTEL_EXPORTER_OTLP_ENDPOINT,
      request.headers.get('host'),
    ),
  })
  const headers = new Headers(request.headers)
  headers.set('content-security-policy', policy)
  const response = NextResponse.next({ request: { headers } })
  response.headers.set('content-security-policy', policy)
  if (https) response.headers.set('strict-transport-security', STRICT_TRANSPORT_SECURITY)
  return response
}

export const config = {
  // Built files carry no page and take no writes.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
