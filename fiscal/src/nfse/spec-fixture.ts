import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { SimulationCredential } from '../nfe55/signature'
import { buildDpsId } from './identifiers'
import type { NfseDpsData } from './model'

export const NFSE_SCHEMA_PATH = join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'official',
  'nfse-xsd-v1.01-20260209.zip',
)

export const PROVIDER_CNPJ = '11222333000181'

/** A frozen DPS used by the NFS-e specs: São Paulo, software development. */
export function dpsFixture(overrides: Partial<NfseDpsData> = {}): NfseDpsData {
  const series = overrides.series ?? 1
  const number = overrides.number ?? 1
  return {
    dpsId: buildDpsId({ municipalityCode: '3550308', cnpj: PROVIDER_CNPJ, series, number }),
    environment: '2',
    issuedAt: '2026-09-26T10:15:00-03:00',
    applicationVersion: 'horizon-phase47',
    series,
    number,
    competenceDate: '2026-09-01',
    issuingMunicipality: '3550308',
    provider: {
      cnpj: PROVIDER_CNPJ,
      municipalRegistration: null,
      simplesOption: '1',
      specialRegime: '0',
    },
    recipient: {
      kind: 'cnpj',
      taxId: '44555666000105',
      name: 'Cliente de Serviços Ltda',
      address: {
        municipalityCode: '3550308',
        postalCode: '01310100',
        street: 'Avenida Paulista',
        number: '1000',
        complement: 'Conjunto 101',
        district: 'Bela Vista',
      },
    },
    service: {
      placeMunicipality: '3550308',
      nationalTaxCode: '010101',
      municipalTaxCode: null,
      description: 'Desenvolvimento de sistema sob medida',
      nbsCode: '115022000',
    },
    values: { serviceAmount: '1500.00', issTaxation: '1', withholding: '1' },
    substitution: null,
    ibsCbs: {
      purpose: '0',
      operationIndicator: '100301',
      destination: '0',
      cst: '000',
      classification: '000001',
    },
    ...overrides,
  }
}

/** A throwaway self-signed credential; never an ICP-Brasil certificate. */
export async function simulationCredential(): Promise<{
  credential: SimulationCredential
  dispose: () => Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'horizon-phase47-credential-'))
  const keyPath = join(directory, 'simulation-only.key.pem')
  const certificatePath = join(directory, 'simulation-only.cert.pem')
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    '1',
    '-subj',
    '/CN=Horizon Phase 47 Simulation Only',
    '-keyout',
    keyPath,
    '-out',
    certificatePath,
  ])
  const credential = {
    privateKey: await readFile(keyPath),
    certificate: await readFile(certificatePath),
  }
  return { credential, dispose: () => rm(directory, { recursive: true, force: true }) }
}
