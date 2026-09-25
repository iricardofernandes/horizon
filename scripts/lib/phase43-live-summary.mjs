/** Only the fields safe for CI logs leave the live exchange command. */
export function phase43LiveSummary(observed) {
  if (!observed || typeof observed !== 'object')
    throw new Error('Live homologation exchange returned an invalid summary')
  const digest = observed.responseDigest
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest))
    throw new Error('Live homologation exchange omitted the response digest')
  return {
    action: observed.action,
    exchangeId: observed.exchangeId,
    service: observed.service,
    statusCode: observed.statusCode,
    documentStatusCode: observed.documentStatusCode,
    eventStatusCode: observed.eventStatusCode,
    responseDigest: digest,
    receiptPresent: Boolean(observed.receipt),
    protocolPresent: Boolean(observed.protocolNumber),
  }
}
