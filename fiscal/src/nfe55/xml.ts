import { type Nfe55Data, nfe55DataSchema } from './model'

const NFE_NAMESPACE = 'http://www.portalfiscal.inf.br/nfe'

/** Serializes stable UTF-8 NF-e 4.00 bytes. It never calculates tax amounts. */
export function serializeNfe55(candidate: unknown): Buffer {
  const value = nfe55DataSchema.parse(candidate)
  const keyDigit = value.accessKey.at(-1)
  if (!keyDigit) throw new Error('NF-e access key is incomplete')
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<NFe xmlns="${NFE_NAMESPACE}">`,
    `<infNFe Id="NFe${value.accessKey}" versao="4.00">`,
    '<ide>',
    tag('cUF', value.accessKey.slice(0, 2)),
    tag('cNF', value.numericCode),
    tag('natOp', value.natureOperation),
    tag('mod', '55'),
    tag('serie', String(value.series)),
    tag('nNF', String(value.number)),
    tag('dhEmi', value.issuedAt),
    tag('tpNF', '1'),
    tag('idDest', '1'),
    tag('cMunFG', value.issuer.address.municipalityCode),
    tag('tpImp', '1'),
    tag('tpEmis', '1'),
    tag('cDV', keyDigit),
    tag('tpAmb', '2'),
    tag('finNFe', '1'),
    tag('indFinal', '0'),
    tag('indPres', '1'),
    tag('procEmi', '0'),
    tag('verProc', 'horizon-phase42'),
    '</ide>',
    '<emit>',
    tag('CNPJ', value.issuer.taxId),
    tag('xNome', value.issuer.legalName),
    address('enderEmit', value.issuer.address),
    tag('IE', value.issuer.stateRegistration),
    tag('CRT', '3'),
    '</emit>',
    '<dest>',
    tag('CNPJ', value.recipient.taxId),
    tag('xNome', value.recipient.legalName),
    address('enderDest', value.recipient.address),
    tag('indIEDest', '1'),
    tag('IE', value.recipient.stateRegistration),
    '</dest>',
    ...value.lines.map(line),
    totals(value),
    '<transp><modFrete>9</modFrete></transp>',
    '<pag><detPag><tPag>90</tPag><vPag>0.00</vPag></detPag></pag>',
    '</infNFe>',
    '</NFe>',
  ].join('')
  return Buffer.from(body, 'utf8')
}

function line(value: Nfe55Data['lines'][number]): string {
  return [
    `<det nItem="${value.number}">`,
    '<prod>',
    tag('cProd', value.productCode),
    tag('cEAN', 'SEM GTIN'),
    tag('xProd', value.description),
    tag('NCM', value.ncm),
    tag('CFOP', value.cfop),
    tag('uCom', value.unit),
    tag('qCom', value.quantity),
    tag('vUnCom', value.unitPrice),
    tag('vProd', value.gross),
    tag('cEANTrib', 'SEM GTIN'),
    tag('uTrib', value.unit),
    tag('qTrib', value.quantity),
    tag('vUnTrib', value.unitPrice),
    ...(value.discount === '0.00' ? [] : [tag('vDesc', value.discount)]),
    ...(value.other === '0.00' ? [] : [tag('vOutro', value.other)]),
    tag('indTot', '1'),
    '</prod>',
    '<imposto><IBSCBS>',
    tag('CST', value.ibsCbs.cst),
    tag('cClassTrib', value.ibsCbs.classification),
    '<gIBSCBS>',
    tag('vBC', value.ibsCbs.base),
    '<gIBSUF>',
    tag('pIBSUF', value.ibsCbs.ibsUfRate),
    tag('vIBSUF', value.ibsCbs.ibsUfValue),
    '</gIBSUF>',
    '<gIBSMun>',
    tag('pIBSMun', value.ibsCbs.ibsMunicipalRate),
    tag('vIBSMun', value.ibsCbs.ibsMunicipalValue),
    '</gIBSMun>',
    tag('vIBS', addDecimal(value.ibsCbs.ibsUfValue, value.ibsCbs.ibsMunicipalValue)),
    '<gCBS>',
    tag('pCBS', value.ibsCbs.cbsRate),
    tag('vCBS', value.ibsCbs.cbsValue),
    '</gCBS>',
    '</gIBSCBS>',
    '</IBSCBS></imposto>',
    '</det>',
  ].join('')
}

function totals(value: Nfe55Data): string {
  const t = value.totals
  return [
    '<total><ICMSTot>',
    tag('vBC', '0.00'),
    tag('vICMS', '0.00'),
    tag('vICMSDeson', '0.00'),
    tag('vFCP', '0.00'),
    tag('vBCST', '0.00'),
    tag('vST', '0.00'),
    tag('vFCPST', '0.00'),
    tag('vFCPSTRet', '0.00'),
    tag('vProd', t.products),
    tag('vFrete', '0.00'),
    tag('vSeg', '0.00'),
    tag('vDesc', t.discounts),
    tag('vII', '0.00'),
    tag('vIPI', '0.00'),
    tag('vIPIDevol', '0.00'),
    tag('vPIS', '0.00'),
    tag('vCOFINS', '0.00'),
    tag('vOutro', t.other),
    tag('vNF', t.invoice),
    '</ICMSTot>',
    '<IBSCBSTot>',
    tag('vBCIBSCBS', t.ibsCbsBase),
    '<gIBS><gIBSUF>',
    tag('vDif', '0.00'),
    tag('vDevTrib', '0.00'),
    tag('vIBSUF', t.ibsUf),
    '</gIBSUF><gIBSMun>',
    tag('vDif', '0.00'),
    tag('vDevTrib', '0.00'),
    tag('vIBSMun', t.ibsMunicipal),
    '</gIBSMun>',
    tag('vIBS', t.ibs),
    tag('vCredPres', '0.00'),
    tag('vCredPresCondSus', '0.00'),
    '</gIBS><gCBS>',
    tag('vDif', '0.00'),
    tag('vDevTrib', '0.00'),
    tag('vCBS', t.cbs),
    tag('vCredPres', '0.00'),
    tag('vCredPresCondSus', '0.00'),
    '</gCBS>',
    '</IBSCBSTot>',
    tag('vNFTot', t.invoiceWithIbsCbs),
    '</total>',
  ].join('')
}

function address(name: string, value: Nfe55Data['issuer']['address']): string {
  return [
    `<${name}>`,
    tag('xLgr', value.street),
    tag('nro', value.number),
    ...(value.complement ? [tag('xCpl', value.complement)] : []),
    tag('xBairro', value.district),
    tag('cMun', value.municipalityCode),
    tag('xMun', value.city),
    tag('UF', value.state),
    tag('CEP', value.postalCode),
    tag('cPais', '1058'),
    tag('xPais', 'Brasil'),
    `</${name}>`,
  ].join('')
}

function tag(name: string, value: string): string {
  return `<${name}>${escapeXml(value)}</${name}>`
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function addDecimal(left: string, right: string): string {
  const minor = (value: string) => BigInt(value.replace('.', ''))
  const sum = minor(left) + minor(right)
  return `${sum / 100n}.${(sum % 100n).toString().padStart(2, '0')}`
}
