'use client'

import { Flask } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { simulationLabelKey } from './types'

/**
 * Every simulated document says so, wherever it appears: the product never shows one as a
 * document with fiscal value.
 */
export function SimulationLabel({
  simulated,
  compact = false,
}: {
  simulated: boolean
  compact?: boolean
}) {
  const t = useTranslations('fiscal')
  const key = simulationLabelKey({ simulated })
  return (
    <span className={compact ? 'fiscal-simulation fiscal-simulation-compact' : 'fiscal-simulation'}>
      <Flask aria-hidden="true" size={14} />
      {compact ? t(`${key}Short`) : t(key)}
    </span>
  )
}
