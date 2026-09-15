import { describe, expect, it } from 'vitest'
import { readConfig } from './config.js'

const active = {
  HORIZON_MCP_DEBUGGER_ENABLED: 'true',
  LOKI_URL: 'http://localhost:3100/',
  JAEGER_URL: 'http://localhost:16686',
  PROMETHEUS_URL: 'http://localhost:9090',
  RABBITMQ_MANAGEMENT_URL: 'http://localhost:15672',
  RABBITMQ_MANAGEMENT_USER: 'debug',
  RABBITMQ_MANAGEMENT_PASSWORD: 'secret',
  DEBUG_DATABASE_URLS:
    'catalog=postgres://debug:secret@localhost/catalog,sales=postgres://debug:secret@localhost/sales',
  TENANT_ID_HASH_SALT: '0123456789abcdef',
  PII_MASK_FIELDS: 'email, phone',
}

describe('readConfig', () => {
  it('requires no credentials while the debugger is disabled', () => {
    expect(readConfig({})).toEqual({ enabled: false })
  })

  it('parses the active least-privilege source configuration', () => {
    const config = readConfig(active)
    expect(config).toMatchObject({
      enabled: true,
      transport: 'stdio',
      lokiUrl: 'http://localhost:3100',
    })
    if (config.enabled) expect([...config.databases.keys()]).toEqual(['catalog', 'sales'])
  })

  it('refuses HTTP without a bearer token', () => {
    expect(() => readConfig({ ...active, MCP_TRANSPORT: 'http' })).toThrow(/bearer/i)
  })
})
