import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { test } from 'node:test'

// Always create an isolated, temporary database. Never read app credentials or
// connect to an existing database. PostgreSQL binaries are the only prerequisite.
const suffix = process.platform === 'win32' ? '.exe' : ''
const candidates = [
  process.env.POSTGRES_BIN,
  ...(process.platform === 'win32' ? ['C:/Program Files/PostgreSQL/18/bin', 'C:/Program Files/PostgreSQL/17/bin'] : []),
  ...(process.env.PATH || '').split(delimiter),
].filter(Boolean)
const binaryDir = candidates.find((directory) => ['initdb', 'pg_ctl', 'psql'].every((name) => existsSync(join(directory, name + suffix))))
if (!binaryDir) throw new Error('PostgreSQL binaries not found. Set POSTGRES_BIN to the directory containing initdb, pg_ctl and psql.')

const temporaryRoot = resolve(tmpdir())
const directory = mkdtempSync(join(temporaryRoot, 'iot-upload-sql-'))
const dataDir = join(directory, 'data')
const logPath = join(directory, 'postgres.log')
const env = { ...process.env, PGPASSWORD: '' }
for (const name of ['PGOPTIONS', 'PGSERVICE', 'PGSERVICEFILE', 'PGHOSTADDR']) delete env[name]

function run(name, args, { input, allowFailure = false } = {}) {
  const result = spawnSync(join(binaryDir, name + suffix), args, {
    input, encoding: 'utf8', env, windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    // A background server must not inherit pipes that keep spawnSync waiting.
    ...(name === 'pg_ctl' ? { stdio: 'ignore' } : {}),
  })
  if (result.error || (result.status !== 0 && !allowFailure)) {
    throw new Error(`${name} failed: ${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`)
  }
  return result
}

async function freePort() {
  const server = createServer()
  await new Promise((resolvePort, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePort)
  })
  const port = server.address().port
  await new Promise((resolveClose) => server.close(resolveClose))
  return port
}

const port = await freePort()
const psqlArgs = ['-X', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At']
function sql(query, options) { return run('psql', psqlArgs, { input: query, ...options }).stdout.trim() }
function sqlFailure(query, pattern) {
  const result = run('psql', psqlArgs, { input: query, allowFailure: true })
  assert.notEqual(result.status, 0, 'Expected SQL to fail')
  assert.match(result.stderr, pattern)
}
function upload(count, { source = 'opspod_ev91', batch = 'batch', date = '2026-10-04', prefix = 'TN22EB' } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    vehicle_number: `${prefix}${index}`, raw_vehicle_id: `${prefix}${index}`,
    run_date: date, total_distance: 10, data_source: source,
    vehicle_master_id: null, lookup_matched: false, lookup_match_type: null,
    upload_batch_id: batch,
  }))
}
function rpcSql(rows, role = 'anon') {
  const payload = JSON.stringify(rows).replace(/'/g, "''")
  return `set role ${role}; select row_to_json(r) from public.save_iot_upload('${payload}'::jsonb) r; reset role;`
}
function save(rows, role) {
  const output = sql(rpcSql(rows, role)).split(/\r?\n/).find((line) => line.startsWith('{'))
  assert.ok(output, 'The RPC must return inserted/skipped counts')
  return JSON.parse(output)
}
function parallelSql(query) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(join(binaryDir, 'psql' + suffix), psqlArgs, { env, windowsHide: true })
    let stdout = '', stderr = ''
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    child.once('error', reject)
    child.once('exit', (code) => resolveResult({ code, stdout, stderr }))
    child.stdin.end(query)
  })
}

let started = false
try {
  run('initdb', ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'])
  run('pg_ctl', ['-D', dataDir, '-l', logPath, '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start'])
  started = true
  sql('create role anon; create role authenticated; create table public.vehicle_master (id bigint primary key); insert into public.vehicle_master values (1);')
  const root = fileURLToPath(new URL('../', import.meta.url))
  const setup = readFileSync(join(root, 'sql/create_iot_data_table.sql'), 'utf8')
  const migration = readFileSync(join(root, 'sql/fix_upload_integrity.sql'), 'utf8')
  const dashboard = readFileSync(join(root, 'sql/fix_dashboard_last_upload_timeout.sql'), 'utf8')
  sql(setup)
  // Preserve duplicates already created by the old raw-identifier uniqueness rule.
  sql(`insert into public.iot_data (vehicle_number,run_date,total_distance,data_source,raw_vehicle_id)
    values ('TN22EBLEGACY','2026-10-01',10,'opspod_ev91','old-a'), ('tn-22-eb-legacy','2026-10-01',20,'opspod_ev91','old-b');
    grant insert (vehicle_number,run_date,total_distance,data_source,raw_vehicle_id) on public.iot_data to anon;
    grant delete, truncate on public.iot_data to anon;`)

  await test('migration runs twice and preserves existing legacy duplicates', () => {
    sql(migration)
    sql(setup)
    sql(migration)
    sql(dashboard)
    assert.equal(sql('select count(*) from public.iot_data'), '2')
  })

  await test('anonymous direct deletion, truncate, and column-level insertion are denied', () => {
    sqlFailure('set role anon; delete from public.iot_data;', /permission denied/)
    sqlFailure('set role anon; truncate public.iot_data;', /permission denied/)
    sqlFailure("set role anon; insert into public.iot_data (vehicle_number,run_date,total_distance,data_source,raw_vehicle_id) values ('BAD','2026-10-05',1,'opspod_ev91','BAD');", /permission denied/)
    sqlFailure('set role anon; select * from iot_private.upload_receipts;', /permission denied/)
    assert.equal(sql('set role anon; select count(*) from public.iot_data;').split(/\r?\n/).at(-1), '2')
  })

  await test('750-row upload with a foreign-key failure saves zero rows and can be retried', () => {
    const rows = upload(750, { source: 'alt_mobility', batch: 'atomic-retry' })
    rows[749].vehicle_master_id = 999999
    sqlFailure(rpcSql(rows), /foreign key constraint/)
    assert.equal(sql("select count(*) from public.iot_data where data_source = 'alt_mobility'"), '0')
    assert.equal(sql("select count(*) from iot_private.upload_receipts where upload_batch_id = 'atomic-retry'"), '0')
    rows[749].vehicle_master_id = 1
    assert.deepEqual(save(rows), { inserted: 750, skipped: 0 })
    assert.deepEqual(save(rows), { inserted: 750, skipped: 0 })
    assert.equal(sql("select count(*) from public.iot_data where data_source = 'alt_mobility'"), '750')
    const changed = structuredClone(rows)
    changed[0].total_distance = 11
    sqlFailure(rpcSql(changed), /already used for different data/)
  })

  await test('non-Opspod date conflicts reject the whole new file', () => {
    const rows = upload(2, { source: 'alt_mobility', batch: 'date-conflict', prefix: 'NEW' })
    rows[1].run_date = '2026-10-05'
    sqlFailure(rpcSql(rows), /data already exists for date/)
    assert.equal(sql("select count(*) from public.iot_data where upload_batch_id = 'date-conflict'"), '0')
  })

  await test('normalized duplicates are skipped within a file and against every existing row', () => {
    const rows = upload(1001, { batch: 'large-existing', prefix: 'OPS' })
    assert.deepEqual(save(rows), { inserted: 1001, skipped: 0 })
    const duplicates = upload(2, { batch: 'different-raw', prefix: 'UNUSED' })
    duplicates[0].vehicle_number = 'ops-1000'
    duplicates[0].raw_vehicle_id = 'different-raw-id'
    duplicates[1].vehicle_number = 'OPS1000'
    duplicates[1].raw_vehicle_id = 'another-raw-id'
    assert.deepEqual(save(duplicates), { inserted: 0, skipped: 2 })
    const legacy = upload(1, { batch: 'legacy-check', date: '2026-10-01' })
    legacy[0].vehicle_number = ' TN22EBLEGACY '
    assert.deepEqual(save(legacy), { inserted: 0, skipped: 1 })
  })

  await test('invalid required fields abort the entire upload on the server', () => {
    const cases = [
      { total_distance: null }, { total_distance: -1 }, { total_distance: 'NaN' },
      { run_date: '2026-02-30' }, { raw_vehicle_id: '', vehicle_number: '' },
      { data_source: 'unknown' },
    ]
    for (const [index, change] of cases.entries()) {
      const rows = upload(2, { batch: `invalid-${index}`, prefix: 'INVALID' })
      Object.assign(rows[1], change)
      sqlFailure(rpcSql(rows), /ERROR/)
      assert.equal(sql(`select count(*) from public.iot_data where upload_batch_id = 'invalid-${index}'`), '0')
    }
  })

  await test('simultaneous Opspod uploads cannot insert the same normalized vehicle/date', async () => {
    const first = upload(1, { batch: 'race-first', prefix: 'RACE' })
    const second = upload(1, { batch: 'race-second', prefix: 'RACE' })
    second[0].raw_vehicle_id = 'different-raw'
    const results = await Promise.all([
      parallelSql(`begin; ${rpcSql(first)} select pg_sleep(0.2); commit;`),
      parallelSql(rpcSql(second)),
    ])
    assert.ok(results.every((result) => result.code === 0), results.map((result) => result.stderr).join('\n'))
    assert.equal(sql("select count(*) from public.iot_data where vehicle_number = 'RACE0'"), '1')
    const counts = results.map((result) => JSON.parse(result.stdout.split(/\r?\n/).find((line) => line.startsWith('{'))))
    assert.equal(counts.reduce((sum, row) => sum + row.inserted, 0), 1)
    assert.equal(counts.reduce((sum, row) => sum + row.skipped, 0), 1)
  })

  await test('authenticated uploads and dashboard reads still work', () => {
    assert.deepEqual(save(upload(1, { source: 'Recent_Details', batch: 'auth-batch' }), 'authenticated'), { inserted: 1, skipped: 0 })
    const output = sql("set role anon; select row_to_json(r) from public.iot_dashboard_last_uploads(array['Recent_Details']) r;")
    const row = JSON.parse(output.split(/\r?\n/).find((line) => line.startsWith('{')))
    assert.equal(row.vehicle_count, 1)
    assert.equal(row.file_count, 1)
  })
} catch (error) {
  console.error(error.message)
  if (existsSync(logPath)) console.error(readFileSync(logPath, 'utf8').slice(-4000))
  throw error
} finally {
  if (started) run('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop'])
  // Only remove the exact disposable directory created above, within tmpdir.
  const safePath = resolve(directory)
  if (!safePath.startsWith(temporaryRoot + sep) || !safePath.slice(temporaryRoot.length + 1).startsWith('iot-upload-sql-')) {
    throw new Error('Refusing to remove an unexpected test directory')
  }
  rmSync(safePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
