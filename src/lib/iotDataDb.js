import { getSupabase } from './supabaseClient.js'
import { vehicleMatchKey } from './uploadParseUtils.js'

export const IOT_DATA_TABLE = 'iot_data'

export function isMissingIotDataTable(error) {
  const msg = (error?.message || '').toLowerCase()
  return msg.includes('iot_data') && (msg.includes('does not exist') || msg.includes('schema cache'))
}

export function getIotDataDbSetupMessage() {
  return 'Database table missing. Run sql/create_iot_data_table.sql in Supabase SQL Editor, then upload again.'
}

/** Normalized key for vehicle + date duplicate checks (ignores case/spaces/hyphens). */
export function iotRowDedupeKey(row) {
  const vehicle = vehicleMatchKey(row.vehicle_number || row.raw_vehicle_id || '')
  return `${row.data_source}|${row.run_date}|${vehicle}`
}

export async function fetchExistingDedupeKeys(dataSource, runDates) {
  const supabase = getSupabase()
  const dates = [...new Set((runDates || []).filter(Boolean))]
  if (!dates.length) return new Set()

  const { data, error } = await supabase
    .from(IOT_DATA_TABLE)
    .select('data_source, run_date, vehicle_number, raw_vehicle_id')
    .eq('data_source', dataSource)
    .in('run_date', dates)

  if (error) throw error
  return new Set((data || []).map(iotRowDedupeKey))
}

export async function saveIotDataRows(rows, { dedupeByVehicleDate = false } = {}) {
  if (!rows?.length) return { inserted: 0, skipped: 0 }

  const supabase = getSupabase()
  let toInsert = rows
  let skipped = 0

  if (dedupeByVehicleDate) {
    const dates = [...new Set(rows.map((r) => r.run_date))]
    const existing = await fetchExistingDedupeKeys(rows[0].data_source, dates)
    const seen = new Set(existing)
    toInsert = []

    for (const row of rows) {
      const key = iotRowDedupeKey(row)
      if (!vehicleMatchKey(row.vehicle_number || row.raw_vehicle_id || '')) continue
      if (seen.has(key)) {
        skipped += 1
        continue
      }
      seen.add(key)
      toInsert.push(row)
    }
  }

  let inserted = 0

  const batchSize = 500
  for (let offset = 0; offset < toInsert.length; offset += batchSize) {
    const batch = toInsert.slice(offset, offset + batchSize)
    const { error } = await supabase.from(IOT_DATA_TABLE).insert(batch)
    if (!error) {
      inserted += batch.length
      continue
    }

    if (error.code !== '23505') throw error

    for (const row of batch) {
      const { error: rowError } = await supabase.from(IOT_DATA_TABLE).insert(row)
      if (rowError?.code === '23505') skipped += 1
      else if (rowError) throw rowError
      else inserted += 1
    }
  }

  return { inserted, skipped }
}

export async function fetchIotDataPreview(limit = 25) {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from(IOT_DATA_TABLE)
    .select('*')
    .order('run_date', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data || []
}

export async function fetchUnmatchedIotRows(limit = 100) {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from(IOT_DATA_TABLE)
    .select('*')
    .eq('lookup_matched', false)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data || []
}

/** One key per uploaded file (batch id), with legacy fallback for older rows. */
function uploadFileKey(row) {
  if (row.upload_batch_id) return row.upload_batch_id
  if (!row.created_at) return null
  return `legacy:${String(row.created_at).slice(0, 19)}`
}

/** Latest data date per source with vehicle count and upload file count for that date. */
export async function fetchLastUploadBySource(sourceKeys) {
  const supabase = getSupabase()
  const keys = sourceKeys || []
  if (!keys.length) return {}

  const { data, error } = await supabase.rpc('iot_dashboard_last_uploads', { source_keys: keys })
  if (error) throw error

  const results = Object.fromEntries(keys.map((key) => [key, null]))
  for (const row of data || []) {
    results[row.data_source] = {
      runDate: row.run_date,
      createdAt: row.created_at,
      vehicleCount: Number(row.vehicle_count),
      fileCount: Number(row.file_count),
    }
  }
  return results
}

/** Returns run_dates that already have data for this source (with last upload time). */
export async function findExistingUploadsForDates(dataSource, runDates) {
  const supabase = getSupabase()
  const uniqueDates = [...new Set((runDates || []).filter(Boolean))]
  if (!uniqueDates.length) return []

  const { data, error } = await supabase
    .from(IOT_DATA_TABLE)
    .select('run_date, created_at')
    .eq('data_source', dataSource)
    .in('run_date', uniqueDates)
    .order('created_at', { ascending: false })

  if (error) throw error

  const byDate = new Map()
  for (const row of data || []) {
    if (!byDate.has(row.run_date)) {
      byDate.set(row.run_date, row.created_at)
    }
  }

  return [...byDate.entries()].map(([runDate, uploadedAt]) => ({ runDate, uploadedAt }))
}
