import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// Integration and e2e: real PostgreSQL, Redis and RabbitMQ started by Testcontainers
// (ADR 0013). Each run gets its own cluster and its own roles, which is what makes RLS
// testable rather than assumed.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    passWithNoTests: true,
    include: ['test/**/*.e2e-spec.ts'],
    setupFiles: ['./test/setup-e2e.ts'],
    hookTimeout: 120_000,
    testTimeout: 60_000,
    pool: 'forks',
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
})
