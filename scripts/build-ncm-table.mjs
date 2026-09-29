#!/usr/bin/env node
/**
 * The official NCM table as `knowledge/` embeds it (Phase 77): public data, the same for
 * every workspace. From the Siscomex public download, it keeps each 8-digit code in force,
 * described with its heading and subheadings, so "-- Outros" still says what it is.
 *
 *   curl -o ncm.json 'https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json?perfil=PUBLICO'
 *   node scripts/build-ncm-table.mjs ncm.json [--today 2026-09-29]
 *
 * Writes knowledge/data/ncm-table.json.gz: { act, inForce, codes: [[code, text], …] }.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** `dd/mm/yyyy` as `yyyy-mm-dd`. */
const isoOf = (date) => date.split('/').reverse().join('-')

/** A description without the dashes that mark its depth, or the colon that opens a list. */
export const clean = (text) =>
  text
    .replace(/^[\s–-]+/, '')
    .replace(/:\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()

/** Codes in force on `today`, 8-digit ones described through their ancestors. */
export function tableOf(source, today) {
  const inForce = source.Nomenclaturas.filter(
    (entry) => isoOf(entry.Data_Inicio) <= today && isoOf(entry.Data_Fim) >= today,
  )
  const byDigits = new Map(inForce.map((entry) => [entry.Codigo.replace(/\D/g, ''), clean(entry.Descricao)]))
  const codes = []
  for (const [digits, description] of byDigits) {
    if (digits.length !== 8) continue
    // Heading (4 digits), then every subheading level present, then the code itself.
    const path = [4, 5, 6, 7]
      .map((length) => byDigits.get(digits.slice(0, length)))
      .filter((text) => text && text !== description)
    codes.push([digits, [...new Set([...path, description])].join(' — ')])
  }
  return codes.sort(([a], [b]) => a.localeCompare(b))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , input, ...rest] = process.argv
  if (!input) throw new Error('Usage: node scripts/build-ncm-table.mjs ncm.json [--today yyyy-mm-dd]')
  const flag = rest.indexOf('--today')
  const today = flag === -1 ? new Date().toISOString().slice(0, 10) : rest[flag + 1]
  const source = JSON.parse(await readFile(input, 'utf8'))
  const codes = tableOf(source, today)
  const table = { act: source.Ato, inForce: source.Data_Ultima_Atualizacao_NCM, builtFor: today, codes }
  const file = join(root, 'knowledge/data/ncm-table.json.gz')
  await writeFile(file, gzipSync(JSON.stringify(table), { level: 9 }))
  console.log(`${codes.length} codes (${table.act}, ${table.inForce}) → ${file}`)
}
