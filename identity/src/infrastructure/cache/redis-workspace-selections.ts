import { createHash, randomBytes } from 'node:crypto'
import type Redis from 'ioredis'
import {
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

  async issue(accountId: string): Promise<WorkspaceSelection> {
    const token = randomBytes(32).toString('base64url')
    await this.redis.set(
      redisKeys.workspaceSelection(digest(token)),
      accountId,
      'EX',
      this.ttlSeconds,
    )
    return { token, expiresAt: new Date(Date.now() + this.ttlSeconds * 1000) }
  }

  async consume(token: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    const value = await this.redis.eval(CONSUME, 1, redisKeys.workspaceSelection(digest(token)))
    return typeof value === 'string' ? value : null
  }

  async resolve(token: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    return this.redis.get(redisKeys.workspaceSelection(digest(token)))
  }
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}
