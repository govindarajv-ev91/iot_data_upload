import * as XLSX from 'xlsx'
import {
  normalizeRowKeys,
  pickField,
  toText,
  toNumber,
  parseFleetDate,
  formatRunDate,
} from './uploadParseUtils.js'

export const IOT_DATA_SOURCES = {
  opspod_ev91: {
    label: 'Opspod-ev91',
    vehicle: ['object'],
    date: ['date'],
    distance: ['total_distance'],
    secondary: [],
  },
  alt_mobility: {
    label: 'Alt Mobility',
    vehicle: ['reg_no'],
    date: ['total_distance_date'],
    distance: ['total_distance'],
    secondary: [],
  },
  connectm_motovolt: {
    label: 'Connectm - Motovolt',
    vehicle: ['reg_no'],
    date: ['report_date'],
    distance: ['distance'],
    secondary: ['vin', 'vcu_id'],
  },
  stridegreen: {
    label: 'Stridegreen',
    vehicle: ['vehicle_no'],
    date: ['date'],
    distance: ['distance_km'],
    secondary: ['chassis_no'],
  },
}

function mapIotRow(normalized, sourceKey) {
  const config = IOT_DATA_SOURCES[sourceKey]
  if (!config) return null

  const rawVehicle = toText(pickField(normalized, config.vehicle))
  const secondaryIds = config.secondary
    .map((alias) => toText(pickField(normalized, [alias])))
    .filter(Boolean)

  const dateRaw = pickField(normalized, config.date)
  const runDateParsed = parseFleetDate(dateRaw)
  const runDate = formatRunDate(runDateParsed)
  const totalDistance = toNumber(pickField(normalized, config.distance))

  if (!rawVehicle && !secondaryIds.length) return null
  if (!runDate) return null

  return {
    raw_vehicle_id: rawVehicle || secondaryIds[0] || '',
    secondary_vehicle_ids: secondaryIds,
    run_date: runDate,
    run_date_parsed: runDateParsed,
    total_distance: totalDistance,
    data_source: sourceKey,
  }
}

function hasAnyValue(row) {
  return Boolean(row.raw_vehicle_id || row.secondary_vehicle_ids?.length)
}

export function parseIotWorkbookRows(jsonRows, sourceKey) {
  return (jsonRows || [])
    .map((row) => mapIotRow(normalizeRowKeys(row), sourceKey))
    .filter((row) => row && hasAnyValue(row))
}

export function parseIotWorkbookArrayBuffer(arrayBuffer, sourceKey) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: true })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) return { rows: [], sheetName: null }

  const sheet = workbook.Sheets[sheetName]
  const json = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false })
  const rows = parseIotWorkbookRows(json, sourceKey)

  return { rows, sheetName }
}

export function detectIotDataSource(headers) {
  const normalized = new Set((headers || []).map((h) => normalizeRowKeys({ [h]: 1 })))
  const keys = [...normalized.keys()]

  const has = (...aliases) => aliases.some((a) => keys.includes(a))

  if (has('object') && has('total_distance') && has('date')) return 'opspod_ev91'
  if (has('reg_no') && has('total_distance_date')) return 'alt_mobility'
  if (has('reg_no') && has('report_date') && has('distance')) return 'connectm_motovolt'
  if (has('vehicle_no') && has('distance_km')) return 'stridegreen'

  return null
}

export function toIotDbRows(parsedRows) {
  return (parsedRows || []).map((row) => ({
    vehicle_number: row.vehicle_number || null,
    run_date: row.run_date,
    total_distance: row.total_distance,
    data_source: row.data_source,
    raw_vehicle_id: row.raw_vehicle_id,
    vehicle_master_id: row.vehicle_master_id ?? null,
    lookup_matched: row.lookup_matched ?? false,
    lookup_match_type: row.lookup_match_type ?? null,
  }))
}
