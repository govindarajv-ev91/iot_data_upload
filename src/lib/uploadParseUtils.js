import { format } from 'date-fns'

export function normalizeHeader(value) {
  return String(value ?? '')
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

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function parseFleetDate(dateStr) {
  if (dateStr == null || dateStr === '') return null
  const s = dateStr.toString().trim()
  if (!s) return null

  if (dateStr instanceof Date && !Number.isNaN(dateStr.getTime())) {
    return startOfDay(dateStr)
  }

  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date((parseFloat(s) - 25569) * 86400 * 1000)
    if (!Number.isNaN(d.getTime())) return startOfDay(d)
  }

  const datePart = s.split(/\s+/)[0]
  const slash = datePart.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/)
  if (slash) {
    const day = parseInt(slash[1], 10)
    const month = parseInt(slash[2], 10) - 1
    let year = parseInt(slash[3], 10)
    if (year < 100) year += 2000
    const d = new Date(year, month, day)
    if (!Number.isNaN(d.getTime())) return startOfDay(d)
  }

  const iso = datePart.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) {
    const d = new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10))
    if (!Number.isNaN(d.getTime())) return startOfDay(d)
  }

  const parsed = new Date(s)
  return Number.isNaN(parsed.getTime()) ? null : startOfDay(parsed)
}

export function formatRunDate(date) {
  if (!date || Number.isNaN(date.getTime())) return ''
  return format(date, 'yyyy-MM-dd')
}

export function vehicleMatchKey(value) {
  return toText(value).toUpperCase().replace(/[^A-Z0-9]/g, '')
}
