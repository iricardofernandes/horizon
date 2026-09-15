'use client'

import { Field } from '@base-ui/react/field'
import type { ComponentProps, ReactNode } from 'react'

type TextFieldProps = Omit<ComponentProps<typeof Field.Control>, 'className'> & {
  description?: ReactNode
  label: ReactNode
}

export function TextField({ description, label, ...props }: TextFieldProps) {
  return (
    <Field.Root className="ui-field">
      <Field.Label className="ui-field-label">{label}</Field.Label>
      <Field.Control className="ui-input" {...props} />
      {description ? (
        <Field.Description className="ui-field-description">{description}</Field.Description>
      ) : null}
    </Field.Root>
  )
}
