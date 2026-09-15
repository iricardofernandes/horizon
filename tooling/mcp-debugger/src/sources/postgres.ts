import postgres, { type Sql } from 'postgres'
import { validateExplainQuery } from '../query-validator.js'

export class PostgresSource {
  private readonly clients: ReadonlyMap<string, Sql>

  constructor(databases: ReadonlyMap<string, string>) {
    this.clients = new Map(
      [...databases].map(([module, url]) => [
        module,
        postgres(url, {
          max: 2,
          idle_timeout: 10,
          connect_timeout: 5,
          prepare: false,
          connection: { statement_timeout: 10_000 },
        }),
      ]),
    )
  }

  modules(): string[] {
    return [...this.clients.keys()]
  }

  async describeSchema(module: string, schema: string): Promise<unknown> {
    const sql = this.client(module)
    const rows = await sql`SELECT horizon_debug.describe_schema(${schema}) AS description`
    return rows[0]?.description ?? { tables: [] }
  }

  async explain(module: string, query: string): Promise<unknown> {
    const validated = validateExplainQuery(query)
    return this.executeExplain(module, validated)
  }

  // Split out so tests can prove validation happens before a driver call.
  protected async executeExplain(module: string, query: string): Promise<unknown> {
    const sql = this.client(module)
    const rows = await sql`SELECT horizon_debug.explain_query(${query}) AS plan`
    return rows[0]?.plan ?? []
  }

  async slowQueries(module: string, limit: number): Promise<unknown[]> {
    const sql = this.client(module)
    const rows = await sql`
      SELECT queryid::text AS query_id,
             calls,
             round(total_exec_time::numeric, 2) AS total_exec_time_ms,
             round(mean_exec_time::numeric, 2) AS mean_exec_time_ms,
             rows,
             left(query, 1000) AS normalized_query
        FROM pg_stat_statements
       WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
       ORDER BY total_exec_time DESC
       LIMIT ${limit}
    `
    return [...rows]
  }

  async outboxBacklog(module?: string): Promise<unknown[]> {
    const selected = module ? [[module, this.client(module)] as const] : [...this.clients]
    return Promise.all(
      selected.map(async ([name, sql]) => {
        const rows = await sql`SELECT * FROM horizon_debug.outbox_backlog()`
        return { module: name, ...(rows[0] ?? { pending: 0, oldest_age_seconds: null }) }
      }),
    )
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.end({ timeout: 2 })))
  }

  private client(module: string): Sql {
    const client = this.clients.get(module)
    if (!client) throw new Error(`Unknown database module: ${module}`)
    return client
  }
}
