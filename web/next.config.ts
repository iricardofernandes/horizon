import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
  // Standalone output keeps the runtime image small and independent of node_modules.
  output: 'standalone',
  // Every call goes through Kong, never directly to a service (ADR 0008).
  env: {
    HORIZON_API_URL: process.env.HORIZON_API_URL ?? 'http://localhost:8000',
  },
}

export default config
