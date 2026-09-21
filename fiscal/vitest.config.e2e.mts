import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    hookTimeout: 120_000,
    testTimeout: 60_000,
    pool: 'forks',
  },
})
