import { parseFleetDate, formatRunDate } from '../src/lib/uploadParseUtils.js'

const cases = [
  ['2026-06-18', '2026-06-18'],
  ['18/06/2026', '2026-06-18'],
  ['18-06-2026', '2026-06-18'],
  ['6/18/2026', '2026-06-18'],
  ['06-18-2026', '2026-06-18'],
  ['46191', '2026-06-18'],
  [46191, '2026-06-18'],
  ['20260618', '2026-06-18'],
  ['2026/06/18', '2026-06-18'],
  ['1/5/220', null],
  ['220', null],
  ['01-05-220', null],
  ['2026-06-18 00:00:00', '2026-06-18'],
  ['18-Jun-2026', '2026-06-18'],
  [new Date(2026, 5, 18), '2026-06-18'],
]

let passed = 0
for (const [input, expected] of cases) {
  const result = formatRunDate(parseFleetDate(input)) || null
  const ok = result === expected
  console.log(`${ok ? 'OK' : 'FAIL'}  ${JSON.stringify(input)} -> ${result} (expected ${expected})`)
  if (ok) passed += 1
}

console.log(`\n${passed}/${cases.length} passed`)
process.exit(passed === cases.length ? 0 : 1)
