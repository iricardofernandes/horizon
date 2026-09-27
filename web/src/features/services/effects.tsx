'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { useStatusLabel } from '@/lib/status'
import {
  type NfseEffect,
  nfseHref,
  nfseState,
  type ReceivableEffect,
  receivableHref,
  receivableState,
} from './types'

/**
 * What Financial did with a billed thing: the receivable's state and a link to it. The
 * state is what Financial reported to Sales; this screen never asks Financial itself.
 */
export function ReceivableEffectCell({
  effect,
  reference,
  withdrawn = false,
}: {
  effect: ReceivableEffect | undefined
  reference: string
  /** The delivery was cancelled or the period credited. */
  withdrawn?: boolean
}) {
  const t = useTranslations('services')
  const label = useStatusLabel()
  const state = receivableState(effect, withdrawn)
  return (
    <span className="service-effect">
      <Badge label={label(state)} status={state} />
      <Link href={receivableHref(effect, reference)}>{t('effects.openReceivable')}</Link>
    </span>
  )
}

/** What Fiscal did with one billed line: the NFS-e's state and a link to the document. */
export function NfseEffectCell({ effect }: { effect: NfseEffect | undefined }) {
  const t = useTranslations('services')
  const label = useStatusLabel()
  const state = nfseState(effect)
  const href = nfseHref(effect)
  return (
    <span className="service-effect">
      <Badge label={label(state)} status={state} />
      {href ? <Link href={href}>{t('effects.openNfse')}</Link> : null}
    </span>
  )
}
