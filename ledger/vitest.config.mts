import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// Unit tests: colocated *.spec.ts, no I/O, tenant-scoped in-memory repository fakes
// (ADR 0014). The coverage gate applies to domain/ and application/ only —
// infrastructure adapters are proven by the e2e suite, not by line counting.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    passWithNoTests: true,
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/domain/**', 'src/application/**'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
  // SWC rather than esbuild: esbuild does not emit decorator metadata, which the
  // Nest container needs in the e2e suite and which must not differ between configs.
  plugins: [swc.vite({ module: { type: 'es6' } })],
})
