import { createHash, randomBytes } from 'node:crypto'
import type Redis from 'ioredis'
import {
  type SelectionGrant,
  type WorkspaceSelection,
  WorkspaceSelections,
} from '@/application/ports/workspace-selections'
import { redisKeys } from './redis-keys'

const CONSUME = `
local value = redis.call('GET', KEYS[1])
if not value then return false end
redis.call('DEL', KEYS[1])
return value
`

export class RedisWorkspaceSelections extends WorkspaceSelections {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {
    super()
  }

  async issue(
    accountId: string,
    auth: { amr: readonly string[]; authTime: Date } = { amr: ['pwd'], authTime: new Date() },
  ): Promise<WorkspaceSelection> {
    const token = randomBytes(32).toString('base64url')
    const grant = { accountId, amr: [...auth.amr], authTime: auth.authTime.toISOString() }
    await this.redis.set(
      redisKeys.workspaceSelection(digest(token)),
      JSON.stringify(grant),
      'EX',
      this.ttlSeconds,
    )
    return { token, expiresAt: new Date(Date.now() + this.ttlSeconds * 1000) }
  }

  async consume(token: string): Promise<string | null> {
    return (await this.consumeGrant(token))?.accountId ?? null
  }

  override async consumeGrant(token: string): Promise<SelectionGrant | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    const value = await this.redis.eval(CONSUME, 1, redisKeys.workspaceSelection(digest(token)))
    return typeof value === 'string' ? grantOf(value) : null
  }

  async resolve(token: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    const value = await this.redis.get(redisKeys.workspaceSelection(digest(token)))
    return value === null ? null : grantOf(value).accountId
  }
}

/** A grant as stored; a bare account id is a selection issued before Phase 67. */
function grantOf(value: string): SelectionGrant {
  if (!value.startsWith('{')) return { accountId: value, amr: ['pwd'], authTime: null }
  const parsed = JSON.parse(value) as { accountId: string; amr: string[]; authTime: string }
  return { accountId: parsed.accountId, amr: parsed.amr, authTime: new Date(parsed.authTime) }
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}
