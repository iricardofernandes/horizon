import type { SefazResponse } from './sefaz-soap'

export const SEFAZ_DECISION_VERSION = 'nfe55-sp-homologation-decision-v1'

export type SefazDecision =
  | 'authorized'
  | 'rejected'
  | 'cancelled'
  | 'pending'
  | 'available'
  | 'unavailable'
  | 'unknown'

/** Only explicitly reviewed status combinations may become final outcomes. */
export function classifySefazResponse(response: SefazResponse): SefazDecision {
  if (response.service === 'status') {
    if (response.statusCode === '107') return 'available'
    if (response.statusCode === '108' || response.statusCode === '109') return 'unavailable'
    return 'unknown'
  }
  if (response.service === 'event') {
    if (
      response.statusCode === '128' &&
      response.eventStatusCode === '135' &&
      response.accessKey &&
      response.protocolNumber &&
      response.protocol
    )
      return 'cancelled'
    return 'unknown'
  }
  if (response.service === 'authorization' && response.statusCode === '103' && response.receipt)
    return 'pending'
  if (response.service === 'receipt' && response.statusCode === '105') return 'pending'
  const processed =
    (response.service === 'authorization' || response.service === 'receipt') &&
    response.statusCode === '104'
  const consulted = response.service === 'protocol' && response.statusCode === '100'
  if (
    (processed || consulted) &&
    response.documentStatusCode === '100' &&
    response.accessKey &&
    response.protocolNumber &&
    response.protocol
  )
    return 'authorized'
  if (
    (processed && ['215', '225'].includes(response.documentStatusCode ?? '')) ||
    (response.service === 'authorization' && ['215', '225'].includes(response.statusCode))
  )
    return 'rejected'
  return 'unknown'
}
