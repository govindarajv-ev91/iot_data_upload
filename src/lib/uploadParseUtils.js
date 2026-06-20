import { format } from 'date-fns'

const MIN_YEAR = 2000
const MAX_YEAR = 2100
const EXCEL_SERIAL_MIN = 30000
const EXCEL_SERIAL_MAX = 65000

export function normalizeHeader(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
}

export function normalizeRowKeys(row) {
  const out = {}
  for (const [key, value] of Object.entries(row || {})) {
    out[normalizeHeader(key)] = value
  }
  return out
}

export function pickField(row, aliases) {
  for (const alias of aliases) {
    const v = row[alias]
    if (v !== null && v !== undefined && String(v).trim() !== '') return v
  }
  return ''
}

export function toText(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  let s = String(value).replace(/[₹,\s]/g, '').trim()
  if (!s || s === '-' || s === '—' || s === '–') return null
  if (s.startsWith('(') && s.endsWith(')')) s = `-${s.slice(1, -1)}`
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function localDateFromParts(year, month, day) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  if (year < MIN_YEAR || year > MAX_YEAR) return null
  if (month < 1 || month > 12 || day < 1 || day > 31) return null

  const d = new Date(year, month - 1, day)
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null
  return d
}

function parseYmdCompact(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n < 20000101 || n > 21001231) return null
  const year = Math.floor(n / 10000)
  const month = Math.floor((n % 10000) / 100)
  const day = n % 100
  return localDateFromParts(year, month, day)
}

function parseExcelSerial(value) {
  const serial = Math.round(Number(value))
  if (!Number.isFinite(serial) || serial < EXCEL_SERIAL_MIN || serial > EXCEL_SERIAL_MAX) return null

  const utc = new Date((serial - 25569) * 86400 * 1000)
  if (Number.isNaN(utc.getTime())) return null

  return localDateFromParts(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate())
}

function parseSlashDate(a, b, yearRaw) {
  let year = parseInt(yearRaw, 10)
  if (!Number.isFinite(year)) return null
  if (year < 100) year += 2000

  const first = parseInt(a, 10)
  const second = parseInt(b, 10)
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null

  let day
  let month

  if (first > 12) {
    day = first
    month = second
  } else if (second > 12) {
    month = first
    day = second
  } else {
    day = first
    month = second
  }

  return localDateFromParts(year, month, day)
}

export function parseFleetDate(dateStr) {
  if (dateStr == null || dateStr === '') return null

  if (dateStr instanceof Date && !Number.isNaN(dateStr.getTime())) {
    return (
      localDateFromParts(dateStr.getFullYear(), dateStr.getMonth() + 1, dateStr.getDate()) ||
      localDateFromParts(dateStr.getUTCFullYear(), dateStr.getUTCMonth() + 1, dateStr.getUTCDate())
    )
  }

  if (typeof dateStr === 'number' && Number.isFinite(dateStr)) {
    return parseYmdCompact(dateStr) || parseExcelSerial(dateStr)
  }

  const s = String(dateStr).trim()
  if (!s) return null

  // ISO: 2026-06-18 or 2026-06-18T00:00:00
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) {
    return localDateFromParts(parseInt(iso[1], 10), parseInt(iso[2], 10), parseInt(iso[3], 10))
  }

  // yyyy/mm/dd or yyyy.mm.dd
  const ymdSlash = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/)
  if (ymdSlash) {
    return localDateFromParts(parseInt(ymdSlash[1], 10), parseInt(ymdSlash[2], 10), parseInt(ymdSlash[3], 10))
  }

  // Compact YYYYMMDD string
  if (/^\d{8}$/.test(s)) {
    const compact = parseYmdCompact(s)
    if (compact) return compact
  }

  // Excel serial as string (46191 or 46191.0)
  if (/^\d{4,6}(\.\d+)?$/.test(s)) {
    const fromSerial = parseExcelSerial(parseFloat(s))
    if (fromSerial) return fromSerial
  }

  const datePart = s.split(/\s+/)[0]

  // DD/MM/YYYY, DD-MM-YYYY, or MM/DD/YYYY when day > 12
  const slash = datePart.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/)
  if (slash) {
    return parseSlashDate(slash[1], slash[2], slash[3])
  }

  // 18-Jun-2026, Jun 18 2026, etc.
  const parsed = new Date(s)
  if (!Number.isNaN(parsed.getTime())) {
    return localDateFromParts(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate())
  }

  return null
}

export function formatRunDate(date) {
  if (!date || Number.isNaN(date.getTime())) return ''
  return format(date, 'yyyy-MM-dd')
}

export function vehicleMatchKey(value) {
  return toText(value).toUpperCase().replace(/[^A-Z0-9]/g, '')
}
