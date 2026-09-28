import { describe, expect, it } from 'vitest'
import {
  cleanCode,
  groupedSecret,
  invitationTokenOf,
  isStepUpRequired,
  problemTypeOf,
  recoveryCodesText,
  STEP_UP_REQUIRED,
} from './access'

describe('access on the web', () => {
  it('recognises a request for step-up, and nothing else', () => {
    expect(isStepUpRequired(403, { type: STEP_UP_REQUIRED })).toBe(true)
    expect(isStepUpRequired(403, { type: 'about:blank' })).toBe(false)
    expect(isStepUpRequired(401, { type: STEP_UP_REQUIRED })).toBe(false)
    expect(problemTypeOf(null)).toBeNull()
  })

  it('cleans what a person types into a code field', () => {
    expect(cleanCode('totp', ' 123 456 ')).toBe('123456')
    expect(cleanCode('totp', '1234567')).toBe('123456')
    expect(cleanCode('recovery', ' ABCDE-FGHIJ ')).toBe('abcde-fghij')
  })

  it('writes codes and secrets for a person to keep', () => {
    expect(recoveryCodesText(['aaaaa-bbbbb', 'ccccc-ddddd'], 'Acme')).toBe(
      'Horizon — Acme\n\naaaaa-bbbbb\nccccc-ddddd\n',
    )
    expect(groupedSecret('ABCDEFGHIJ')).toBe('ABCD EFGH IJ')
  })

  it('reads an invitation link, and nothing that is not one', () => {
    expect(invitationTokenOf(`?token=${'a'.repeat(43)}`)).toBe('a'.repeat(43))
    expect(invitationTokenOf('?token=../x')).toBeNull()
    expect(invitationTokenOf('')).toBeNull()
  })
})
