import type { Metadata, Viewport } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale } from 'next-intl/server'
import type { ReactNode } from 'react'
import '@fontsource-variable/dm-sans'
import './styles.css'

export const metadata: Metadata = {
  title: { default: 'Horizon ERP', template: '%s · Horizon' },
  description: 'Operations, inventory and sales in one dependable workspace.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale()
  return (
    <html lang={locale} className="horizon-theme">
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  )
}
