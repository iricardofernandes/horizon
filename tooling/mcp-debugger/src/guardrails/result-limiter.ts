export type LimitedResult = {
  data: unknown
  truncated: boolean
  returnedRows?: number
  originalBytes: number
}

export function limitResult(value: unknown, maxRows: number, maxBytes: number): LimitedResult {
  let data = value
  let truncated = false
  let returnedRows: number | undefined

  if (Array.isArray(data)) {
    const rows = data.slice(0, maxRows)
    truncated = rows.length < data.length
    data = rows
    returnedRows = rows.length
  }

  const originalBytes = Buffer.byteLength(JSON.stringify(data))
  if (originalBytes <= maxBytes)
    return {
      data,
      truncated,
      ...(returnedRows === undefined ? {} : { returnedRows }),
      originalBytes,
    }

  truncated = true
  if (Array.isArray(data)) {
    const rows: unknown[] = []
    for (const row of data) {
      const candidate = [...rows, row]
      if (Buffer.byteLength(JSON.stringify(candidate)) > maxBytes) break
      rows.push(row)
    }
    data = rows
    returnedRows = rows.length
  } else {
    data = { notice: 'Result exceeded the configured byte limit and was omitted' }
  }

  return { data, truncated, ...(returnedRows === undefined ? {} : { returnedRows }), originalBytes }
}
