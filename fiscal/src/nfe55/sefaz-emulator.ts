import { X509Certificate } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { DOMParser, type Element as XmlElement } from '@xmldom/xmldom'
import { certificateLegalEntityCnpj } from './icp-brasil-cnpj'
import { ufCodeOf } from './jurisdiction'
import {
  authorizerForUf,
  SEFAZ_HOMOLOGATION_ENDPOINTS,
  SEFAZ_SERVICES,
  type SefazAuthorizer,
  type SefazService,
} from './sefaz-authorizers'

const nfeNamespace = 'http://www.portalfiscal.inf.br/nfe'
const soapNamespace = 'http://www.w3.org/2003/05/soap-envelope'
const maximumRequestBytes = 2_000_000

/**
 * How the emulated authorizer treats one NF-e access key:
 * - `authorize`: receipt `103`, then `104` with protocol `100`;
 * - `reject`: receipt `103`, then `104` with the schema rejection `225`;
 * - `unreviewed`: receipt `103`, then `104` with `539`, a code the decision table leaves unknown;
 * - `lose-response`: the NF-e is authorized, but the connection closes before any reply;
 * - `unavailable`: HTTP 503 before anything is recorded.
 */
export type SefazEmulatorScenario =
  | 'authorize'
  | 'reject'
  | 'unreviewed'
  | 'lose-response'
  | 'unavailable'

export type SefazEmulatorRequest = {
  service: SefazService
  accessKey: string | null
  clientTaxId: string | null
}

type Outcome = { cStat: string; xMotivo: string; protocol: string | null; at: string }

/**
 * A local stand-in for one NF-e 4.00 authorizer in homologation. It answers the five
 * services at the official paths, requires a client certificate whose ICP-Brasil CNPJ
 * issued the document, and keeps just enough state for consultation and cancellation.
 * It exists for simulation environments: its responses have no fiscal value.
 */
export class SefazHomologationEmulator {
  readonly requests: SefazEmulatorRequest[] = []
  readonly #server: Server
  readonly #paths: Map<string, SefazService>
  readonly #hostname: string
  readonly #receipts = new Map<string, { accessKey: string; polls: number }>()
  readonly #outcomes = new Map<string, Outcome>()
  readonly #cancelled = new Map<string, string>()
  #sequence = 0

  constructor(
    readonly authorizer: SefazAuthorizer,
    tls: { certificate: Buffer; privateKey: Buffer },
    private readonly scenario: (accessKey: string) => SefazEmulatorScenario = () => 'authorize',
    private readonly options: { pendingPolls?: number; now?: () => Date } = {},
  ) {
    const endpoints = SEFAZ_HOMOLOGATION_ENDPOINTS[authorizer]
    this.#hostname = new URL(endpoints.authorization).hostname
    this.#paths = new Map(
      SEFAZ_SERVICES.map((service) => [
        new URL(endpoints[service]).pathname.toLowerCase(),
        service,
      ]),
    )
    this.#server = createServer(
      {
        cert: tls.certificate,
        key: tls.privateKey,
        // Test A1 certificates are not ICP-Brasil; the CNPJ inside them is checked instead.
        requestCert: true,
        rejectUnauthorized: false,
      },
      (request, response) => {
        void this.handle(request, response).catch(() => {
          if (!response.headersSent) response.writeHead(500)
          response.end()
        })
      },
    )
  }

  async listen(port = 0): Promise<{ host: '127.0.0.1'; port: number }> {
    await new Promise<void>((resolve) => this.#server.listen(port, '127.0.0.1', resolve))
    return { host: '127.0.0.1', port: (this.#server.address() as AddressInfo).port }
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections()
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }

  sent(service: SefazService, accessKey: string): number {
    return this.requests.filter(
      (request) => request.service === service && request.accessKey === accessKey,
    ).length
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const service = this.#paths.get((request.url ?? '').split('?')[0]?.toLowerCase() ?? '')
    const hostHeader = request.headers.host?.split(':')[0]
    const peer = (request.socket as TLSSocket).getPeerCertificate()
    if (request.method !== 'POST' || !service || hostHeader !== this.#hostname) {
      response.writeHead(404).end()
      return
    }
    if (!peer?.raw) {
      response.writeHead(403).end()
      return
    }
    const clientTaxId = certificateLegalEntityCnpj(new X509Certificate(peer.raw))
    const body = await readBody(request)
    const envelope = parse(body)
    const wrapper = soapWrapper(envelope)
    const payload = onlyChild(onlyChild(wrapper, 'nfeDadosMsg', wrapper.namespaceURI ?? ''))
    const accessKey = textOf(payload, 'chNFe') ?? accessKeyOfNfe(payload)
    this.requests.push({ service, accessKey, clientTaxId })
    const reply = (inner: string) => {
      const operation = wrapper.localName
      response.writeHead(200, { 'content-type': 'application/soap+xml; charset=utf-8' })
      response.end(
        `<soap:Envelope xmlns:soap="${soapNamespace}"><soap:Body>` +
          `<${operation}Response xmlns="${wrapper.namespaceURI}"><nfeResultMsg>${inner}` +
          `</nfeResultMsg></${operation}Response></soap:Body></soap:Envelope>`,
      )
    }
    if (service === 'status') {
      reply(this.status(requiredText(payload, 'cUF')))
      return
    }
    if (service === 'authorization') {
      const key = required(accessKey, 'chave de acesso')
      const scenario = this.scenario(key)
      if (scenario === 'unavailable') {
        response.writeHead(503).end()
        return
      }
      const ufCode = key.slice(0, 2)
      if (clientTaxId !== key.slice(6, 20)) {
        reply(
          `${this.header(
            'retEnviNFe',
            '4.00',
            ufCode,
            '213',
            'Rejeicao: CNPJ-Base do Emitente difere do CNPJ-Base do Certificado Digital',
          )}</retEnviNFe>`,
        )
        return
      }
      const receipt = this.number(`${ufCode}1`, 12)
      this.#receipts.set(receipt, { accessKey: key, polls: 0 })
      this.decide(key, scenario)
      if (scenario === 'lose-response') {
        request.socket.destroy()
        return
      }
      reply(
        this.header('retEnviNFe', '4.00', ufCode, '103', 'Lote recebido com sucesso') +
          `<infRec><nRec>${receipt}</nRec><tMed>1</tMed></infRec></retEnviNFe>`,
      )
      return
    }
    if (service === 'receipt') {
      const receipt = requiredText(payload, 'nRec')
      const lot = this.#receipts.get(receipt)
      if (!lot) {
        reply(
          `<retConsReciNFe xmlns="${nfeNamespace}" versao="4.00"><tpAmb>2</tpAmb>` +
            `<verAplic>${this.application}</verAplic><nRec>${receipt}</nRec><cStat>106</cStat>` +
            `<xMotivo>Lote nao localizado</xMotivo><cUF>${receipt.slice(0, 2)}</cUF>` +
            `<dhRecbto>${this.instant()}</dhRecbto></retConsReciNFe>`,
        )
        return
      }
      lot.polls += 1
      const prefix =
        `<retConsReciNFe xmlns="${nfeNamespace}" versao="4.00"><tpAmb>2</tpAmb>` +
        `<verAplic>${this.application}</verAplic><nRec>${receipt}</nRec>`
      const ufCode = lot.accessKey.slice(0, 2)
      if (lot.polls <= (this.options.pendingPolls ?? 0)) {
        reply(
          `${prefix}<cStat>105</cStat><xMotivo>Lote em processamento</xMotivo>` +
            `<cUF>${ufCode}</cUF><dhRecbto>${this.instant()}</dhRecbto></retConsReciNFe>`,
        )
        return
      }
      reply(
        `${prefix}<cStat>104</cStat><xMotivo>Lote processado</xMotivo><cUF>${ufCode}</cUF>` +
          `<dhRecbto>${this.instant()}</dhRecbto>${this.protocol(lot.accessKey)}</retConsReciNFe>`,
      )
      return
    }
    if (service === 'protocol') {
      const key = required(accessKey, 'chave de acesso')
      const outcome = this.#outcomes.get(key)
      const ufCode = key.slice(0, 2)
      if (outcome?.cStat !== '100') {
        reply(
          `${this.header(
            'retConsSitNFe',
            '4.00',
            ufCode,
            '217',
            'Rejeicao: NF-e nao consta na base de dados da SEFAZ',
          )}<chNFe>${key}</chNFe></retConsSitNFe>`,
        )
        return
      }
      const cancelled = this.#cancelled.has(key)
      reply(
        `${this.header(
          'retConsSitNFe',
          '4.00',
          ufCode,
          cancelled ? '101' : '100',
          cancelled ? 'Cancelamento de NF-e homologado' : 'Autorizado o uso da NF-e',
        )}<chNFe>${key}</chNFe>${this.protocol(key)}</retConsSitNFe>`,
      )
      return
    }
    reply(this.event(payload, clientTaxId))
  }

  private get application(): string {
    return `HORIZON-EMU-${this.authorizer}`
  }

  private decide(accessKey: string, scenario: SefazEmulatorScenario): void {
    if (this.#outcomes.has(accessKey)) return
    const at = this.instant()
    if (scenario === 'reject')
      this.#outcomes.set(accessKey, {
        cStat: '225',
        xMotivo: 'Rejeicao: Falha no Schema XML da NFe',
        protocol: null,
        at,
      })
    else if (scenario === 'unreviewed')
      this.#outcomes.set(accessKey, {
        cStat: '539',
        xMotivo: 'Rejeicao: Duplicidade de NF-e com diferenca na Chave de Acesso',
        protocol: null,
        at,
      })
    else
      this.#outcomes.set(accessKey, {
        cStat: '100',
        xMotivo: 'Autorizado o uso da NF-e',
        protocol: this.number(`1${accessKey.slice(0, 2)}26`, 10),
        at,
      })
  }

  private protocol(accessKey: string): string {
    const outcome = this.#outcomes.get(accessKey)
    if (!outcome) return ''
    return (
      `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>${this.application}</verAplic>` +
      `<chNFe>${accessKey}</chNFe><dhRecbto>${outcome.at}</dhRecbto>` +
      (outcome.protocol ? `<nProt>${outcome.protocol}</nProt>` : '') +
      `<cStat>${outcome.cStat}</cStat><xMotivo>${outcome.xMotivo}</xMotivo></infProt></protNFe>`
    )
  }

  private status(ufCode: string): string {
    const served = SEFAZ_UF_CODES_BY_AUTHORIZER[this.authorizer].includes(ufCode)
    return `${this.header(
      'retConsStatServ',
      '4.00',
      ufCode,
      served ? '107' : '252',
      served
        ? 'Servico em Operacao'
        : 'Rejeicao: Ambiente informado diverge do Ambiente de recebimento',
    )}</retConsStatServ>`
  }

  private event(payload: XmlElement, clientTaxId: string | null): string {
    const info = onlyChild(onlyChild(payload, 'evento', nfeNamespace), 'infEvento', nfeNamespace)
    const key = requiredText(info, 'chNFe')
    const orgao = requiredText(info, 'cOrgao')
    const lot = requiredText(payload, 'idLote')
    const detail = onlyChild(info, 'detEvento', nfeNamespace)
    const protocol = requiredText(detail, 'nProt')
    const outcome = this.#outcomes.get(key)
    const [cStat, xMotivo] =
      requiredText(info, 'tpEvento') !== '110111'
        ? ['490', 'Rejeicao: Tipo do evento nao permitido']
        : clientTaxId !== key.slice(6, 20)
          ? ['213', 'Rejeicao: CNPJ-Base do Autor difere do CNPJ-Base do Certificado Digital']
          : orgao !== key.slice(0, 2)
            ? ['250', 'Rejeicao: UF diverge da UF autorizadora']
            : outcome?.cStat !== '100' || outcome.protocol !== protocol
              ? ['222', 'Rejeicao: Protocolo de Autorizacao de Uso difere do cadastrado']
              : this.#cancelled.has(key)
                ? ['573', 'Rejeicao: Duplicidade de Evento']
                : ['135', 'Evento registrado e vinculado a NF-e']
    const eventProtocol = cStat === '135' ? this.number(`1${orgao}26`, 10) : null
    if (eventProtocol) this.#cancelled.set(key, eventProtocol)
    return (
      `<retEnvEvento xmlns="${nfeNamespace}" versao="1.00"><idLote>${lot}</idLote>` +
      `<tpAmb>2</tpAmb><verAplic>${this.application}</verAplic><cOrgao>${orgao}</cOrgao>` +
      '<cStat>128</cStat><xMotivo>Lote de Evento Processado</xMotivo>' +
      `<retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><verAplic>${this.application}</verAplic>` +
      `<cOrgao>${orgao}</cOrgao><cStat>${cStat}</cStat><xMotivo>${xMotivo}</xMotivo>` +
      `<chNFe>${key}</chNFe><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento>` +
      `<dhRegEvento>${this.instant()}</dhRegEvento>` +
      (eventProtocol ? `<nProt>${eventProtocol}</nProt>` : '') +
      '</infEvento></retEvento></retEnvEvento>'
    )
  }

  private header(root: string, version: string, ufCode: string, cStat: string, xMotivo: string) {
    return (
      `<${root} xmlns="${nfeNamespace}" versao="${version}"><tpAmb>2</tpAmb>` +
      `<verAplic>${this.application}</verAplic><cStat>${cStat}</cStat>` +
      `<xMotivo>${xMotivo}</xMotivo><cUF>${ufCode}</cUF><dhRecbto>${this.instant()}</dhRecbto>`
    )
  }

  private number(prefix: string, digits: number): string {
    this.#sequence += 1
    return `${prefix}${String(this.#sequence).padStart(digits, '0')}`
  }

  private instant(): string {
    const shifted = new Date((this.options.now?.() ?? new Date()).getTime() - 3 * 3_600_000)
    return `${shifted.toISOString().slice(0, 19)}-03:00`
  }
}

const SEFAZ_UF_CODES_BY_AUTHORIZER: Record<SefazAuthorizer, string[]> = (() => {
  const result = Object.fromEntries(
    Object.keys(SEFAZ_HOMOLOGATION_ENDPOINTS).map((authorizer) => [authorizer, [] as string[]]),
  ) as Record<SefazAuthorizer, string[]>
  for (const uf of [
    'RO',
    'AC',
    'AM',
    'RR',
    'PA',
    'AP',
    'TO',
    'MA',
    'PI',
    'CE',
    'RN',
    'PB',
    'PE',
    'AL',
    'SE',
    'BA',
    'MG',
    'ES',
    'RJ',
    'SP',
    'PR',
    'SC',
    'RS',
    'MS',
    'MT',
    'GO',
    'DF',
  ] as const)
    result[authorizerForUf(uf)].push(ufCodeOf(uf))
  return result
})()

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > maximumRequestBytes) throw new Error('SEFAZ emulator request is too large')
    parts.push(chunk as Buffer)
  }
  return Buffer.concat(parts)
}

function parse(bytes: Buffer): XmlElement {
  const errors: string[] = []
  const document = new DOMParser({
    onError: (_level, message) => errors.push(message),
  }).parseFromString(bytes.toString('utf8'), 'application/xml')
  if (errors.length > 0 || !document.documentElement)
    throw new Error('SEFAZ emulator request is malformed')
  return document.documentElement as unknown as XmlElement
}

function children(parent: XmlElement): XmlElement[] {
  const result: XmlElement[] = []
  for (let node = parent.firstChild; node; node = node.nextSibling)
    if (node.nodeType === 1) result.push(node as XmlElement)
  return result
}

function onlyChild(parent: XmlElement, name?: string, namespace?: string): XmlElement {
  const matches = children(parent).filter(
    (element) =>
      (!name || element.localName === name) && (!namespace || element.namespaceURI === namespace),
  )
  const [match] = matches
  if (matches.length !== 1 || !match) throw new Error('SEFAZ emulator request structure differs')
  return match
}

function soapWrapper(envelope: XmlElement): XmlElement {
  if (envelope.localName !== 'Envelope' || envelope.namespaceURI !== soapNamespace)
    throw new Error('SEFAZ emulator requires SOAP 1.2')
  return onlyChild(onlyChild(envelope, 'Body', soapNamespace))
}

function textOf(parent: XmlElement, name: string): string | null {
  const nodes = parent.getElementsByTagNameNS(nfeNamespace, name)
  return nodes.length === 1 ? (nodes.item(0)?.textContent?.trim() ?? null) : null
}

function requiredText(parent: XmlElement, name: string): string {
  return required(textOf(parent, name), name)
}

function required<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) throw new Error(`SEFAZ emulator request lacks ${name}`)
  return value
}

function accessKeyOfNfe(payload: XmlElement): string | null {
  const nodes = payload.getElementsByTagNameNS(nfeNamespace, 'infNFe')
  const id = nodes.length === 1 ? nodes.item(0)?.getAttribute('Id') : null
  return id?.startsWith('NFe') ? id.slice(3) : null
}
