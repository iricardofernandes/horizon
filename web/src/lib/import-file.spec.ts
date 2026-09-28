import { describe, expect, it } from 'vitest'
import {
  addsUp,
  csvText,
  formatOf,
  importingModules,
  isFinished,
  jobKeyOf,
  MAX_IMPORT_BYTES,
  percentDone,
  uploadBody,
} from './import-file'

const progress = { total: 10, valid: 8, written: 5, failed: 3, remaining: 2, cancelled: 0 }

describe('who imports', () => {
  it('offers only the modules the user administers', () => {
    expect(
      importingModules([
        { module: 'parties', role: 'admin' },
        { module: 'catalog', role: 'editor' },
        { module: 'financial', role: 'admin' },
        { module: 'sales', role: 'admin' },
      ]),
    ).toEqual(['parties', 'financial'])
  })
})

describe('the upload', () => {
  it('knows a CSV and an XLSX by name, and nothing else', () => {
    expect(formatOf('Clientes.CSV')).toBe('csv')
    expect(formatOf('itens.xlsx')).toBe('xlsx')
    expect(formatOf('itens.xls')).toBeNull()
    expect(formatOf('notes')).toBeNull()
  })

  it('reads a Windows-1252 CSV without losing its accents', () => {
    expect(csvText(new Uint8Array([0x53, 0xe3, 0x6f]))).toBe('São')
    expect(csvText(new TextEncoder().encode('São'))).toBe('São')
  })

  it('sends a CSV as text and an XLSX as base64, and refuses an empty or huge file', () => {
    expect(uploadBody('a.csv', new TextEncoder().encode('x;y'), 'pt-BR')).toEqual({
      fileName: 'a.csv',
      format: 'csv',
      locale: 'pt-BR',
      content: 'x;y',
    })
    expect(uploadBody('a.xlsx', new Uint8Array([80, 75, 3, 4]), 'en')?.content).toBe('UEsDBA==')
    expect(uploadBody('a.csv', new Uint8Array(), 'en')).toBeNull()
    expect(uploadBody('a.csv', new Uint8Array(MAX_IMPORT_BYTES + 1), 'en')).toBeNull()
    expect(uploadBody('a.ods', new Uint8Array([1]), 'en')).toBeNull()
  })

  it('keys the job by the kind and the bytes', async () => {
    const bytes = new TextEncoder().encode('a;b')
    const key = await jobKeyOf('parties', bytes)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(await jobKeyOf('parties', bytes)).toBe(key)
    expect(await jobKeyOf('items', bytes)).not.toBe(key)
  })
})

describe('progress', () => {
  it('reads how far a job is and whether it ended', () => {
    expect(percentDone(progress)).toBe(80)
    expect(percentDone({ ...progress, total: 0 })).toBe(100)
    expect(isFinished('running')).toBe(false)
    expect(isFinished('completed-with-failures')).toBe(true)
  })

  it('knows counts that add up from counts that do not', () => {
    expect(addsUp(progress)).toBe(true)
    expect(addsUp({ ...progress, remaining: 1 })).toBe(false)
  })
})
