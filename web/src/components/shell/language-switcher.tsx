'use client'

import { Select } from '@base-ui/react/select'
import { Check, Translate } from '@phosphor-icons/react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useTransition } from 'react'
import { type Locale, localeNames, locales } from '@/i18n/locale'
import { setLocale } from '@/i18n/set-locale'

const options = locales.map((locale) => ({ label: localeNames[locale], value: locale }))

/** Changes the reader's language without leaving the current resource (ADR 0044). */
export function LanguageSwitcher() {
  const t = useTranslations('shell')
  const locale = useLocale()
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function change(value: unknown) {
    const chosen = String(value) as Locale
    if (chosen === locale) return
    startTransition(async () => {
      await setLocale(chosen)
      router.refresh()
    })
  }

  return (
    <Select.Root disabled={pending} items={options} onValueChange={change} value={locale}>
      <Select.Trigger aria-label={t('language')} className="ui-select-trigger language-switcher">
        <Translate aria-hidden="true" size={16} />
        <Select.Value className="ui-select-value" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="ui-select-positioner" sideOffset={6}>
          <Select.Popup className="ui-select-popup">
            <Select.List className="ui-select-list">
              {options.map((option) => (
                <Select.Item className="ui-select-item" key={option.value} value={option.value}>
                  <Select.ItemIndicator className="ui-select-item-indicator">
                    <Check aria-hidden="true" size={15} weight="bold" />
                  </Select.ItemIndicator>
                  <Select.ItemText>{option.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}
