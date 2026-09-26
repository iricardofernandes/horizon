import type { BrazilianUf } from './jurisdiction'

export type SefazService = 'authorization' | 'receipt' | 'protocol' | 'status' | 'event'
export type SefazEndpoints = Record<SefazService, string>

export type SefazAuthorizer =
  | 'AM'
  | 'BA'
  | 'GO'
  | 'MG'
  | 'MS'
  | 'MT'
  | 'PE'
  | 'PR'
  | 'RS'
  | 'SP'
  | 'SVAN'
  | 'SVRS'

/**
 * Official NF-e 4.00 homologation service list and UF-to-authorizer relation, read on
 * 2026-09-26. Both pages are dynamic HTML, so their digests identify the retrieval,
 * not a stable source pin. `?wsdl` suffixes published for GO, MT, PE and PR are
 * description URLs; the SOAP endpoint is the same path without the query.
 */
export const SEFAZ_AUTHORIZER_SOURCES = {
  homologationServiceList: {
    uri: 'https://hom.nfe.fazenda.gov.br/portal/webServices.aspx?tipoConteudo=VjrjMInPXGA%3D',
    retrievedAt: '2026-09-26T14:05:00-03:00',
    sha256: 'cbc90bbc79807221e4804a1975be2c6c0bb5becd038f9c6ef1e83988870e6aec',
  },
  authorizerRelation: {
    uri: 'https://www.nfe.fazenda.gov.br/portal/webServices.aspx',
    retrievedAt: '2026-09-26T14:08:00-03:00',
  },
} as const

const SVRS_STATES: readonly BrazilianUf[] = [
  'AC',
  'AL',
  'AP',
  'CE',
  'DF',
  'ES',
  'PA',
  'PB',
  'PI',
  'RJ',
  'RN',
  'RO',
  'RR',
  'SC',
  'SE',
  'TO',
]

const OWN_AUTHORIZERS: readonly BrazilianUf[] = [
  'AM',
  'BA',
  'GO',
  'MG',
  'MS',
  'MT',
  'PE',
  'PR',
  'RS',
  'SP',
]

export function authorizerForUf(uf: BrazilianUf): SefazAuthorizer {
  if (uf === 'MA') return 'SVAN'
  if (SVRS_STATES.includes(uf)) return 'SVRS'
  if (OWN_AUTHORIZERS.includes(uf)) return uf as SefazAuthorizer
  throw new Error('UF has no NF-e authorizer in the reviewed relation')
}

export const SEFAZ_HOMOLOGATION_ENDPOINTS: Record<SefazAuthorizer, SefazEndpoints> = {
  AM: {
    authorization: 'https://homnfe.sefaz.am.gov.br/services2/services/NfeAutorizacao4',
    receipt: 'https://homnfe.sefaz.am.gov.br/services2/services/NfeRetAutorizacao4',
    protocol: 'https://homnfe.sefaz.am.gov.br/services2/services/NfeConsulta4',
    status: 'https://homnfe.sefaz.am.gov.br/services2/services/NfeStatusServico4',
    event: 'https://homnfe.sefaz.am.gov.br/services2/services/RecepcaoEvento4',
  },
  BA: {
    authorization: 'https://hnfe.sefaz.ba.gov.br/webservices/NFeAutorizacao4/NFeAutorizacao4.asmx',
    receipt: 'https://hnfe.sefaz.ba.gov.br/webservices/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx',
    protocol:
      'https://hnfe.sefaz.ba.gov.br/webservices/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx',
    status: 'https://hnfe.sefaz.ba.gov.br/webservices/NFeStatusServico4/NFeStatusServico4.asmx',
    event: 'https://hnfe.sefaz.ba.gov.br/webservices/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
  },
  GO: {
    authorization: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeAutorizacao4',
    receipt: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeRetAutorizacao4',
    protocol: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeConsultaProtocolo4',
    status: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeStatusServico4',
    event: 'https://homolog.sefaz.go.gov.br/nfe/services/NFeRecepcaoEvento4',
  },
  MG: {
    authorization: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeAutorizacao4',
    receipt: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeRetAutorizacao4',
    protocol: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeConsultaProtocolo4',
    status: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeStatusServico4',
    event: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeRecepcaoEvento4',
  },
  MS: {
    authorization: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeAutorizacao4',
    receipt: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeRetAutorizacao4',
    protocol: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeConsultaProtocolo4',
    status: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeStatusServico4',
    event: 'https://hom.nfe.sefaz.ms.gov.br/ws/NFeRecepcaoEvento4',
  },
  MT: {
    authorization: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeAutorizacao4',
    receipt: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeRetAutorizacao4',
    protocol: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeConsulta4',
    status: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeStatusServico4',
    event: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/RecepcaoEvento4',
  },
  PE: {
    authorization: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeAutorizacao4',
    receipt: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeRetAutorizacao4',
    protocol: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeConsultaProtocolo4',
    status: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeStatusServico4',
    event: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeRecepcaoEvento4',
  },
  PR: {
    authorization: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeAutorizacao4',
    receipt: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeRetAutorizacao4',
    protocol: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeConsultaProtocolo4',
    status: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeStatusServico4',
    event: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeRecepcaoEvento4',
  },
  RS: {
    authorization:
      'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
    receipt:
      'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
    protocol: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
    status: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
    event: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
  },
  SP: {
    authorization: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx',
    receipt: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx',
    protocol: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx',
    status: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx',
    event: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx',
  },
  SVAN: {
    authorization: 'https://hom.sefazvirtual.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx',
    receipt: 'https://hom.sefazvirtual.fazenda.gov.br/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx',
    protocol:
      'https://hom.sefazvirtual.fazenda.gov.br/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx',
    status: 'https://hom.sefazvirtual.fazenda.gov.br/NFeStatusServico4/NFeStatusServico4.asmx',
    event: 'https://hom.sefazvirtual.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
  },
  SVRS: {
    authorization: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
    receipt: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
    protocol: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
    status: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
    event: 'https://nfe-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
  },
}

export const SEFAZ_SERVICES: readonly SefazService[] = [
  'authorization',
  'receipt',
  'protocol',
  'status',
  'event',
]

/** Returns the authorizer whose reviewed homologation set equals these exact URLs. */
export function authorizerOfEndpoints(endpoints: SefazEndpoints): SefazAuthorizer {
  const match = (Object.keys(SEFAZ_HOMOLOGATION_ENDPOINTS) as SefazAuthorizer[]).find(
    (authorizer) =>
      SEFAZ_SERVICES.every(
        (service) =>
          normalized(endpoints[service]) ===
          normalized(SEFAZ_HOMOLOGATION_ENDPOINTS[authorizer][service]),
      ),
  )
  if (!match) throw new Error('Unapproved SEFAZ homologation endpoint set')
  return match
}

/** One adapter version per authorizer keeps persisted SP bindings unchanged. */
export function homologationAdapterVersion(authorizer: SefazAuthorizer): string {
  return `nfe55-${authorizer.toLowerCase()}-homologation-v1`
}

function normalized(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Unapproved SEFAZ homologation endpoint')
  return `${url.hostname}${url.pathname.toLowerCase()}`
}
