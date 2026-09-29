import { describe, expect, it } from 'vitest'
import { readEnvironment } from './environment'

const base = {
  DATABASE_URL: 'postgres://a:b@localhost:5432/x',
  JWKS_URL: 'http://localhost:3001/.well-known/jwks.json',
  GATEWAY_URL: 'http://localhost:8000',
  ASSISTANT_MASTER_KEY: 'ab'.repeat(32),
}

describe('the agent configuration (Phase 76)', () => {
  it('runs the extractive generator by default, and reads an empty provider key as none', () => {
    const config = readEnvironment({ ...base, ANTHROPIC_API_KEY: '' })
    expect(config.ASSISTANT_GENERATOR).toBe('extractive')
    expect(config.ANTHROPIC_API_KEY).toBeUndefined()
    expect(config.ASSISTANT_MODEL).toBe('claude-opus-5-5')
  })

  it('refuses to start without a master key, and names only the field', () => {
    const { ASSISTANT_MASTER_KEY: _, ...rest } = base
    expect(() => readEnvironment(rest)).toThrow('Invalid agent configuration: ASSISTANT_MASTER_KEY')
  })
})
