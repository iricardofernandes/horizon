import { z } from 'zod'
import { tag } from '../nfe55/xml'
import { isNfseKey } from './identifiers'
import { NFSE_LAYOUT_VERSION, NFSE_NAMESPACE } from './xml'

export const NFSE_CANCELLATION_EVENT = '101101'

const cancellationSchema = z.strictObject({
  nfseKey: z.string().refine(isNfseKey, 'invalid NFS-e access key'),
  authorCnpj: z.string().regex(/^\d{14}$/),
  occurredAt: z.string().regex(/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:00$/),
  applicationVersion: z.string().min(1).max(20),
  reasonCode: z.enum(['1', '2', '9']),
  reason: z.string().trim().min(15).max(255),
})

/** `pedRegEvento` 1.01 for event 101101 (Anexo II): `PRE` + key + event type. */
export function serializeCancellationRequest(candidate: unknown): Buffer {
  const value = cancellationSchema.parse(candidate)
  return Buffer.from(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<pedRegEvento xmlns="${NFSE_NAMESPACE}" versao="${NFSE_LAYOUT_VERSION}">`,
      `<infPedReg Id="PRE${value.nfseKey}${NFSE_CANCELLATION_EVENT}">`,
      tag('tpAmb', '2'),
      tag('verAplic', value.applicationVersion),
      tag('dhEvento', value.occurredAt),
      tag('CNPJAutor', value.authorCnpj),
      tag('chNFSe', value.nfseKey),
      `<e${NFSE_CANCELLATION_EVENT}>`,
      tag('xDesc', 'Cancelamento de NFS-e'),
      tag('cMotivo', value.reasonCode),
      tag('xMotivo', value.reason),
      `</e${NFSE_CANCELLATION_EVENT}>`,
      '</infPedReg>',
      '</pedRegEvento>',
    ].join(''),
    'utf8',
  )
}
