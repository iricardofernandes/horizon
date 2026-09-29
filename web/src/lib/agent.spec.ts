import { describe, expect, it } from 'vitest'
import { agentEndpoint, callOf } from './agent'

describe('the agent screen', () => {
  it('points agents at the gateway, per workspace', () => {
    expect(agentEndpoint('http://localhost:8000/', 'tenant-1')).toBe(
      'http://localhost:8000/agent/tenants/tenant-1/mcp',
    )
  })

  it('reads a call from its audit entry, without trusting its details', () => {
    expect(
      callOf({
        sequence: 3,
        occurredAt: '2026-09-29T12:00:00.000Z',
        actor: 'api-key:key-1',
        subjectId: 'list_parties',
        details: { outcome: 'ok', status: 200, rows: 50, truncated: true },
      }),
    ).toEqual({
      sequence: 3,
      occurredAt: '2026-09-29T12:00:00.000Z',
      keyId: 'key-1',
      tool: 'list_parties',
      outcome: 'ok',
      status: 200,
      rows: 50,
      truncated: true,
    })
    expect(
      callOf({ sequence: 1, occurredAt: 'x', actor: 'api-key:k', subjectId: 't', details: {} }),
    ).toMatchObject({ outcome: 'unknown', status: null, rows: null, truncated: false })
  })
})
