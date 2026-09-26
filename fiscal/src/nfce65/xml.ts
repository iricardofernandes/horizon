import { address, line, tag, totals } from '../nfe55/xml'
import { type Nfce65Data, nfce65DataSchema } from './model'

const NFE_NAMESPACE = 'http://www.portalfiscal.inf.br/nfe'

/**
 * Serializes stable UTF-8 NFC-e 4.00 bytes (PL 010f, model 65). It never calculates tax
 * amounts. `infNFeSupl` follows `infNFe` and stays outside the signed reference.
 */
export function serializeNfce65(candidate: unknown): Buffer {
  const value = nfce65DataSchema.parse(candidate)
  const keyDigit = value.accessKey.at(-1)
  if (!keyDigit) throw new Error('NFC-e access key is incomplete')
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<NFe xmlns="${NFE_NAMESPACE}">`,
    `<infNFe Id="NFe${value.accessKey}" versao="4.00">`,
    identification(value, keyDigit),
    '<emit>',
    tag('CNPJ', value.issuer.taxId),
    tag('xNome', value.issuer.legalName),
    address('enderEmit', value.issuer.address),
    tag('IE', value.issuer.stateRegistration),
    tag('CRT', '3'),
    '</emit>',
    consumer(value.consumer),
    ...value.lines.map(line),
    totals(value),
    '<transp><modFrete>9</modFrete></transp>',
    payment(value.payment),
    '</infNFe>',
    '<infNFeSupl>',
    tag('qrCode', value.supplement.qrCode),
    tag('urlChave', value.supplement.keyQueryUrl),
    '</infNFeSupl>',
    '</NFe>',
  ].join('')
  return Buffer.from(body, 'utf8')
}

function identification(value: Nfce65Data, keyDigit: string): string {
  return [
    '<ide>',
    tag('cUF', value.accessKey.slice(0, 2)),
    tag('cNF', value.numericCode),
    tag('natOp', value.natureOperation),
    tag('mod', '65'),
    tag('serie', String(value.series)),
    tag('nNF', String(value.number)),
    tag('dhEmi', value.issuedAt),
    tag('tpNF', '1'),
    tag('idDest', '1'),
    tag('cMunFG', value.issuer.address.municipalityCode),
    // 4 = DANFE NFC-e
    tag('tpImp', '4'),
    tag('tpEmis', '1'),
    tag('cDV', keyDigit),
    tag('tpAmb', value.environment),
    tag('finNFe', '1'),
    tag('indFinal', '1'),
    tag('indPres', value.presence),
    // A home delivery states that no intermediary platform took part.
    ...(value.presence === '4' ? [tag('indIntermed', '0')] : []),
    tag('procEmi', '0'),
    tag('verProc', value.processVersion),
    '</ide>',
  ].join('')
}

function consumer(value: Nfce65Data['consumer']): string {
  if (!value) return ''
  return [
    '<dest>',
    tag(value.kind === 'cpf' ? 'CPF' : 'CNPJ', value.taxId),
    tag('xNome', value.name),
    ...(value.address ? [address('enderDest', value.address)] : []),
    // 9 = non-contributor: an NFC-e never carries the consumer's IE.
    tag('indIEDest', '9'),
    '</dest>',
  ].join('')
}

function payment(value: Nfce65Data['payment']): string {
  return [
    '<pag><detPag>',
    tag('indPag', value.indicator),
    tag('tPag', value.method),
    tag('vPag', value.amount),
    '</detPag></pag>',
  ].join('')
}
