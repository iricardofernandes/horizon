import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
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
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
