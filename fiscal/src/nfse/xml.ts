import { tag } from '../nfe55/xml'
import { type NfseDpsData, nfseDpsDataSchema } from './model'

export const NFSE_NAMESPACE = 'http://www.sped.fazenda.gov.br/nfse'
export const NFSE_LAYOUT_VERSION = '1.01'

/**
 * Serializes stable UTF-8 DPS bytes (layout 1.01). It never states the ISSQN rate: a
 * provider outside the Simples Nacional in an active municipality leaves `pAliq` to the
 * municipal parameter (E0617), and the national system computes the tax.
 */
export function serializeDps(candidate: unknown): Buffer {
  const value = nfseDpsDataSchema.parse(candidate)
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<DPS xmlns="${NFSE_NAMESPACE}" versao="${NFSE_LAYOUT_VERSION}">`,
    infDps(value),
    '</DPS>',
  ].join('')
  return Buffer.from(body, 'utf8')
}

/** The `infDPS` element, also embedded unchanged in the generated NFS-e. */
export function infDps(value: NfseDpsData): string {
  return [
    `<infDPS Id="${value.dpsId}">`,
    tag('tpAmb', value.environment),
    tag('dhEmi', value.issuedAt),
    tag('verAplic', value.applicationVersion),
    tag('serie', String(value.series)),
    tag('nDPS', String(value.number)),
    tag('dCompet', value.competenceDate),
    tag('tpEmit', '1'),
    tag('cLocEmi', value.issuingMunicipality),
    value.substitution
      ? [
          '<subst>',
          tag('chSubstda', value.substitution.replacedKey),
          tag('cMotivo', value.substitution.reasonCode),
          value.substitution.reason ? tag('xMotivo', value.substitution.reason) : '',
          '</subst>',
        ].join('')
      : '',
    '<prest>',
    tag('CNPJ', value.provider.cnpj),
    value.provider.municipalRegistration ? tag('IM', value.provider.municipalRegistration) : '',
    '<regTrib>',
    tag('opSimpNac', value.provider.simplesOption),
    tag('regEspTrib', value.provider.specialRegime),
    '</regTrib>',
    '</prest>',
    '<toma>',
    tag(value.recipient.kind === 'cpf' ? 'CPF' : 'CNPJ', value.recipient.taxId),
    tag('xNome', value.recipient.name),
    '<end>',
    '<endNac>',
    tag('cMun', value.recipient.address.municipalityCode),
    tag('CEP', value.recipient.address.postalCode),
    '</endNac>',
    tag('xLgr', value.recipient.address.street),
    tag('nro', value.recipient.address.number),
    value.recipient.address.complement ? tag('xCpl', value.recipient.address.complement) : '',
    tag('xBairro', value.recipient.address.district),
    '</end>',
    '</toma>',
    '<serv>',
    '<locPrest>',
    tag('cLocPrestacao', value.service.placeMunicipality),
    '</locPrest>',
    '<cServ>',
    tag('cTribNac', value.service.nationalTaxCode),
    value.service.municipalTaxCode ? tag('cTribMun', value.service.municipalTaxCode) : '',
    tag('xDescServ', value.service.description),
    tag('cNBS', value.service.nbsCode),
    '</cServ>',
    '</serv>',
    '<valores>',
    '<vServPrest>',
    tag('vServ', value.values.serviceAmount),
    '</vServPrest>',
    '<trib>',
    '<tribMun>',
    tag('tribISSQN', value.values.issTaxation),
    tag('tpRetISSQN', value.values.withholding),
    '</tribMun>',
    '<totTrib>',
    tag('indTotTrib', '0'),
    '</totTrib>',
    '</trib>',
    '</valores>',
    '<IBSCBS>',
    tag('finNFSe', value.ibsCbs.purpose),
    tag('cIndOp', value.ibsCbs.operationIndicator),
    tag('indDest', value.ibsCbs.destination),
    '<valores>',
    '<trib>',
    '<gIBSCBS>',
    tag('CST', value.ibsCbs.cst),
    tag('cClassTrib', value.ibsCbs.classification),
    '</gIBSCBS>',
    '</trib>',
    '</valores>',
    '</IBSCBS>',
    '</infDPS>',
  ].join('')
}
