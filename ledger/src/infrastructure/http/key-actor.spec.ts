import { describe, expect, it } from 'vitest'
import { actorOf, viaOf } from './authorization'

const principal = (claims: Record<string, unknown>) =>
  ({ headers: {}, principal: { tenantId: 't', roles: [], ...claims } }) as never

describe('who acts through a key (ADR 0066)', () => {
  it('counts a key token as its issuer, and keeps the key as the way it came', () => {
    const request = principal({ subject: 'api-key:key-1', keyIssuer: 'user-1', scopes: [] })
    expect(actorOf(request)).toBe('user-1')
    expect(viaOf(request)).toBe('api-key:key-1')
  })

  it('leaves a person as themselves, with no key', () => {
    const request = principal({ subject: 'user-2' })
    expect(actorOf(request)).toBe('user-2')
    expect(viaOf(request)).toBeNull()
  })
})
