#!/usr/bin/env node
// Phase 84 (ADR 0072): the official IBS/CBS calculator as the oracle of the tax package.
//
//   node scripts/tax-oracle.mjs [--download] [--cases 3000] [--seed 84] [--out-dir docs/drills]
//     [--record-by <who>]   with DATABASE_URL, records each report in Fiscal (Phase 89)
//
// 1. The calculator pinned in Phase 82's source manifest, downloaded with --download when it is
//    not cached, and refused when its digest is not the pinned one: the oracle changed, so re-run
//    and review before trusting it.
// 2. Its image imported (`docker import`, as its own installer does) and started on
//    127.0.0.1:18080.
// 3. The 2026 package and the hypothetical 2027 one built from its database, and a seeded corpus
//    put to the engine and to the calculator. Any difference, refusal or unproven class fails.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : process.argv[index + 1]
}
const PORT = 18080
const CONTAINER = 'horizon-rtc-oracle'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`)
  return result
}

const sha256 = (path) =>
  new Promise((done, fail) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => done(hash.digest('hex')))
      .on('error', fail)
  })

async function pinnedCalculator() {
  const manifest = JSON.parse(
    await readFile(join(root, 'docs/tax-phase82-source-manifest.json'), 'utf8'),
  )
  const source = manifest.sources.find((entry) => entry.id === 'rtc-calculator-v0059')
  if (!source) throw new Error('The source manifest pins no rtc-calculator-v0059')
  return source
}

async function fetchCalculator(source) {
  const directory = join(root, '.artifacts/fiscal/rtc', source.sha256)
  const zip = join(directory, 'calculadora.zip')
  if (!existsSync(zip)) {
    if (!process.argv.includes('--download'))
      throw new Error(`${zip} is missing: run with --download`)
    await mkdir(directory, { recursive: true })
    run('curl', ['-fsSL', '--retry', '3', '-o', `${zip}.part`, source.uri])
    run('mv', [`${zip}.part`, zip])
  }
  const digest = await sha256(zip)
  if (digest !== source.sha256) {
    await rm(zip, { force: true })
    throw new Error(
      `The oracle changed: calculadora.zip is ${digest}, pinned ${source.sha256}. Re-run and review.`,
    )
  }
  const database = join(directory, 'extracted/calculadora-pro.db')
  if (!existsSync(database)) {
    await mkdir(dirname(database), { recursive: true })
    const unzip = spawnSync('unzip', ['-p', zip, 'calculadora.tar.gz'], {
      maxBuffer: 1024 * 1024 * 1024,
    })
    if (unzip.status !== 0) throw new Error('unzip failed')
    const extracted = spawnSync(
      'tar',
      ['-xzO', '-f', '-', 'calculadora/calculadora/db/calculadora-pro.db'],
      { input: unzip.stdout, maxBuffer: 256 * 1024 * 1024 },
    )
    if (extracted.status !== 0) throw new Error('tar could not extract calculadora-pro.db')
    await writeFile(database, extracted.stdout)
  }
  return { zip, database }
}

function imageExists(image) {
  return spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status === 0
}

async function startOracle(zip, version) {
  const image = `horizon-rtc-oracle:${version.toLowerCase()}`
  if (!imageExists(image)) {
    const unzip = spawnSync('unzip', ['-p', zip, 'calculadora.tar.gz'], {
      maxBuffer: 1024 * 1024 * 1024,
    })
    if (unzip.status !== 0) throw new Error('unzip failed')
    run('docker', ['import', '-', image], { input: unzip.stdout, stdio: ['pipe', 'inherit', 'inherit'] })
  }
  const running = spawnSync('docker', ['inspect', '-f', '{{.Config.Image}}', CONTAINER], {
    encoding: 'utf8',
  })
  if (running.status === 0 && running.stdout.trim() !== image)
    run('docker', ['rm', '-f', CONTAINER])
  if (running.status !== 0 || running.stdout.trim() !== image)
    run('docker', [
      'run', '-d', '--name', CONTAINER, '-p', `127.0.0.1:${PORT}:8080`, '-w', '/calculadora',
      image, 'bash', 'start.sh',
    ])
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    // An empty body is refused with 400 once the service answers.
    const status = await fetch(`http://127.0.0.1:${PORT}/api/calculadora/regime-geral`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
      .then((response) => response.status)
      .catch(() => 0)
    if (status === 400) return
    await new Promise((done) => setTimeout(done, 2_000))
  }
  throw new Error('The oracle did not answer within three minutes')
}

function oracle(args) {
  return run('npm', ['run', '-s', 'phase84:oracle', '--', ...args], {
    cwd: join(root, 'fiscal'),
    stdio: ['ignore', 'inherit', 'inherit'],
  })
}

const source = await pinnedCalculator()
const { zip, database } = await fetchCalculator(source)
await startOracle(zip, 'V0059')
if (!existsSync(join(root, 'fiscal/dist/phase84-oracle-cli.js')))
  run('npm', ['run', '-s', 'build'], { cwd: join(root, 'fiscal') })
const packages = join(root, '.artifacts/fiscal/packages')
const outDir = resolve(root, option('out-dir', 'docs/drills'))
const day = new Date().toISOString().slice(0, 10)
await mkdir(packages, { recursive: true })
await mkdir(outDir, { recursive: true })
let failed = false
const reports = []
for (const year of ['2026', 'hypothetical-2027']) {
  const pack = join(packages, `rtc-v0059-ibs-cbs-${year}.json`)
  oracle([
    'build', '--database', database, '--artifact', zip, '--out', pack,
    ...(year === '2026' ? [] : ['--hypothetical-2027']),
  ])
  const result = spawnSync(
    'npm',
    [
      'run', '-s', 'phase84:oracle', '--', 'oracle', '--package', pack, '--database', database,
      '--url', `http://127.0.0.1:${PORT}`, '--out', join(outDir, `${day}-phase84-oracle-${year}.json`),
      '--cases', option('cases', '3000'), '--seed', option('seed', '84'),
    ],
    { cwd: join(root, 'fiscal'), stdio: 'inherit' },
  )
  if (result.status !== 0) failed = true
  reports.push(join(outDir, `${day}-phase84-oracle-${year}.json`))
}
// Phase 89: the run becomes a service level, whether it agreed or not.
const recordBy = option('record-by', null)
if (recordBy) {
  if (!process.env.DATABASE_URL) throw new Error('--record-by needs DATABASE_URL')
  run('npm', ['run', '-s', 'tax:oracle-record', '--', '--by', recordBy, ...reports.filter((path) => existsSync(path))], {
    cwd: join(root, 'fiscal'),
  })
}
if (failed) {
  console.error('The engine and the official calculator disagree: see the reports.')
  process.exit(1)
}
