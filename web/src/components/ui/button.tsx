'use client'

import { Button as BaseButton } from '@base-ui/react/button'
import type { ComponentProps } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'navigation' | 'workspace'

type ButtonProps = Omit<ComponentProps<typeof BaseButton>, 'className'> & {
  className?: string
  variant?: ButtonVariant
}

export function Button({ className = '', variant = 'ghost', ...props }: ButtonProps) {
  const classes = ['ui-button', `ui-button-${variant}`, className].filter(Boolean).join(' ')
  return <BaseButton className={classes} {...props} />
}
