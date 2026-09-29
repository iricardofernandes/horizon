import { defineConfig } from 'drizzle-kit'

// Migrations run under the owner role; the application role never has DDL rights
// and never bypasses RLS (ADR 0017). The schema is agent settings and the audit log (ADR 0065).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/infrastructure/database/drizzle/schema/*.ts',
  out: './src/infrastructure/database/drizzle/migrations',
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL ?? '',
  },
  strict: true,
  verbose: true,
})
