import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as XLSX from 'xlsx'
import { parseIotWorkbookArrayBuffer, parseIotWorkbookRows } from '../src/lib/iotDataParse.js'
import { formatRunDate, parseFleetDate } from '../src/lib/uploadParseUtils.js'

function workbookBuffer(rows, { date1904 = false, preamble = [] } = {}) {
  const sheet = XLSX.utils.aoa_to_sheet([...preamble, ['Object', 'Date', 'Total Distance'], ...rows])
  const workbook = XLSX.utils.book_new()
  workbook.Workbook = { WBProps: { date1904 } }
  XLSX.utils.book_append_sheet(workbook, sheet, 'Report')
  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })
}

function csvRows(text, source = 'opspod_ev91') {
  return parseIotWorkbookArrayBuffer(new TextEncoder().encode(text), source).rows
}

await test('actual Excel dates retain their calendar day despite M/D/YY display formatting', () => {
  const buffer = workbookBuffer([
    ['TN22EB2009', new Date(2026, 5, 5), 10],
    ['TN22EB2091', new Date(2026, 5, 7), 0],
  ])
  const rows = parseIotWorkbookArrayBuffer(buffer, 'opspod_ev91').rows
  assert.deepEqual(rows.map((row) => row.run_date), ['2026-06-05', '2026-06-07'])
  assert.equal(rows[1].total_distance, 0)
})

await test('CSV ISO and day-first text dates are preserved without spreadsheet coercion', () => {
  const rows = csvRows('Object,Date,Total Distance\nTN22EB2009,2026-06-05,10\nTN22EB2091,05/06/2026,20\n')
  assert.deepEqual(rows.map((row) => row.run_date), ['2026-06-05', '2026-06-05'])
})

await test('fractional Excel serials keep the date portion in numbers, CSV and Excel', () => {
  assert.equal(formatRunDate(parseFleetDate(46191.75)), '2026-06-18')
  assert.equal(formatRunDate(parseFleetDate('46191.99999')), '2026-06-18')
  assert.equal(csvRows('Object,Date,Total Distance\nTN22EB2009,46191.75,10')[0].run_date, '2026-06-18')
  assert.equal(parseIotWorkbookArrayBuffer(workbookBuffer([['TN22EB2009', 46191.75, 10]]), 'opspod_ev91').rows[0].run_date, '2026-06-18')
})

await test('Excel 1904 date system is respected', () => {
  const rows = parseIotWorkbookArrayBuffer(workbookBuffer([['TN22EB2009', 46191 - 1462 + 0.75, 10]], { date1904: true }), 'opspod_ev91').rows
  assert.equal(rows[0].run_date, '2026-06-18')
})

await test('a missing required distance column rejects the file', () => {
  assert.throws(() => csvRows('reg_no,Total Distance Date\nTN22EB2009,2026-06-18', 'alt_mobility'), /Missing required columns.*total_distance/i)
})

await test('missing, nonnumeric, negative and infinite distances reject the file', () => {
  for (const distance of ['', 'not_a_number', '-1', 'Infinity']) {
    assert.throws(() => csvRows(`Object,Date,Total Distance\nTN22EB2009,2026-06-18,${distance}`), /Row 2:.*distance.*No rows were uploaded/)
  }
})

await test('one invalid row rejects a mixed file with its original worksheet row number', () => {
  const buffer = workbookBuffer([
    ['TN22EB2009', '2026-06-18', 10],
    ['TN22EB2091', 'not_a_date', 20],
  ], { preamble: [['Daily report'], ['Generated on', '2026-06-19']] })
  assert.throws(() => parseIotWorkbookArrayBuffer(buffer, 'opspod_ev91'), (error) => {
    assert.match(error.message, /Row 5: missing or invalid date/)
    assert.deepEqual(error.validationErrors, [{ row: 5, errors: ['missing or invalid date'] }])
    return true
  })
})

await test('blank rows are ignored but nonempty rows without a vehicle are rejected', () => {
  const valid = { Object: 'TN22EB2009', Date: '2026-06-18', 'Total Distance': 0 }
  assert.equal(parseIotWorkbookRows([{}, valid, { Object: ' ', Date: '' }], 'opspod_ev91').length, 1)
  assert.throws(() => parseIotWorkbookRows([valid, { Date: '2026-06-18', 'Total Distance': 10 }], 'opspod_ev91'), /Row 3: missing vehicle identifier/)
})

await test('secondary vehicle identifiers remain supported', () => {
  const rows = csvRows('Vin,Report Date,Distance\nP6DEC12NPCA009459,2026-06-18,10', 'Recent_Details')
  assert.equal(rows[0].raw_vehicle_id, 'P6DEC12NPCA009459')
})

await test('calendar dates are stable across India, UTC and US timezones', () => {
  const program = `
    import assert from 'node:assert/strict';
    import * as XLSX from 'xlsx';
    import { parseIotWorkbookArrayBuffer } from './src/lib/iotDataParse.js';
    const sheet = XLSX.utils.aoa_to_sheet([['Object','Date','Total Distance'],['TN22EB2009',new Date(2026,5,5),10]]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook,sheet,'Sheet1');
    const rows = parseIotWorkbookArrayBuffer(XLSX.write(workbook,{type:'array',bookType:'xlsx'}),'opspod_ev91').rows;
    assert.equal(rows[0].run_date,'2026-06-05');
    const csv = new TextEncoder().encode('Object,Date,Total Distance\\nTN22EB2009,2026-06-05,10');
    assert.equal(parseIotWorkbookArrayBuffer(csv,'opspod_ev91').rows[0].run_date,'2026-06-05');
  `
  for (const timezone of ['Asia/Kolkata', 'UTC', 'America/Los_Angeles']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, TZ: timezone },
      encoding: 'utf8', windowsHide: true,
    })
    assert.equal(result.status, 0, `${timezone}: ${result.stderr || result.error || result.stdout}`)
  }
})
