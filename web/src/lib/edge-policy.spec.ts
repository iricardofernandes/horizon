import { describe, expect, it } from 'vitest'
import {
  contentSecurityPolicy,
  isCrossSiteWrite,
  STRICT_TRANSPORT_SECURITY,
  securityHeaders,
  telemetryOriginOf,
} from './edge-policy'

const local = { nonce: 'bm9uY2U=', development: false, https: false, telemetryOrigin: null }

describe('the content security policy', () => {
  it('runs only this server’s scripts carrying the request’s nonce, and no eval', () => {
    const policy = contentSecurityPolicy(local)
    expect(policy).toContain("script-src 'self' 'nonce-bm9uY2U=' 'strict-dynamic'")
    expect(policy).not.toContain('unsafe-eval')
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/)
  })

  it('cannot be framed, and has no plugins or foreign form targets', () => {
    const policy = contentSecurityPolicy(local)
    for (const directive of ["frame-ancestors 'none'", "object-src 'none'", "form-action 'self'"])
      expect(policy).toContain(directive)
  })

  it('allows eval only in development, and upgrades requests only over HTTPS', () => {
    expect(contentSecurityPolicy({ ...local, development: true })).toContain("'unsafe-eval'")
    expect(contentSecurityPolicy(local)).not.toContain('upgrade-insecure-requests')
    expect(contentSecurityPolicy({ ...local, https: true })).toContain('upgrade-insecure-requests')
  })

  it('lets the browser send traces to the collector, and nowhere else', () => {
    const policy = contentSecurityPolicy({ ...local, telemetryOrigin: 'http://localhost:4318' })
    expect(policy).toContain("connect-src 'self' http://localhost:4318")
  })
})

describe('the headers every response carries', () => {
  it('forbid sniffing and framing, and trim the referrer', () => {
    expect(securityHeaders()).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    })
  })

  it('pin HTTPS for two years, subdomains included', () => {
    expect(STRICT_TRANSPORT_SECURITY).toBe('max-age=63072000; includeSubDomains')
  })
})

describe('the telemetry origin', () => {
  it('comes from the configured endpoint, or the local collector on localhost', () => {
    expect(telemetryOriginOf('https://otel.example.com/x', 'erp.example.com')).toBe(
      'https://otel.example.com',
    )
    expect(telemetryOriginOf(undefined, 'localhost:3000')).toBe('http://localhost:4318')
    expect(telemetryOriginOf(undefined, 'erp.example.com')).toBeNull()
    expect(telemetryOriginOf('not a url', 'localhost:3000')).toBeNull()
  })
})

describe('a write another site started', () => {
  const write = {
    method: 'POST',
    pathname: '/api/horizon/sales/orders',
    secFetchSite: 'same-origin',
    origin: 'http://localhost:3000',
    host: 'localhost:3000',
  }

  it('is refused when the browser says it is cross-site', () => {
    expect(isCrossSiteWrite({ ...write, secFetchSite: 'cross-site' })).toBe(true)
    expect(isCrossSiteWrite({ ...write, secFetchSite: 'same-site' })).toBe(true)
    expect(isCrossSiteWrite(write)).toBe(false)
    expect(isCrossSiteWrite({ ...write, secFetchSite: 'none' })).toBe(false)
  })

  it('falls back to Origin when the browser sends no Sec-Fetch-Site', () => {
    const older = { ...write, secFetchSite: null }
    expect(isCrossSiteWrite({ ...older, origin: 'https://evil.example' })).toBe(true)
    expect(isCrossSiteWrite({ ...older, origin: 'null' })).toBe(true)
    expect(isCrossSiteWrite(older)).toBe(false)
  })

  it('leaves reads, pages, and callers that are not browsers alone', () => {
    expect(isCrossSiteWrite({ ...write, method: 'GET', secFetchSite: 'cross-site' })).toBe(false)
    expect(isCrossSiteWrite({ ...write, pathname: '/login', secFetchSite: 'cross-site' })).toBe(
      false,
    )
    expect(isCrossSiteWrite({ ...write, secFetchSite: null, origin: null })).toBe(false)
  })
})
