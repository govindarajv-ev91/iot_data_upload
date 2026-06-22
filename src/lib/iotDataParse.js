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
    multiFilePerDate: true,
  },
  alt_mobility: {
    label: 'Alt Mobility',
    vehicle: ['reg_no'],
    date: ['total_distance_date'],
    distance: ['total_distance'],
    secondary: [],
  },
  vehicle_day_report: {
    label: 'Recent_Details (stridegreen)',
    vehicle: ['vehicle_no'],
    date: ['date'],
    distance: ['distance_km'],
    secondary: ['chassis_no'],
  },
  Recent_Details: {
    label: 'vehicle_day_report (Motvolt)',
    vehicle: ['reg_no'],
    date: ['report_date'],
    distance: ['distance'],
    secondary: ['vin', 'vcu_id'],
  },
}

function readCellValue(cell) {
  if (!cell) return ''
  // Prefer Excel formatted text for date cells — avoids UTC timezone shifting the day
  if (cell.t === 'd' && cell.w != null && String(cell.w).trim() !== '') return cell.w
  if (cell.v instanceof Date) return cell.v
  if (cell.t === 'n' && typeof cell.v === 'number') return cell.v
  if (cell.w != null && String(cell.w).trim() !== '') return cell.w
  if (cell.v != null && String(cell.v).trim() !== '') return cell.v
  return ''
}

function buildRowsFromSheet(sheet, sourceKey) {
  const ref = sheet['!ref']
  if (!ref) return []

  const range = XLSX.utils.decode_range(ref)
  const headers = []
  for (let c = range.s.c; c <= range.e.c; c++) {
    const addr = XLSX.utils.encode_cell({ r: range.s.r, c })
    headers[c] = String(readCellValue(sheet[addr])).replace(/^\uFEFF/, '').trim()
  }

  const rows = []
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const row = {}
    for (let c = range.s.c; c <= range.e.c; c++) {
      const header = headers[c]
      if (!header) continue
      const addr = XLSX.utils.encode_cell({ r, c })
      row[header] = readCellValue(sheet[addr])
    }
    rows.push(row)
  }

  return parseIotWorkbookRows(rows, sourceKey)
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
  const rows = buildRowsFromSheet(sheet, sourceKey)

  return { rows, sheetName }
}

export function detectIotDataSource(headers) {
  const normalized = new Set((headers || []).map((h) => normalizeRowKeys({ [h]: 1 })))
  const keys = [...normalized.keys()]

  const has = (...aliases) => aliases.some((a) => keys.includes(a))

  if (has('object') && has('total_distance') && has('date')) return 'opspod_ev91'
  if (has('reg_no') && has('total_distance_date')) return 'alt_mobility'
  if (has('reg_no') && has('report_date') && has('distance') && has('vin')) return 'Recent_Details'
  if (has('vehicle_no') && has('distance_km') && has('s_no')) return 'vehicle_day_report'

  return null
}

export function toIotDbRows(parsedRows, uploadBatchId = null) {
  return (parsedRows || []).map((row) => ({
    vehicle_number: row.vehicle_number || row.raw_vehicle_id || null,
    run_date: row.run_date,
    total_distance: row.total_distance,
    data_source: row.data_source,
    raw_vehicle_id: row.raw_vehicle_id,
    vehicle_master_id: row.vehicle_master_id ?? null,
    lookup_matched: row.lookup_matched ?? false,
    lookup_match_type: row.lookup_match_type ?? null,
    upload_batch_id: uploadBatchId,
  }))
}

export function allowsMultiFilePerDate(sourceKey) {
  return Boolean(IOT_DATA_SOURCES[sourceKey]?.multiFilePerDate)
}
