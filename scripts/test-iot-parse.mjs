import * as XLSX from 'xlsx'
import { parseIotWorkbookArrayBuffer, parseIotWorkbookRows } from '../src/lib/iotDataParse.js'

const rowCases = [
  [{ Object: 'TN22EB2009', Date: '2026-06-18', 'Total Distance': 120 }, 'opspod_ev91'],
  [{ Object: 'TN22EB2009', Date: 46191, 'Total Distance': 120 }, 'opspod_ev91'],
  [{ Object: 'TN22EB2009', Date: 20260618, 'Total Distance': 120 }, 'opspod_ev91'],
  [{ reg_no: 'TN22EB2009', total_distance_date: '18/06/2026', total_distance: 50 }, 'alt_mobility'],
  [{ 'Reg No': 'TN22EB2009', 'Report Date': '6/18/2026', Distance: 30 }, 'Recent_Details'],
]

let passed = 0
for (const [row, source] of rowCases) {
  const parsed = parseIotWorkbookRows([row], source)
  const ok = parsed.length === 1 && parsed[0].run_date === '2026-06-18'
  console.log(`${ok ? 'OK' : 'FAIL'} ${source} ->`, parsed[0]?.run_date || 'NO ROWS')
  if (ok) passed += 1
}

const ws = XLSX.utils.aoa_to_sheet([
  ['Object', 'Date', 'Total Distance'],
  ['TN22EB2009', new Date(2026, 5, 18), 100],
])
const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
const { rows } = parseIotWorkbookArrayBuffer(buf, 'opspod_ev91')
const wbOk = rows.length === 1 && rows[0].run_date === '2026-06-18'
console.log(`${wbOk ? 'OK' : 'FAIL'} workbook Date object ->`, rows[0]?.run_date || 'NO ROWS')
if (wbOk) passed += 1

console.log(`\n${passed}/${rowCases.length + 1} passed`)
process.exit(passed === rowCases.length + 1 ? 0 : 1)
