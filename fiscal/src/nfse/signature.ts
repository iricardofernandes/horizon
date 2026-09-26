import { DOMParser } from '@xmldom/xmldom'
import { SignedXml } from 'xml-crypto'
import type { SimulationCredential } from '../nfe55/signature'

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'
/**
 * The pinned xmldsig schema does not fix the algorithms and the national Swagger is not
 * retrievable without a certificate, so SHA-256 is Horizon's simulation choice. The
 * restricted-production gate must confirm it.
 */
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256'

export type NfseSignedElement = 'infDPS' | 'infPedReg' | 'infNFSe' | 'infEvento'

/** Signs one `Id`-bearing element, enveloped, with the signature right after it. */
export function signNfseElement(
  unsignedXml: Buffer,
  element: NfseSignedElement,
  credential: SimulationCredential,
): Buffer {
  if (credential.privateKey.length === 0 || credential.certificate.length === 0)
    throw new Error('NFS-e signing credential is incomplete')
  const signer = new SignedXml({
    privateKey: credential.privateKey,
    publicCert: credential.certificate,
    canonicalizationAlgorithm: C14N,
    signatureAlgorithm: RSA_SHA256,
  })
  const xpath = `//*[local-name(.)='${element}']`
  signer.addReference({ xpath, transforms: [ENVELOPED, C14N], digestAlgorithm: SHA256 })
  signer.computeSignature(unsignedXml.toString('utf8'), {
    location: { reference: xpath, action: 'after' },
  })
  return Buffer.from(signer.getSignedXml(), 'utf8')
}

/**
 * Verifies the one signature placed right after `element` and returns the canonical
 * bytes it authenticated. Other signatures (the DPS inside an NFS-e) are ignored.
 */
export function verifyNfseElement(
  signedXml: Buffer,
  element: NfseSignedElement,
  certificate: Buffer,
): Buffer {
  const xml = signedXml.toString('utf8')
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  const signed = document.getElementsByTagName(element).item(0)
  const signature = signed?.nextSibling
  if (
    !signed ||
    !signature ||
    signature.nodeType !== 1 ||
    (signature as unknown as Element).localName !== 'Signature'
  )
    throw new Error(`NFS-e ${element} signature is missing`)
  const verifier = new SignedXml({ publicCert: certificate, getCertFromKeyInfo: () => null })
  verifier.loadSignature(signature as unknown as Node)
  if (!verifier.checkSignature(xml)) throw new Error(`NFS-e ${element} signature is invalid`)
  const references = verifier.getSignedReferences()
  if (references.length !== 1 || !references[0]?.includes(`<${element}`))
    throw new Error(`NFS-e signature did not authenticate ${element}`)
  return Buffer.from(references[0], 'utf8')
}
