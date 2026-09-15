import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
  // Standalone output keeps the runtime image small and independent of node_modules.
  output: 'standalone',
}

export default config
