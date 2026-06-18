import { buildVehicleMasterIndex, resolveVehicleFromMaster } from '../src/lib/vehicleLookup.js'

const masterRows = [
  {
    id: 1,
    master_date: '2026-06-17',
    vehicle_number: 'TN22EB2091',
    chassis_number: 'P6DEC12NPCA009459',
    engine_motor_number: 'MTC12EA2412103',
  },
  {
    id: 2,
    master_date: '2026-06-17',
    vehicle_number: 'TN22EB2009',
    chassis_number: 'P6DEC12NPCA009484',
    engine_motor_number: 'MTC12EA2412124',
  },
  {
    id: 3,
    master_date: '2026-06-17',
    vehicle_number: 'TN22EB2023',
    chassis_number: 'P6DEC12NPCA009485',
    engine_motor_number: 'MTC12EA2412125',
  },
]

const index = buildVehicleMasterIndex(masterRows)
const asOf = new Date('2026-06-17')

const cases = [
  ['P6DEC12NPCA009484', 'TN22EB2009'],
  ['MTC12EA2412124', 'TN22EB2009'],
  ['TN22EB2009', 'TN22EB2009'],
  ['TN22EB2009-P6DEC12NPCA009484', 'TN22EB2009'],
  ['TN22EB2009-MTC12EA2412124', 'TN22EB2009'],
  ['TN22EB2009-P6DEC12NPCA009485-P6DEC12NPCA009485', 'TN22EB2023'],
  ['P6DEC12NPCA009459', 'TN22EB2091'],
]

let passed = 0
for (const [raw, expected] of cases) {
  const result = resolveVehicleFromMaster(raw, index, { asOfDate: asOf })
  const ok = result.vehicle_number === expected
  console.log(`${ok ? 'OK' : 'FAIL'}  "${raw}" -> ${result.vehicle_number} (expected ${expected})`)
  if (ok) passed += 1
}

console.log(`\n${passed}/${cases.length} passed`)
process.exit(passed === cases.length ? 0 : 1)
