import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    passWithNoTests: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
  },
})
