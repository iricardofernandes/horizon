import { snapshotOf } from 'test/support/snapshot-of'
import { describe, expect, it } from 'vitest'
import type { Either } from '@/core/either'
import {
  ContactEmail,
  ContactName,
  ContactPhone,
  JobTitle,
  lawfulBasisOf,
} from '../value-objects/crm-values'
import { Contact, type ContactDetails } from './contact'

function valid<L, R>(result: Either<L, R>): R {
  if (result.isLeft()) throw result.value
  return result.value
}

const now = new Date('2026-09-27T12:00:00Z')
const details: ContactDetails = {
  name: valid(ContactName.create('João  Lima')),
  jobTitle: valid(JobTitle.create('Comprador')),
  email: valid(ContactEmail.create(' Joao@Acme.example ')),
  phone: valid(ContactPhone.create('+55 (11) 98888-7777')),
  lawfulBasis: 'legitimate-interest',
}

function contact() {
  return Contact.create({ ...details, tenantId: 'tenant-a', accountId: 'account-1', now })
}

describe('contacts', () => {
  it('normalizes what a person typed', () => {
    expect(snapshotOf(contact())).toMatchObject({
      name: 'João Lima',
      email: 'joao@acme.example',
      phone: '+5511988887777',
      status: 'active',
    })
  })

  it('names the fields a revision changed, never their values', () => {
    const joao = contact()
    const changed = valid(joao.revise({ ...details, email: null, lawfulBasis: 'consent' }, now))
    expect(changed).toEqual(['email', 'lawfulBasis'])
    expect(valid(joao.revise({ ...details, email: null, lawfulBasis: 'consent' }, now))).toEqual([])
  })

  it('deactivates and reactivates once each way', () => {
    const joao = contact()
    expect(joao.reactivate(now).isLeft()).toBe(true)
    expect(joao.deactivate(now).isRight()).toBe(true)
    expect(joao.deactivate(now).isLeft()).toBe(true)
    expect(joao.reactivate(now).isRight()).toBe(true)
  })

  it('shows nothing personal once erased, and cannot be edited or erased again', () => {
    const joao = contact()
    expect(joao.erase(now).isRight()).toBe(true)
    expect(snapshotOf(joao)).toMatchObject({
      name: null,
      jobTitle: null,
      email: null,
      phone: null,
    })
    expect(joao.revise(details, now).isLeft()).toBe(true)
    expect(joao.erase(now).isLeft()).toBe(true)
  })

  it('refuses malformed values and an unknown lawful basis', () => {
    expect(ContactName.create('J').isLeft()).toBe(true)
    expect(ContactEmail.create('not-an-email').isLeft()).toBe(true)
    expect(ContactPhone.create('12').isLeft()).toBe(true)
    expect(JobTitle.create('').isLeft()).toBe(true)
    expect(lawfulBasisOf('because').isLeft()).toBe(true)
    expect(valid(lawfulBasisOf('contract'))).toBe('contract')
  })
})
