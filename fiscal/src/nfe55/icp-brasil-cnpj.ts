import type { X509Certificate } from 'node:crypto'

type DerElement = { tag: number; content: Buffer }

const subjectAlternativeNameOid = Buffer.from('551d11', 'hex')
const legalEntityCnpjOid = Buffer.from('604c010303', 'hex')

function elements(bytes: Buffer): DerElement[] {
  const result: DerElement[] = []
  let offset = 0
  while (offset < bytes.length) {
    const tag = bytes[offset++]
    const firstLength = bytes[offset++]
    if (tag === undefined || firstLength === undefined)
      throw new Error('Certificate ASN.1 is truncated')
    let length = firstLength
    if (firstLength & 0x80) {
      const lengthBytes = firstLength & 0x7f
      if (lengthBytes === 0 || lengthBytes > 3 || offset + lengthBytes > bytes.length)
        throw new Error('Certificate ASN.1 length is invalid')
      length = 0
      for (let index = 0; index < lengthBytes; index++)
        length = length * 256 + (bytes[offset++] ?? 0)
      if (length < 128) throw new Error('Certificate ASN.1 length is not canonical')
    }
    if (offset + length > bytes.length) throw new Error('Certificate ASN.1 value is truncated')
    result.push({ tag, content: bytes.subarray(offset, offset + length) })
    offset += length
  }
  return result
}

function onlyChild(parent: DerElement, tag: number): DerElement {
  const children = elements(parent.content)
  if (children.length !== 1 || children[0]?.tag !== tag)
    throw new Error('Certificate ASN.1 structure is invalid')
  return children[0]
}

/** Reads the ICP-Brasil legal-entity CNPJ otherName without relying on Node's text rendering. */
export function certificateLegalEntityCnpj(certificate: X509Certificate): string {
  const root = elements(certificate.raw)
  if (root.length !== 1 || root[0]?.tag !== 0x30)
    throw new Error('Certificate ASN.1 root is invalid')
  const tbs = elements(root[0].content)[0]
  if (tbs?.tag !== 0x30) throw new Error('Certificate ASN.1 TBS is invalid')
  const extensions = elements(tbs.content).filter((entry) => entry.tag === 0xa3)
  if (extensions.length !== 1) throw new Error('Certificate extensions are missing or duplicate')
  const extensionSequence = onlyChild(extensions[0] as DerElement, 0x30)
  const subjectNames = elements(extensionSequence.content)
    .filter((entry) => entry.tag === 0x30)
    .map((entry) => elements(entry.content))
    .filter((entry) => entry[0]?.tag === 0x06 && entry[0].content.equals(subjectAlternativeNameOid))
  if (subjectNames.length !== 1)
    throw new Error('Certificate subject alternative name is missing or duplicate')
  const sanExtension = subjectNames[0]
  const sanValue = sanExtension?.find((entry) => entry.tag === 0x04)
  if (!sanValue) throw new Error('Certificate subject alternative name value is missing')
  const names = onlyChild({ tag: 0x30, content: sanValue.content }, 0x30)
  const matches = elements(names.content)
    .filter((entry) => entry.tag === 0xa0)
    .map((entry) => {
      const fields = elements(entry.content)
      const otherName =
        fields.length === 1 && fields[0]?.tag === 0x30 ? elements(fields[0].content) : fields
      if (otherName[0]?.tag !== 0x06 || !otherName[0].content.equals(legalEntityCnpjOid))
        return null
      if (otherName.length !== 2 || otherName[1]?.tag !== 0xa0)
        throw new Error('Certificate CNPJ otherName is malformed')
      const encoded = elements(otherName[1].content)
      if (encoded.length !== 1 || ![0x04, 0x13].includes(encoded[0]?.tag ?? -1))
        throw new Error('Certificate CNPJ otherName encoding is unsupported')
      const cnpj = encoded[0]?.content.toString('ascii') ?? ''
      if (!/^[0-9A-Z]{14}$/.test(cnpj))
        throw new Error('Certificate CNPJ otherName has an invalid value')
      return cnpj
    })
    .filter((value): value is string => value !== null)
  if (matches.length !== 1) throw new Error('Certificate legal-entity CNPJ is missing or duplicate')
  return matches[0] as string
}
