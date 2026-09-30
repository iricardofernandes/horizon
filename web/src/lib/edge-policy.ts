/**
 * What every web response carries, and which requests the web refuses before any route runs
 * (Phase 80). `src/proxy.ts` applies it; this module only decides.
 */

export interface PolicyContext {
  /** Fresh for every request; Next puts it on its own scripts. */
  readonly nonce: string
  /** Development needs `eval` for React's error overlay; production never does. */
  readonly development: boolean
  /** Served over HTTPS (`HORIZON_COOKIE_SECURE`): adds HSTS and upgrades subresources. */
  readonly https: boolean
  /** Where the browser sends its traces, when anywhere (`http://localhost:4318` locally). */
  readonly telemetryOrigin: string | null
}

export function contentSecurityPolicy(context: PolicyContext): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${context.nonce}' 'strict-dynamic'${context.development ? " 'unsafe-eval'" : ''}`,
    // Style sheets are files; React and Radix set `style` attributes, which carry no nonce.
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src 'self'${context.telemetryOrigin ? ` ${context.telemetryOrigin}` : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(context.https ? ['upgrade-insecure-requests'] : []),
  ]
  return directives.join('; ')
}

/** Headers every response carries, pages and files alike; fixed when the image is built. */
export function securityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  }
}

/** Sent on pages when served over HTTPS, which is known only when the server runs. */
export const STRICT_TRANSPORT_SECURITY = 'max-age=63072000; includeSubDomains'

/** The origin the browser's traces go to, from the configured endpoint or the local default. */
export function telemetryOriginOf(
  configured: string | undefined,
  host: string | null,
): string | null {
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      return null
    }
  }
  // The browser falls back to the local collector when served from localhost.
  return host?.split(':')[0] === 'localhost' ? 'http://localhost:4318' : null
}

export interface WriteRequest {
  readonly method: string
  readonly pathname: string
  readonly secFetchSite: string | null
  readonly origin: string | null
  readonly host: string | null
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * A write to the web's own API that another site started. Cookies are `SameSite=Lax`,
 * which already keeps them off most cross-site writes; this refuses the rest. A request
 * without `Sec-Fetch-Site` or `Origin` did not come from a browser, so it is no forgery.
 */
export function isCrossSiteWrite(request: WriteRequest): boolean {
  if (READS.has(request.method.toUpperCase())) return false
  if (!request.pathname.startsWith('/api/')) return false
  if (request.secFetchSite)
    return request.secFetchSite !== 'same-origin' && request.secFetchSite !== 'none'
  if (!request.origin) return false
  try {
    return new URL(request.origin).host !== request.host
  } catch {
    return true
  }
}
