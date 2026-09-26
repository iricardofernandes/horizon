import { isValidNfeAccessKey } from '../nfe55/access-key'

/**
 * Simulation-only consultation URLs. `.invalid` never resolves (RFC 6761), so a simulated
 * receipt cannot send a consumer to a real SEFAZ page. Official per-UF URLs (ENCAT list)
 * belong to the homologation gate and are not pinned.
 */
export const SIMULATION_QR_URL = 'https://nfce.simulacao.horizon.invalid/qrcode'
export const SIMULATION_KEY_QUERY_URL = 'https://nfce.simulacao.horizon.invalid/consulta'

/**
 * QR code version 3 for an online NFC-e (NT 2025.001 §04, DANFE NFC-e manual v6.0 §4.4.1):
 * `<url>?p=<access key>|3|<tpAmb>`. No CSC and no hash: version 3 authenticates only
 * contingency QR codes, by signature.
 */
export function onlineQrCodeV3(input: {
  queryUrl: string
  accessKey: string
  environment: '1' | '2'
}): string {
  if (!/^https?:\/\/[^?\s|]+$/i.test(input.queryUrl))
    throw new Error('NFC-e QR code URL must be an http(s) address without a query')
  if (!isValidNfeAccessKey(input.accessKey) || input.accessKey.slice(20, 22) !== '65')
    throw new Error('NFC-e QR code needs a model 65 access key')
  if (input.accessKey[34] !== '1')
    throw new Error('Only an online (tpEmis 1) NFC-e has a version 3 online QR code')
  return `${input.queryUrl}?p=${input.accessKey}|3|${input.environment}`
}

/** Reads the parameters back, for the DANFE and the tests. */
export function parseOnlineQrCodeV3(
  qrCode: string,
): { queryUrl: string; accessKey: string; version: '3'; environment: '1' | '2' } | null {
  const match = /^(https?:\/\/[^?]+)\?p=([0-9A-Z]{44})\|3\|([12])$/.exec(qrCode)
  if (!match?.[1] || !match[2] || !match[3]) return null
  return {
    queryUrl: match[1],
    accessKey: match[2],
    version: '3',
    environment: match[3] as '1' | '2',
  }
}
