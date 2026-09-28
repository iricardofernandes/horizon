import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    passWithNoTests: true,
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
  },
})
