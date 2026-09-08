/**
 * Contract compatibility analysis — the pure half of scripts/check-contract-compat.mjs.
 *
 * Separated so it can be tested directly (scripts/lib/contract-diff.test.mjs). The gate
 * is what turns the versioning policy in ADR 0030 from documentation into a guarantee,
 * and an untested gate is back to being documentation.
 */

export const BREAKING = 'breaking'
export const ADDITIVE = 'additive'

// ---------------------------------------------------------------- diffing

/**
 * Structural diff of two JSON Schemas.
 *
 * Severity is judged conservatively, because these schemas are used both to *validate*
 * an incoming message and to *construct* an outgoing one. A change that is safe in one
 * direction is often breaking in the other — narrowing a type breaks producers, removing
 * a field breaks consumers — so anything that could break either is breaking.
 */
export function diffSchema(before, after, path, findings) {
  if (before === undefined || after === undefined) return

  if (before.type !== after.type) {
    findings.push({
      severity: BREAKING,
      path,
      message: `type changed from ${JSON.stringify(before.type)} to ${JSON.stringify(after.type)}`,
    })
  }

  diffEnum(before, after, path, findings)
  diffConstraints(before, after, path, findings)
  diffProperties(before, after, path, findings)

  if (before.items && after.items) {
    diffSchema(before.items, after.items, `${path}[]`, findings)
  }

  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const beforeBranches = before[key]
    const afterBranches = after[key]
    if (!beforeBranches || !afterBranches) continue
    if (afterBranches.length < beforeBranches.length) {
      findings.push({
        severity: BREAKING,
        path,
        message: `${key} lost ${beforeBranches.length - afterBranches.length} branch(es)`,
      })
    }
    for (let index = 0; index < Math.min(beforeBranches.length, afterBranches.length); index += 1) {
      diffSchema(beforeBranches[index], afterBranches[index], `${path}.${key}[${index}]`, findings)
    }
  }
}

function diffEnum(before, after, path, findings) {
  if (!before.enum && !after.enum) return

  if (before.enum && !after.enum) {
    // Widening: anything that was valid still is.
    findings.push({ severity: ADDITIVE, path, message: 'enum constraint removed' })
    return
  }
  if (!before.enum && after.enum) {
    findings.push({ severity: BREAKING, path, message: 'enum constraint added' })
    return
  }

  const beforeValues = new Set(before.enum)
  const afterValues = new Set(after.enum)

  const removed = [...beforeValues].filter((value) => !afterValues.has(value))
  const added = [...afterValues].filter((value) => !beforeValues.has(value))

  if (removed.length > 0) {
    findings.push({
      severity: BREAKING,
      path,
      message: `enum value(s) removed: ${removed.map((v) => JSON.stringify(v)).join(', ')}`,
    })
  }
  if (added.length > 0) {
    findings.push({
      severity: ADDITIVE,
      path,
      message: `enum value(s) added: ${added.map((v) => JSON.stringify(v)).join(', ')}`,
    })
  }
}

const TIGHTENING = {
  minLength: (before, after) => after > before,
  minimum: (before, after) => after > before,
  minItems: (before, after) => after > before,
  maxLength: (before, after) => after < before,
  maximum: (before, after) => after < before,
  maxItems: (before, after) => after < before,
}

function diffConstraints(before, after, path, findings) {
  for (const [key, isTighter] of Object.entries(TIGHTENING)) {
    const from = before[key]
    const to = after[key]
    if (from === to) continue
    if (from === undefined) {
      findings.push({ severity: BREAKING, path, message: `${key} constraint added (${to})` })
    } else if (to === undefined) {
      findings.push({ severity: ADDITIVE, path, message: `${key} constraint removed` })
    } else {
      findings.push({
        severity: isTighter(from, to) ? BREAKING : ADDITIVE,
        path,
        message: `${key} changed from ${from} to ${to}`,
      })
    }
  }

  for (const key of ['pattern', 'format']) {
    const from = before[key]
    const to = after[key]
    if (from === to) continue
    if (from === undefined) {
      findings.push({ severity: BREAKING, path, message: `${key} added: ${to}` })
    } else if (to === undefined) {
      findings.push({ severity: ADDITIVE, path, message: `${key} removed` })
    } else {
      findings.push({ severity: BREAKING, path, message: `${key} changed from ${from} to ${to}` })
    }
  }

  if (before.additionalProperties === true && after.additionalProperties === false) {
    findings.push({ severity: BREAKING, path, message: 'additionalProperties tightened to false' })
  }
}

function diffProperties(before, after, path, findings) {
  const beforeProperties = before.properties
  const afterProperties = after.properties
  if (!beforeProperties && !afterProperties) return

  const beforeRequired = new Set(before.required ?? [])
  const afterRequired = new Set(after.required ?? [])

  for (const name of Object.keys(beforeProperties ?? {})) {
    const child = `${path}.${name}`

    if (!afterProperties || !(name in afterProperties)) {
      findings.push({ severity: BREAKING, path: child, message: 'property removed' })
      continue
    }

    if (!beforeRequired.has(name) && afterRequired.has(name)) {
      // A producer that legitimately omitted it now fails validation.
      findings.push({ severity: BREAKING, path: child, message: 'property became required' })
    }
    if (beforeRequired.has(name) && !afterRequired.has(name)) {
      findings.push({ severity: ADDITIVE, path: child, message: 'property became optional' })
    }

    diffSchema(beforeProperties[name], afterProperties[name], child, findings)
  }

  for (const name of Object.keys(afterProperties ?? {})) {
    if (beforeProperties && name in beforeProperties) continue
    const child = `${path}.${name}`
    findings.push({
      // A new *required* field breaks every existing producer; a new optional one is free.
      severity: afterRequired.has(name) ? BREAKING : ADDITIVE,
      path: child,
      message: afterRequired.has(name) ? 'required property added' : 'optional property added',
    })
  }
}

// ---------------------------------------------------------------- versioning

export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) throw new Error(`unparseable version: ${version}`)
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * Which position must move, given the severity of the change.
 *
 * Under 0.x the breaking position is `minor`, not `major` — that is the npm convention
 * (a caret range on 0.x only admits patch releases), and treating 0.2.0 as compatible
 * with 0.1.0 would be wrong.
 */
export function requiredBump(baseline, severity) {
  const isZeroVersion = baseline.major === 0
  if (severity === BREAKING) return isZeroVersion ? 'minor' : 'major'
  return isZeroVersion ? 'patch' : 'minor'
}

export function bumpSatisfied(baseline, current, position) {
  if (position === 'major') return current.major > baseline.major
  if (position === 'minor') {
    return current.major > baseline.major || current.minor > baseline.minor
  }
  return (
    current.major > baseline.major ||
    current.minor > baseline.minor ||
    current.patch > baseline.patch
  )
}
