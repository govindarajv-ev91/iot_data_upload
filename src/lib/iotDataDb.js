import { getSupabase } from './supabaseClient.js'

export const IOT_DATA_TABLE = 'iot_data'

export function isMissingIotDataTable(error) {
  const msg = (error?.message || '').toLowerCase()
  return /\biot_data\b/.test(msg) &&
    (error?.code === '42P01' || error?.code === 'PGRST205' ||
      (/\b(table|relation)\b/.test(msg) && (msg.includes('does not exist') || msg.includes('schema cache'))))
}

export function getIotDataDbSetupMessage() {
  return 'Database setup required. Run sql/create_iot_data_table.sql, sql/fix_upload_integrity.sql, and sql/fix_dashboard_last_upload_timeout.sql in Supabase SQL Editor.'
}

function isMissingRpc(error, name) {
  return error?.code === 'PGRST202' ||
    (error?.code === '42883' && (error?.message || '').includes(name))
}

/** The RPC validates and saves the entire file in one database transaction. */
export async function saveIotDataRows(rows) {
  if (!rows?.length) return { inserted: 0, skipped: 0 }

  const supabase = getSupabase()
  const { data, error } = await supabase.rpc('save_iot_upload', { upload_rows: rows })
  if (isMissingRpc(error, 'save_iot_upload')) {
    throw new Error('Database upload update required. Run sql/fix_upload_integrity.sql in Supabase SQL Editor, then upload again.')
  }
  if (error) throw error

  const result = Array.isArray(data) ? data[0] : data
  const inserted = Number(result?.inserted)
  const skipped = Number(result?.skipped)
  if (!Number.isSafeInteger(inserted) || !Number.isSafeInteger(skipped) ||
      inserted < 0 || skipped < 0 || inserted + skipped !== rows.length) {
    throw new Error('The database did not confirm the upload result. Refresh the dashboard before retrying.')
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

/** Export all unmatched rows present at the start, even with a small API row cap. */
export async function fetchAllUnmatchedIotRows() {
  const supabase = getSupabase()
  const { data: latest, error: latestError } = await supabase
    .from(IOT_DATA_TABLE)
    .select('id')
    .eq('lookup_matched', false)
    .order('id', { ascending: false })
    .limit(1)
  if (latestError) throw latestError
  if (!latest?.length) return []

  const upperId = latest[0].id
  const rows = []
  let cursor = null
  while (true) {
    let query = supabase
      .from(IOT_DATA_TABLE)
      .select('*')
      .eq('lookup_matched', false)
      .lte('id', upperId)
      .order('id', { ascending: true })
      .limit(1000)
    if (cursor !== null) query = query.gt('id', cursor)
    const { data, error } = await query
    if (error) throw error
    if (!data?.length) break
    rows.push(...data)
    cursor = data[data.length - 1].id
  }
  return rows
}

/** Latest data date per source with vehicle count and upload file count for that date. */
export async function fetchLastUploadBySource(sourceKeys) {
  const supabase = getSupabase()
  const keys = sourceKeys || []
  if (!keys.length) return {}

  const { data, error } = await supabase.rpc('iot_dashboard_last_uploads', { source_keys: keys })
  if (isMissingRpc(error, 'iot_dashboard_last_uploads')) {
    throw new Error('Dashboard update required. Run sql/fix_dashboard_last_upload_timeout.sql in Supabase SQL Editor.')
  }
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
