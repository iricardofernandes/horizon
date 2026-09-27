export const PARTY_ROLES = ['customer', 'supplier', 'carrier', 'prospect', 'partner'] as const
export type PartyRole = (typeof PARTY_ROLES)[number]

export type PartyKind = 'organization' | 'person'
export type PartyDocumentType = 'cpf' | 'cnpj' | 'foreign' | 'none'

/** The roles the registry refuses without email, phone and address (ADR 0057). */
export const CONTACT_ROLES: readonly PartyRole[] = ['customer', 'supplier', 'carrier']

/** A party as `parties/` presents it: the document leaves as its type and last characters only. */
export type Party = {
  id: string
  kind: PartyKind
  legalName: string
  tradeName: string | null
  document: { type: PartyDocumentType; country: string | null; suffix: string | null }
  taxIdSuffix: string | null
  email: string | null
  phone: string | null
  address: string | null
  roles: PartyRole[]
  status: 'active' | 'inactive' | 'erased'
  createdAt: string
}

export type PartyDocumentInput =
  | { type: 'cpf' | 'cnpj'; number: string }
  | { type: 'foreign'; country: string; number: string }
  | { type: 'none' }

/** CNPJs identify organizations and CPFs people; the registry enforces the pairing. */
export function kindOfTaxId(taxId: string): PartyKind {
  return taxId.trim().replace(/[.\-/\s]/g, '').length === 14 ? 'organization' : 'person'
}

export function requiresContact(roles: readonly PartyRole[]): boolean {
  return roles.some((role) => CONTACT_ROLES.includes(role))
}

/** How the registration form names the choice; a Brazilian number decides CPF or CNPJ itself. */
export type DocumentChoice = 'brazilian' | 'foreign' | 'none'

export function documentOf(
  choice: DocumentChoice,
  fields: { number: string; country: string },
): PartyDocumentInput {
  if (choice === 'none') return { type: 'none' }
  if (choice === 'foreign')
    return { type: 'foreign', country: fields.country.trim().toUpperCase(), number: fields.number }
  return {
    type: kindOfTaxId(fields.number) === 'organization' ? 'cnpj' : 'cpf',
    number: fields.number,
  }
}

/** A foreign document shows its country; a party without one shows nothing to mask. */
export function maskedDocument(party: Party): string {
  const suffix = party.document.suffix
  if (!suffix) return '—'
  return party.document.type === 'foreign' && party.document.country
    ? `${party.document.country} •••• ${suffix}`
    : `•••• ${suffix}`
}
