import postgres from 'postgres'
import {
  type AssistantSettings,
  AssistantStore,
  type ConversationSummary,
  type ErasureEvent,
  type MonthUsage,
  type SettingsChange,
  type StoredTurn,
} from '@/application/assistant-ports'
import type { GenerationUsage } from '@/application/generation'
import type { AgentStore } from '@/application/ports'
import { masterKeyIdOf } from '@/infrastructure/cryptography/keyring'

type Tx = postgres.TransactionSql

export const DEFAULT_BUDGET_TOKENS = 200_000

interface SettingsRow {
  enabled: boolean
  notice_version: string | null
  accepted_by: string | null
  accepted_at: Date | null
  monthly_budget_tokens: number
}

const settingsOf = (row: SettingsRow | undefined): AssistantSettings => ({
  enabled: row?.enabled === true,
  noticeVersion: row?.notice_version ?? null,
  acceptedBy: row?.accepted_by ?? null,
  acceptedAt: row?.accepted_at ?? null,
  monthlyBudgetTokens: row?.monthly_budget_tokens ?? DEFAULT_BUDGET_TOKENS,
})

/**
 * The assistant's state (Phase 76), each statement in one tenant's transaction under forced
 * RLS. Its switch changes are audited through the agent's chain, in the same transaction's
 * spirit: the change, then its entry.
 */
export class AssistantDatabase extends AssistantStore {
  readonly #sql: postgres.Sql

  constructor(
    url: string,
    private readonly audit: AgentStore,
    options: { readonly poolMax?: number; readonly statementTimeoutMs?: number } = {},
  ) {
    super()
    this.#sql = postgres(url, {
      max: options.poolMax ?? 5,
      connect_timeout: 5,
      connection: { statement_timeout: options.statementTimeoutMs ?? 5000 },
    })
  }

  private inTenant<T>(tenantId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#sql.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      await tx`insert into tenants (id) values (${tenantId}) on conflict do nothing`
      return work(tx)
    }) as Promise<T>
  }

  settings(tenantId: string): Promise<AssistantSettings> {
    return this.inTenant(tenantId, async (tx) => {
      const [row] = await tx<SettingsRow[]>`select * from assistant_settings`
      return settingsOf(row)
    })
  }

  async changeSettings(
    tenantId: string,
    change: SettingsChange,
    by: string,
    at: Date,
  ): Promise<AssistantSettings> {
    const next = await this.inTenant(tenantId, async (tx) => {
      const current = settingsOf(
        (await tx<SettingsRow[]>`select * from assistant_settings for update`)[0],
      )
      const accepted = change.noticeVersion !== undefined
      const row = {
        enabled: change.enabled ?? current.enabled,
        notice_version: accepted ? change.noticeVersion : current.noticeVersion,
        accepted_by: accepted ? by : current.acceptedBy,
        accepted_at: accepted ? at : current.acceptedAt,
        monthly_budget_tokens: change.monthlyBudgetTokens ?? current.monthlyBudgetTokens,
      }
      const [saved] = await tx<SettingsRow[]>`
        insert into assistant_settings (tenant_id, enabled, notice_version, accepted_by,
          accepted_at, monthly_budget_tokens, updated_by, updated_at)
        values (${tenantId}, ${row.enabled}, ${row.notice_version ?? null}, ${row.accepted_by},
          ${row.accepted_at}, ${row.monthly_budget_tokens}, ${by}, ${at})
        on conflict (tenant_id) do update set enabled = excluded.enabled,
          notice_version = excluded.notice_version, accepted_by = excluded.accepted_by,
          accepted_at = excluded.accepted_at,
          monthly_budget_tokens = excluded.monthly_budget_tokens,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at
        returning *`
      return settingsOf(saved)
    })
    await this.audit.audit(tenantId, {
      actor: by,
      subjectType: 'assistant-settings',
      subjectId: tenantId,
      action: 'assistant.settings.changed',
      occurredAt: at,
      details: {
        enabled: next.enabled,
        monthlyBudgetTokens: next.monthlyBudgetTokens,
        noticeVersion: next.noticeVersion,
      },
    })
    return next
  }

  usage(tenantId: string, month: string): Promise<MonthUsage> {
    return this.inTenant(tenantId, async (tx) => {
      const [row] = await tx<{ input_tokens: string; output_tokens: string; questions: number }[]>`
        select input_tokens, output_tokens, questions from assistant_usage where month = ${month}`
      return {
        inputTokens: Number(row?.input_tokens ?? 0),
        outputTokens: Number(row?.output_tokens ?? 0),
        questions: row?.questions ?? 0,
      }
    })
  }

  addUsage(
    tenantId: string,
    month: string,
    usage: GenerationUsage,
    questions: number,
  ): Promise<void> {
    return this.inTenant(tenantId, async (tx) => {
      await tx`
        insert into assistant_usage (tenant_id, month, input_tokens, output_tokens, questions)
        values (${tenantId}, ${month}, ${usage.inputTokens}, ${usage.outputTokens}, ${questions})
        on conflict (tenant_id, month) do update set
          input_tokens = assistant_usage.input_tokens + excluded.input_tokens,
          output_tokens = assistant_usage.output_tokens + excluded.output_tokens,
          questions = assistant_usage.questions + excluded.questions`
    })
  }

  /** Tenants holding person keys not wrapped under the current master key (Phase 81). */
  async tenantsOnOldMasterKeys(currentId: string): Promise<{ tenantId: string; keys: number }[]> {
    const rows = await this.#sql<{ tenant_id: string; keys: string }[]>`
      select tenant_id, keys from tenants_on_old_master_keys(${currentId})`
    return rows.map((row) => ({ tenantId: row.tenant_id, keys: Number(row.keys) }))
  }

  /** Up to `limit` of a tenant's person keys, rewrapped under the current master key. */
  rewrapKeys(
    tenantId: string,
    currentId: string,
    rewrap: (userId: string, wrappedKey: string) => string,
    limit: number,
  ): Promise<number> {
    return this.inTenant(tenantId, async (tx) => {
      const rows = await tx<{ user_id: string; wrapped_key: string }[]>`
        select user_id, wrapped_key from assistant_keys
        where master_key_id is distinct from ${currentId}
        limit ${limit} for update skip locked`
      for (const row of rows) {
        const wrapped = rewrap(row.user_id, row.wrapped_key)
        await tx`update assistant_keys set wrapped_key = ${wrapped},
          master_key_id = ${masterKeyIdOf(wrapped)} where user_id = ${row.user_id}`
      }
      return rows.length
    })
  }

  keyOf(tenantId: string, userId: string, create: () => string, at: Date): Promise<string> {
    return this.inTenant(tenantId, async (tx) => {
      const wrapped = create()
      await tx`
        insert into assistant_keys (tenant_id, user_id, wrapped_key, master_key_id, created_at)
        values (${tenantId}, ${userId}, ${wrapped}, ${masterKeyIdOf(wrapped)}, ${at})
        on conflict do nothing`
      const [row] = await tx<{ wrapped_key: string }[]>`
        select wrapped_key from assistant_keys where user_id = ${userId}`
      if (!row) throw new Error('the person key could not be kept')
      return row.wrapped_key
    })
  }

  conversation(
    tenantId: string,
    userId: string,
    conversationId: string,
    now: Date,
  ): Promise<{ turns: StoredTurn[] } | null> {
    return this.inTenant(tenantId, async (tx) => {
      const [found] = await tx`
        select id from assistant_conversations
        where id = ${conversationId} and user_id = ${userId} and expires_at > ${now}`
      if (!found) return null
      const turns = await tx<{ ordinal: number; sealed: Buffer; created_at: Date }[]>`
        select ordinal, sealed, created_at from assistant_turns
        where conversation_id = ${conversationId} order by ordinal`
      return {
        turns: turns.map((row) => ({
          ordinal: row.ordinal,
          sealed: row.sealed,
          createdAt: row.created_at,
        })),
      }
    })
  }

  appendTurn(
    tenantId: string,
    userId: string,
    conversationId: string,
    seal: (ordinal: number) => Buffer,
    at: Date,
    expiresAt: Date,
  ): Promise<number> {
    return this.inTenant(tenantId, async (tx) => {
      await tx`
        insert into assistant_conversations (tenant_id, id, user_id, turns, created_at,
          updated_at, expires_at)
        values (${tenantId}, ${conversationId}, ${userId}, 0, ${at}, ${at}, ${expiresAt})
        on conflict (tenant_id, id) do nothing`
      const [conversation] = await tx<{ turns: number; user_id: string }[]>`
        select turns, user_id from assistant_conversations where id = ${conversationId} for update`
      if (!conversation || conversation.user_id !== userId)
        throw new Error('the conversation belongs to someone else')
      const ordinal = conversation.turns
      await tx`
        insert into assistant_turns (tenant_id, conversation_id, ordinal, sealed, created_at)
        values (${tenantId}, ${conversationId}, ${ordinal}, ${seal(ordinal)}, ${at})`
      await tx`
        update assistant_conversations set turns = ${ordinal + 1}, updated_at = ${at},
          expires_at = ${expiresAt}
        where id = ${conversationId}`
      return ordinal
    })
  }

  conversations(tenantId: string, userId: string, now: Date): Promise<ConversationSummary[]> {
    return this.inTenant(tenantId, async (tx) => {
      const rows = await tx<
        {
          id: string
          turns: number
          created_at: Date
          updated_at: Date
          expires_at: Date
          sealed: Buffer | null
          first_at: Date | null
        }[]
      >`
        select c.id, c.turns, c.created_at, c.updated_at, c.expires_at, t.sealed,
          t.created_at as first_at
        from assistant_conversations c
        left join assistant_turns t on t.tenant_id = c.tenant_id
          and t.conversation_id = c.id and t.ordinal = 0
        where c.user_id = ${userId} and c.expires_at > ${now}
        order by c.updated_at desc limit 50`
      return rows.map((row) => ({
        id: row.id,
        turns: row.turns,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at,
        first:
          row.sealed && row.first_at
            ? { ordinal: 0, sealed: row.sealed, createdAt: row.first_at }
            : null,
      }))
    })
  }

  deleteConversation(tenantId: string, userId: string, conversationId: string): Promise<boolean> {
    return this.inTenant(tenantId, async (tx) => {
      const deleted = await tx`
        delete from assistant_conversations where id = ${conversationId} and user_id = ${userId}
        returning id`
      return deleted.length > 0
    })
  }

  erase(event: ErasureEvent, userId: string): Promise<boolean> {
    return this.inTenant(event.tenantId, async (tx) => {
      const claimed = await tx`
        insert into inbox (source_module, event_id, event_type, tenant_id)
        values (${event.sourceModule}, ${event.eventId}, ${event.eventType}, ${event.tenantId})
        on conflict do nothing returning event_id`
      if (!claimed.length) return false
      await tx`delete from assistant_keys where user_id = ${userId}`
      await tx`delete from assistant_conversations where user_id = ${userId}`
      return true
    })
  }

  async purgeExpired(): Promise<number> {
    const [row] = await this.#sql<
      { purged: number }[]
    >`select purge_expired_conversations() as purged`
    return row?.purged ?? 0
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 })
  }
}
