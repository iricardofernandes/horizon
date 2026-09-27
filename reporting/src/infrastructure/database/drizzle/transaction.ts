import type { drizzle } from 'drizzle-orm/postgres-js'
import type * as schema from './schema'

export type Database = ReturnType<typeof drizzle<typeof schema>>
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
