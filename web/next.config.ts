import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'
import { securityHeaders } from './src/lib/edge-policy'

const config: NextConfig = {
  reactStrictMode: true,
  // Standalone output keeps the runtime image small and independent of node_modules.
  output: 'standalone',
  poweredByHeader: false,
  // Every response, built files included (Phase 80); the page policy is set in src/proxy.ts.
  async headers() {
    const headers = securityHeaders()
    return [
      {
        source: '/:path*',
        headers: Object.entries(headers).map(([key, value]) => ({ key, value })),
      },
    ]
  },
}

// No locale routing: authenticated URLs stay language-neutral (ADR 0044).
export default createNextIntlPlugin('./src/i18n/request.ts')(config)
