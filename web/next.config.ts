import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

const config: NextConfig = {
  reactStrictMode: true,
  // Standalone output keeps the runtime image small and independent of node_modules.
  output: 'standalone',
}

// No locale routing: authenticated URLs stay language-neutral (ADR 0044).
export default createNextIntlPlugin('./src/i18n/request.ts')(config)
