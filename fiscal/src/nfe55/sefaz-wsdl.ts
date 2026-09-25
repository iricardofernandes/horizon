import { request } from 'node:https'
import { DOMParser } from '@xmldom/xmldom'
import type { HomologationCredential } from './homologation-credential'
import type { SefazTrustAnchor } from './sefaz-trust-anchor'

const maximumWsdlBytes = 2_000_000
const wsdlNamespace = 'http://schemas.xmlsoap.org/wsdl/'

/** Read-only WSDL retrieval through the same reviewed client certificate and TLS root. */
export async function fetchSefazWsdl(
  endpoint: URL,
  credential: Pick<HomologationCredential, 'certificate' | 'privateKey'>,
  trustAnchor: Pick<SefazTrustAnchor, 'certificate'>,
  timeoutMilliseconds = 15_000,
): Promise<Buffer> {
  const wsdlUrl = new URL(endpoint.href)
  wsdlUrl.search = '?WSDL'
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const call = request(
      wsdlUrl,
      {
        method: 'GET',
        cert: credential.certificate,
        key: credential.privateKey,
        ca: trustAnchor.certificate,
        rejectUnauthorized: true,
        timeout: timeoutMilliseconds,
        headers: { accept: 'text/xml, application/wsdl+xml' },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`SEFAZ WSDL returned HTTP ${response.statusCode ?? 0}`))
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maximumWsdlBytes) {
            response.destroy(new Error('SEFAZ WSDL exceeded the byte limit'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => resolve(Buffer.concat(chunks)))
        response.on('error', reject)
      },
    )
    call.on('timeout', () => call.destroy(new Error('SEFAZ WSDL request timed out')))
    call.on('error', reject)
    call.end()
  })
  const xml = bytes.toString('utf8')
  if (xml.includes('\uFFFD') || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('SEFAZ WSDL contains forbidden declarations or invalid UTF-8')
  const errors: string[] = []
  const document = new DOMParser({
    onError: (_level, message) => errors.push(message),
  }).parseFromString(xml, 'application/xml')
  if (
    errors.length > 0 ||
    document.documentElement?.localName !== 'definitions' ||
    document.documentElement.namespaceURI !== wsdlNamespace
  )
    throw new Error('SEFAZ response is not a valid WSDL definitions document')
  return bytes
}
