import * as XLSX from 'xlsx'
import {
  normalizeRowKeys,
  normalizeHeader,
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
  if (cell.t === 'e') return cell.w || '#ERROR!'
  // Keep text dates unchanged and Excel date serials numeric. Display formats
  // such as M/D/YY are ambiguous and must never become the source of a date.
  return cell.v ?? ''
}

function getSourceConfig(sourceKey) {
  const config = IOT_DATA_SOURCES[sourceKey]
  if (!config) throw new Error('Unknown data source. Select a supported data source and try again.')
  return config
}

function buildRowsFromSheet(sheet, sourceKey, options) {
  const ref = sheet['!ref']
  if (!ref) return []

  const range = XLSX.utils.decode_range(ref)
  const config = getSourceConfig(sourceKey)
  const requiredHeaders = [[...config.vehicle, ...config.secondary], config.date, config.distance]
  const headerRow = Array.from(
    { length: Math.min(range.e.r - range.s.r + 1, 31) },
    (_, offset) => range.s.r + offset,
  ).find((r) => {
    const normalizedHeaders = new Set()
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c })
      normalizedHeaders.add(normalizeHeader(readCellValue(sheet[addr])))
    }
    return requiredHeaders.every((aliases) =>
      aliases.some((alias) => normalizedHeaders.has(alias)),
    )
  })

  if (headerRow === undefined) {
    const fields = requiredHeaders.map((aliases) => aliases.join(' or ')).join('; ')
    throw new Error(`Missing required columns for ${config.label}. Expected: ${fields}. No rows were uploaded.`)
  }

  const headers = []
  for (let c = range.s.c; c <= range.e.c; c++) {
    const addr = XLSX.utils.encode_cell({ r: headerRow, c })
    headers[c] = String(readCellValue(sheet[addr])).replace(/^\uFEFF/, '').trim()
  }

  const rows = []
  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const row = {}
    for (let c = range.s.c; c <= range.e.c; c++) {
      const header = headers[c]
      const addr = XLSX.utils.encode_cell({ r, c })
      // Keep values under unnamed columns so a nonempty invalid row is not
      // mistaken for a blank row and silently discarded.
      row[header || `unnamed_column_${c + 1}`] = readCellValue(sheet[addr])
    }
    rows.push(row)
  }

  return parseIotWorkbookRows(rows, sourceKey, { ...options, firstDataRow: headerRow + 2 })
}

function mapIotRow(normalized, sourceKey, config, options) {
  const rawVehicle = toText(pickField(normalized, config.vehicle))
  const secondaryIds = config.secondary
    .map((alias) => toText(pickField(normalized, [alias])))
    .filter(Boolean)

  const dateRaw = pickField(normalized, config.date)
  const runDateParsed = parseFleetDate(dateRaw, options)
  const runDate = formatRunDate(runDateParsed)
  const totalDistance = toNumber(pickField(normalized, config.distance))

  const errors = []
  if (!rawVehicle && !secondaryIds.length) errors.push('missing vehicle identifier')
  if (!runDate) errors.push('missing or invalid date')
  if (totalDistance === null || totalDistance < 0) errors.push('distance must be a number greater than or equal to zero')
  if (errors.length) return { errors }

  return { row: {
    raw_vehicle_id: rawVehicle || secondaryIds[0] || '',
    secondary_vehicle_ids: secondaryIds,
    run_date: runDate,
    run_date_parsed: runDateParsed,
    total_distance: totalDistance,
    data_source: sourceKey,
  } }
}

export function parseIotWorkbookRows(jsonRows, sourceKey, options = {}) {
  const config = getSourceConfig(sourceKey)
  const { firstDataRow = 2 } = options
  const parsed = []
  const failures = []

  for (const [index, row] of (jsonRows || []).entries()) {
    const normalized = normalizeRowKeys(row)
    if (!Object.values(normalized).some((value) => toText(value) !== '')) continue
    const result = mapIotRow(normalized, sourceKey, config, options)
    if (result.errors) failures.push({ row: firstDataRow + index, errors: result.errors })
    else parsed.push(result.row)
  }

  if (failures.length) {
    const details = failures.slice(0, 5).map(({ row, errors }) => `Row ${row}: ${errors.join(', ')}`).join('; ')
    const remaining = failures.length > 5 ? `; ${failures.length - 5} more invalid row(s)` : ''
    const error = new Error(`Upload rejected. ${details}${remaining}. No rows were uploaded.`)
    error.validationErrors = failures
    throw error
  }
  return parsed
}

export function parseIotWorkbookArrayBuffer(arrayBuffer, sourceKey) {
  // raw prevents CSV date coercion; cellDates:false avoids timezone conversion
  // of actual Excel date cells. Their serials use the workbook's date system.
  const workbook = XLSX.read(arrayBuffer, { type: 'array', raw: true, cellDates: false })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) return { rows: [], sheetName: null }

  const sheet = workbook.Sheets[sheetName]
  const rows = buildRowsFromSheet(sheet, sourceKey, { date1904: Boolean(workbook.Workbook?.WBProps?.date1904) })

  return { rows, sheetName }
}

export function detectIotDataSource(headers) {
  const normalized = new Set((headers || []).map(normalizeHeader))
  const has = (...aliases) => aliases.some((a) => normalized.has(a))

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
