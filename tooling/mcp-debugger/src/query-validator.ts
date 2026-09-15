import { parse } from 'pgsql-ast-parser'

const mutationTypes = new Set([
  'alter table',
  'commit',
  'create extension',
  'create index',
  'create table',
  'delete',
  'drop table',
  'insert',
  'rollback',
  'set',
  'truncate table',
  'update',
])
const safeFunctions = new Set([
  'abs',
  'array_agg',
  'avg',
  'ceil',
  'coalesce',
  'count',
  'date_part',
  'date_trunc',
  'floor',
  'greatest',
  'json_agg',
  'jsonb_agg',
  'least',
  'length',
  'lower',
  'max',
  'min',
  'nullif',
  'round',
  'sum',
  'upper',
])

export function validateExplainQuery(query: string): string {
  const value = query.trim()
  if (!value || value.length > 10_000) throw new Error('Query must contain 1-10000 characters')
  const statements = parse(value)
  if (statements.length !== 1) throw new Error('Exactly one SQL statement is required')
  const statement = statements[0]
  if (!statement || !['select', 'with'].includes(statement.type))
    throw new Error('Only SELECT statements are accepted')
  inspect(statement)
  return value
}

function inspect(value: unknown): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const entry of value) inspect(entry)
    return
  }
  const node = value as Record<string, unknown>
  const type = typeof node.type === 'string' ? node.type.toLowerCase() : ''
  if (mutationTypes.has(type) || node.for)
    throw new Error('SELECT statements with writes or row locks are not accepted')
  if (type === 'call') {
    const fn = node.function as { name?: unknown } | undefined
    const name = typeof fn?.name === 'string' ? fn.name.toLowerCase() : ''
    if (!safeFunctions.has(name))
      throw new Error(`Function ${name || '<unknown>'} is not allowlisted`)
  }
  for (const child of Object.values(node)) inspect(child)
}
