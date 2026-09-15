'use client'

import { useFormatter } from 'next-intl'

/**
 * Locale-aware presentation of values the API sends as machine data. Money arrives as
 * minor units with an explicit currency (ADR 0010) and is divided once, here.
 */
export function useMoney(): (amount: string, currency: string) => string {
  const format = useFormatter()
  return (amount, currency) => format.number(Number(amount) / 100, { style: 'currency', currency })
}

export function useQuantity(): (value: string | number) => string {
  const format = useFormatter()
  return (value) => format.number(Number(value), { maximumFractionDigits: 6 })
}

export function useDate(): (value: string) => string {
  const format = useFormatter()
  return (value) => format.dateTime(new Date(value), 'short')
}

export function useDateTime(): (value: string) => string {
  const format = useFormatter()
  return (value) => format.dateTime(new Date(value), 'long')
}
