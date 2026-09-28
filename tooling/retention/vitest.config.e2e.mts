import { defineConfig } from 'vitest/config'

// Against a real PostgreSQL started by Testcontainers, with the module roles the migrations use.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    include: ['test/**/*.e2e-spec.ts'],
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
})
