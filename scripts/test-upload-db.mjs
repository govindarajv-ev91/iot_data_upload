import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

// Substitute only the client import. All functions under test come from the
// actual module, and the fake client cannot connect to a database.
const clientKey = '__iotUploadDbRegressionClient'
const moduleUrl = new URL('../src/lib/iotDataDb.js', import.meta.url)
const clientModule = `export function getSupabase() { return globalThis[${JSON.stringify(clientKey)}] }`
const clientUrl = `data:text/javascript;base64,${Buffer.from(clientModule).toString('base64')}`
let substitutions = 0
const source = (await readFile(moduleUrl, 'utf8')).replace(
  /(from\s+)(['"])(\.\/[^'"]+)\2/g,
  (_, prefix, quote, specifier) => {
    if (specifier === './supabaseClient.js') {
      substitutions += 1
      return `${prefix}${quote}${clientUrl}${quote}`
    }
    return `${prefix}${quote}${new URL(specifier, moduleUrl).href}${quote}`
  },
)
assert.equal(substitutions, 1, 'The database client import must be mocked exactly once')
const db = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

function setClient(client) {
  globalThis[clientKey] = client
}

function uploadRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    vehicle_number: `TN22EB${index}`,
    raw_vehicle_id: `TN22EB${index}`,
    data_source: 'opspod_ev91',
    run_date: '2026-10-04',
    total_distance: 10,
    lookup_matched: true,
    upload_batch_id: 'regression-test-upload',
  }))
}

function rpcClient(response) {
  const calls = []
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args })
      return response
    },
    from() {
      assert.fail('Saving an upload must not fall back to table queries or individual inserts')
    },
  }
}

// Mimic PostgREST applying its own row cap, even when the client requests more.
// Filtering, ordering and cursor use operate on actual fixture rows, so missing
// pagination or unstable pagination changes the returned result.
function exportClient(rows, { serverCap = 1000, failPage = null, beforePage = null } = {}) {
  const requests = []
  return {
    requests,
    from(table) {
      assert.equal(table, 'iot_data')
      const request = { filters: [], orders: [], limit: Infinity }
      const query = {
        select() { return query },
        eq(column, value) {
          request.filters.push({ operator: 'eq', column, value })
          return query
        },
        gt(column, value) {
          request.filters.push({ operator: 'gt', column, value })
          return query
        },
        lte(column, value) {
          request.filters.push({ operator: 'lte', column, value })
          return query
        },
        order(column, options = {}) {
          request.orders.push({ column, ascending: options.ascending !== false })
          return query
        },
        limit(value) {
          request.limit = value
          return query
        },
        then(resolve, reject) {
          requests.push(request)
          if (beforePage) beforePage(requests.length, rows)
          if (failPage === requests.length) {
            return Promise.resolve({ data: null, error: new Error('Export page failed') }).then(resolve, reject)
          }
          let page = rows.filter((row) => request.filters.every(({ operator, column, value }) =>
            operator === 'eq' ? row[column] === value
              : operator === 'lte' ? row[column] <= value : row[column] > value,
          ))
          page = [...page].sort((a, b) => {
            for (const { column, ascending } of request.orders) {
              if (a[column] === b[column]) continue
              return (a[column] < b[column] ? -1 : 1) * (ascending ? 1 : -1)
            }
            return 0
          })
          page = page.slice(0, Math.min(request.limit, serverCap))
          return Promise.resolve({ data: page, error: null }).then(resolve, reject)
        },
      }
      return query
    },
  }
}

function unmatchedFixtures(count) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: (index + 1) * 3,
    raw_vehicle_id: `UNMATCHED-${index + 1}`,
    run_date: '2026-10-04',
    created_at: '2026-10-05T00:00:00.000Z',
    lookup_matched: false,
  }))
  // Deliberately unsorted IDs, with identical timestamps and gaps in IDs.
  return rows.reverse().concat({ id: 2, raw_vehicle_id: 'MATCHED', lookup_matched: true })
}

try {
  await test('empty uploads make no database request', async () => {
    setClient({
      rpc() { assert.fail('Empty uploads must not call RPC') },
      from() { assert.fail('Empty uploads must not query a table') },
    })
    assert.deepEqual(await db.saveIotDataRows([]), { inserted: 0, skipped: 0 })
  })

  await test('751 rows are saved in one RPC and numeric counts are returned', async () => {
    const rows = uploadRows(751)
    const client = rpcClient({ data: [{ inserted: '750', skipped: '1' }], error: null })
    setClient(client)
    assert.deepEqual(await db.saveIotDataRows(rows), { inserted: 750, skipped: 1 })
    assert.deepEqual(client.calls, [{ name: 'save_iot_upload', args: { upload_rows: rows } }])
  })

  await test('all-duplicate uploads preserve the RPC skipped count', async () => {
    const client = rpcClient({ data: [{ inserted: 0, skipped: 3 }], error: null })
    setClient(client)
    assert.deepEqual(await db.saveIotDataRows(uploadRows(3)), { inserted: 0, skipped: 3 })
    assert.equal(client.calls.length, 1)
  })

  await test('RPC validation errors abort without fallback inserts', async () => {
    const client = rpcClient({ data: null, error: { code: '23514', message: 'Invalid upload distance' } })
    setClient(client)
    await assert.rejects(() => db.saveIotDataRows(uploadRows(751)), (error) => {
      assert.match(error.message, /Invalid upload distance/)
      return true
    })
    assert.equal(client.calls.length, 1)
  })

  await test('missing save RPC reports the required SQL migration', async () => {
    const client = rpcClient({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function public.save_iot_upload(upload_rows) in the schema cache' },
    })
    setClient(client)
    await assert.rejects(() => db.saveIotDataRows(uploadRows(1)), (error) => {
      assert.match(error.message, /sql[\\/].+\.sql/i, 'The error should identify the migration to run')
      return true
    })
    assert.equal(client.calls.length, 1)
  })

  await test('missing or inconsistent RPC counts cannot report upload success', async () => {
    for (const data of [null, [], [{ inserted: -1, skipped: 2 }], [{ inserted: 0, skipped: 0 }]]) {
      setClient(rpcClient({ data, error: null }))
      await assert.rejects(() => db.saveIotDataRows(uploadRows(1)), /confirm the upload result/i)
    }
  })

  await test('full export includes more than 5000 unmatched rows exactly once', async () => {
    const client = exportClient(unmatchedFixtures(5007))
    setClient(client)
    const rows = await db.fetchAllUnmatchedIotRows()
    assert.deepEqual(rows.map((row) => row.id), Array.from({ length: 5007 }, (_, index) => (index + 1) * 3))
    assert.ok(rows.every((row) => row.lookup_matched === false))
    assert.ok(client.requests.length > 1)
    assert.ok(client.requests.slice(1).every((request) =>
      request.orders.some(({ column, ascending }) => column === 'id' && ascending),
    ), 'Every page must have stable ascending ID ordering')
  })

  await test('export continues past a server cap smaller than its requested page size', async () => {
    const client = exportClient(unmatchedFixtures(23), { serverCap: 7 })
    setClient(client)
    const rows = await db.fetchAllUnmatchedIotRows()
    assert.deepEqual(rows.map((row) => row.id), Array.from({ length: 23 }, (_, index) => (index + 1) * 3))
    assert.equal(client.requests.length, 6, 'Read the snapshot boundary, four populated pages, and an empty final page')
    assert.ok(client.requests[1].limit > 7, 'The fixture must exercise a server cap below the requested limit')
    for (const request of client.requests.slice(2)) {
      assert.ok(request.filters.some(({ operator, column }) => operator === 'gt' && column === 'id'))
    }
  })

  await test('empty unmatched export terminates after one query', async () => {
    const client = exportClient([])
    setClient(client)
    assert.deepEqual(await db.fetchAllUnmatchedIotRows(), [])
    assert.equal(client.requests.length, 1)
  })

  await test('export ignores new rows inserted after its snapshot boundary', async () => {
    const client = exportClient(unmatchedFixtures(10), {
      serverCap: 7,
      beforePage(page, rows) {
        if (page === 3) rows.push({ id: 1000, raw_vehicle_id: 'NEW-ARRIVAL', lookup_matched: false })
      },
    })
    setClient(client)
    const rows = await db.fetchAllUnmatchedIotRows()
    assert.deepEqual(rows.map((row) => row.id), Array.from({ length: 10 }, (_, index) => (index + 1) * 3))
  })

  await test('failed later export page rejects instead of returning a partial CSV', async () => {
    const client = exportClient(unmatchedFixtures(20), { serverCap: 7, failPage: 3 })
    setClient(client)
    await assert.rejects(() => db.fetchAllUnmatchedIotRows(), /Export page failed/)
    assert.equal(client.requests.length, 3)
  })
} finally {
  delete globalThis[clientKey]
}
