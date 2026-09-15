import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import '@fontsource-variable/inter/standard.css'
import '@radix-ui/colors/amber.css'
import '@radix-ui/colors/black-alpha.css'
import '@radix-ui/colors/jade.css'
import '@radix-ui/colors/jade-alpha.css'
import '@radix-ui/colors/red.css'
import '@radix-ui/colors/sage.css'
import '@radix-ui/colors/sage-alpha.css'
import '@radix-ui/colors/white-alpha.css'
import './styles.css'

export const metadata: Metadata = {
  title: { default: 'Horizon ERP', template: '%s · Horizon' },
  description: 'Operations, inventory and sales in one dependable workspace.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="horizon-theme">
      <body>{children}</body>
    </html>
  )
}
