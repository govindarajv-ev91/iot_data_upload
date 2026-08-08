function escapeCsvCell(value) {
  const text = value == null ? '' : String(value)
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

export function rowsToCsv(headers, rows) {
  const lines = [headers.map(escapeCsvCell).join(',')]
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCsvCell(row[h])).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}

export function downloadCsv(filename, headers, rows) {
  const csv = rowsToCsv(headers, rows)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

const UNMATCHED_HEADERS = [
  'raw_vehicle_id',
  'vehicle_number',
  'run_date',
  'total_distance',
  'data_source',
  'created_at',
]

export function downloadUnmatchedVehicles(rows, { fileNameHint = 'unmatched_vehicles' } = {}) {
  const list = (rows || []).map((row) => ({
    raw_vehicle_id: row.raw_vehicle_id || '',
    vehicle_number: row.vehicle_number || '',
    run_date: row.run_date || '',
    total_distance: row.total_distance ?? '',
    data_source: row.data_source || '',
    created_at: row.created_at || '',
  }))

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const safeHint = String(fileNameHint || 'unmatched_vehicles')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 60)

  downloadCsv(`${safeHint}_unmatched_${stamp}.csv`, UNMATCHED_HEADERS, list)
  return list.length
}
