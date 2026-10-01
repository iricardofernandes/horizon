#!/usr/bin/env node
// Phase 89: the regime of each date, and a lock that survives the next version, proven in a
// throwaway database, because the 2027 package is hypothetical and never enters a catalogue
// a workspace reads. Starts a Postgres container, migrates Fiscal, runs the isolated CLI, writes
// its record under docs/drills, and removes the container.
//
//   node scripts/phase-o-2027.mjs [--out docs/drills/<date>-phase89-isolated-2027.json]
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outIndex = process.argv.indexOf('--out')
const day = new Date().toISOString().slice(0, 10)
const out = resolve(root, outIndex < 0 ? `docs/drills/${day}-phase89-isolated-2027.json` : process.argv[outIndex + 1])
const database = 'horizon_phase89_isolated'
const name = `horizon-phase89-${randomBytes(4).toString('hex')}`
// A throwaway password for a container bound to 127.0.0.1 and removed at the end.
const password = randomBytes(12).toString('hex')

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
docker('run', '-d', '--rm', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${database}`,
  '-p', '127.0.0.1::5432', 'postgres:17-alpine')
try {
  const port = docker('port', name, '5432/tcp').split(':').pop()
  for (let attempt = 0; ; attempt += 1) {
    const ready = spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres', '-d', database])
    if (ready.status === 0) break
    if (attempt > 60) throw new Error('Postgres did not start')
    await new Promise((done) => setTimeout(done, 1000))
  }
  await new Promise((done) => setTimeout(done, 1500))
  const url = (user, secret) => `postgres://${user}:${secret}@127.0.0.1:${port}/${database}`
  const roles = randomBytes(12).toString('hex')
  docker('exec', name, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-c',
    `CREATE ROLE horizon_owner LOGIN PASSWORD '${roles}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     CREATE ROLE horizon_app LOGIN PASSWORD '${roles}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     REVOKE ALL ON SCHEMA public FROM PUBLIC;
     GRANT USAGE ON SCHEMA public TO horizon_app;
     GRANT USAGE, CREATE ON SCHEMA public TO horizon_owner;`)
  const env = {
    ...process.env,
    DATABASE_MIGRATION_URL: url('horizon_owner', roles),
    DATABASE_URL: url('horizon_app', roles),
    DATABASE_ADMIN_URL: url('postgres', password),
    FISCAL_ARTIFACT_KEY_HEX: randomBytes(32).toString('hex'),
    OUT: out,
  }
  const fiscal = join(root, 'fiscal')
  for (const [command, args] of [
    [process.execPath, ['scripts/migrate.mjs']],
    ['npm', ['run', '-s', 'build']],
    [process.execPath, ['dist/phase89-isolated-cli.js']],
  ]) {
    const result = spawnSync(command, args, { cwd: fiscal, env, stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`)
  }
} finally {
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
}
