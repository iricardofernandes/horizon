/** Node's built-in loader keeps .env support available in the production image. */
try {
  process.loadEnvFile()
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
}
