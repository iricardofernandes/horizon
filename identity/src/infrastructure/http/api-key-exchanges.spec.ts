import { describe, expect, it, vi } from 'vitest'
import { left, right } from '@/core/either'
import { NotAllowedError } from '@/core/errors/errors/not-allowed-error'
import {
  ApiKeyRateLimitedError,
  RateLimitUnavailableError,
} from '@/domain/errors/api-key-rate-limited-error'
import { InvalidCredentialsError } from '@/domain/errors/invalid-credentials-error'
import { keyNameOf, outcomeOf, recordExchange } from './api-key-exchanges'

const PRESENTED = `hz_live_${'A'.repeat(24)}_${'s'.repeat(32)}`
const issued = right({
  tenantId: 't',
  apiKeyId: 'k',
  accessToken: 'token',
  expiresAt: new Date(),
  scopes: [],
})

describe('API key exchanges (Phase 81)', () => {
  it('sorts every exchange into one of four outcomes', () => {
    expect(outcomeOf(issued)).toBe('issued')
    expect(outcomeOf(left(new ApiKeyRateLimitedError(30)))).toBe('rate-limited')
    expect(outcomeOf(left(new RateLimitUnavailableError()))).toBe('unavailable')
    expect(outcomeOf(left(new InvalidCredentialsError()))).toBe('refused')
    expect(outcomeOf(left(new NotAllowedError('no')))).toBe('refused')
  })

  it('names the key by its prefix in the log, never by its secret', () => {
    const logger = { warn: vi.fn() }
    recordExchange(left(new InvalidCredentialsError()), PRESENTED, logger)
    const [line] = logger.warn.mock.calls[0] ?? []
    expect(line).toContain('refused')
    expect(line).toContain('A'.repeat(24))
    expect(line).not.toContain('s'.repeat(32))
    expect(keyNameOf('not a key')).toBe('an unreadable key')
  })

  it('logs nothing for an issued token', () => {
    const logger = { warn: vi.fn() }
    expect(recordExchange(issued, PRESENTED, logger)).toBe('issued')
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
