import { SignedXml } from 'xml-crypto'
import type { SimulationCredential } from '../nfe55/signature'

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'
const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1'
const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1'

/**
 * Signs `infNFe` like model 55, but the Signature element follows `infNFeSupl`: the QR
 * code group is supplementary and not covered by the signature (NT 2015.002 ZX01).
 */
export function signNfce65(unsignedXml: Buffer, credential: SimulationCredential): Buffer {
  if (credential.privateKey.length === 0 || credential.certificate.length === 0)
    throw new Error('Simulation signing credential is incomplete')
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
  signer.computeSignature(unsignedXml.toString('utf8'), {
    location: { reference: "//*[local-name(.)='infNFeSupl']", action: 'after' },
  })
  return Buffer.from(signer.getSignedXml(), 'utf8')
}
