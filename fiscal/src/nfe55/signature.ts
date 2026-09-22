import { DOMParser } from '@xmldom/xmldom'
import { SignedXml } from 'xml-crypto'

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'
const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1'
const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1'

export type SimulationCredential = { privateKey: Buffer; certificate: Buffer }

export function signNfe55(unsignedXml: Buffer, credential: SimulationCredential): Buffer {
  if (credential.privateKey.length === 0 || credential.certificate.length === 0)
    throw new Error('Simulation signing credential is incomplete')
  const xml = unsignedXml.toString('utf8')
  const signer = new SignedXml({
    privateKey: credential.privateKey,
    publicCert: credential.certificate,
    canonicalizationAlgorithm: C14N,
    signatureAlgorithm: RSA_SHA1,
  })
  signer.addReference({
    xpath: "//*[local-name(.)='infNFe']",
    transforms: [ENVELOPED, C14N],
    digestAlgorithm: SHA1,
  })
  signer.computeSignature(xml, {
    location: { reference: "//*[local-name(.)='infNFe']", action: 'after' },
  })
  return Buffer.from(signer.getSignedXml(), 'utf8')
}

export function verifyNfe55Signature(signedXml: Buffer, certificate: Buffer): Buffer {
  const xml = signedXml.toString('utf8')
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  const signatures = findSignatures(document)
  if (signatures.length !== 1) throw new Error('NF-e must contain exactly one XML signature')
  const verifier = new SignedXml({
    publicCert: certificate,
    getCertFromKeyInfo: () => null,
  })
  verifier.loadSignature(signatures[0] as Node)
  if (!verifier.checkSignature(xml)) throw new Error('NF-e XML signature is invalid')
  const references = verifier.getSignedReferences()
  if (references.length !== 1 || !references[0]?.includes('<infNFe'))
    throw new Error('NF-e signature did not authenticate infNFe')
  return Buffer.from(references[0], 'utf8')
}

function findSignatures(document: ReturnType<DOMParser['parseFromString']>): unknown[] {
  const nodes = document.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')
  return Array.from({ length: nodes.length }, (_, index) => nodes.item(index)).filter(
    (node) => node !== null,
  )
}
