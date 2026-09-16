export const PARTY_ROLES = ['customer', 'supplier', 'carrier', 'prospect', 'partner'] as const
export type PartyRole = (typeof PARTY_ROLES)[number]

/** A party as `parties/` presents it: the tax identifier leaves as its last digits only. */
export type Party = {
  id: string
  kind: 'organization' | 'person'
  legalName: string
  tradeName: string | null
  taxIdSuffix: string | null
  email: string
  phone: string
  address: string
  roles: PartyRole[]
  status: 'active' | 'inactive' | 'erased'
  createdAt: string
}

/** CNPJs identify organizations and CPFs people; the registry enforces the pairing. */
export function kindOfTaxId(taxId: string): Party['kind'] {
  return taxId.replace(/\D/g, '').length === 14 ? 'organization' : 'person'
}

export function maskedTaxId(party: Party): string {
  return party.taxIdSuffix ? `•••• ${party.taxIdSuffix}` : '—'
}
