import { z } from 'zod'
import { isValidNfeAccessKey } from './access-key'
import { ufOfCode } from './jurisdiction'

const namespace = 'http://www.portalfiscal.inf.br/nfe'

/**
 * The condition of use every correction letter must carry, verbatim and without accents,
 * as the event layout fixes it (Convênio S/N de 1970, art. 7º, § 1º-A).
 */
export const CORRECTION_LETTER_CONDITION =
  'A Carta de Correcao e disciplinada pelo paragrafo 1o-A do art. 7o do Convenio S/N, de 15 de dezembro de 1970 e pode ser utilizada para regularizacao de erro ocorrido na emissao de documento fiscal, desde que o erro nao esteja relacionado com: I - as variaveis que determinam o valor do imposto tais como: base de calculo, aliquota, diferenca de preco, quantidade, valor da operacao ou da prestacao; II - a correcao de dados cadastrais que implique mudanca do remetente ou do destinatario; III - a data de emissao ou de saida.'

const eventSchema = z.strictObject({
  accessKey: z.string().regex(/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/),
  sequence: z.number().int().min(1).max(20),
  text: z.string().trim().min(15).max(1000),
  occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/),
  lotId: z.string().regex(/^[0-9]{1,15}$/),
})

/**
 * Event 110110. The PL 010d envelope skips `detEvento`'s children, so their rules are
 * checked here: the description, the correction text length and the fixed condition.
 */
export function serializeCorrectionLetterEvent(input: z.input<typeof eventSchema>): Buffer {
  const value = eventSchema.parse(input)
  if (!Number.isFinite(Date.parse(value.occurredAt)))
    throw new Error('Invalid correction letter instant')
  const ufCode = value.accessKey.slice(0, 2)
  try {
    ufOfCode(ufCode)
  } catch {
    throw new Error('Unsupported correction letter jurisdiction')
  }
  if (!isValidNfeAccessKey(value.accessKey)) throw new Error('Invalid correction letter key')
  const sequence = String(value.sequence).padStart(2, '0')
  const eventId = `ID110110${value.accessKey}${sequence}`
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><envEvento xmlns="${namespace}" versao="1.00">` +
      `<idLote>${value.lotId}</idLote><evento versao="1.00"><infEvento Id="${eventId}">` +
      `<cOrgao>${ufCode}</cOrgao><tpAmb>2</tpAmb><CNPJ>${value.accessKey.slice(6, 20)}</CNPJ>` +
      `<chNFe>${value.accessKey}</chNFe><dhEvento>${value.occurredAt}</dhEvento>` +
      `<tpEvento>110110</tpEvento><nSeqEvento>${value.sequence}</nSeqEvento>` +
      '<verEvento>1.00</verEvento><detEvento versao="1.00">' +
      '<descEvento>Carta de Correcao</descEvento>' +
      `<xCorrecao>${escapeXml(value.text)}</xCorrecao>` +
      `<xCondUso>${CORRECTION_LETTER_CONDITION}</xCondUso>` +
      '</detEvento></infEvento></evento></envEvento>',
    'utf8',
  )
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
