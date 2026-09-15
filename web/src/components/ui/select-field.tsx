'use client'

import { Select } from '@base-ui/react/select'
import { CaretDown, CaretUp, CaretUpDown, Check } from '@phosphor-icons/react'
import type { ReactNode } from 'react'

type SelectOption = {
  label: ReactNode
  value: string
}

type SelectFieldProps = {
  defaultValue?: string | null
  disabled?: boolean
  label: ReactNode
  name: string
  onValueChange?: (value: string | null) => void
  options: SelectOption[]
  placeholder?: string
  required?: boolean
  value?: string | null
}

export function SelectField({
  defaultValue,
  disabled = false,
  label,
  name,
  onValueChange,
  options,
  placeholder = 'Select an option',
  required = false,
  value,
}: SelectFieldProps) {
  return (
    <Select.Root
      defaultValue={defaultValue ?? options[0]?.value ?? null}
      disabled={disabled}
      items={options}
      name={name}
      onValueChange={onValueChange}
      required={required}
      value={value}
    >
      <div className="ui-field">
        <Select.Label className="ui-field-label">{label}</Select.Label>
        <Select.Trigger className="ui-select-trigger">
          <Select.Value className="ui-select-value" placeholder={placeholder} />
          <Select.Icon className="ui-select-icon">
            <CaretUpDown aria-hidden="true" size={16} weight="bold" />
          </Select.Icon>
        </Select.Trigger>
      </div>
      <Select.Portal>
        <Select.Positioner className="ui-select-positioner" sideOffset={6}>
          <Select.Popup className="ui-select-popup">
            <Select.ScrollUpArrow className="ui-select-scroll-arrow">
              <CaretUp aria-hidden="true" size={14} weight="bold" />
            </Select.ScrollUpArrow>
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
            <Select.ScrollDownArrow className="ui-select-scroll-arrow">
              <CaretDown aria-hidden="true" size={14} weight="bold" />
            </Select.ScrollDownArrow>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}
