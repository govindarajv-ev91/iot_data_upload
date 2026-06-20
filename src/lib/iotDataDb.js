import { getSupabase } from './supabaseClient.js'

export const IOT_DATA_TABLE = 'iot_data'

export function isMissingIotDataTable(error) {
  const msg = (error?.message || '').toLowerCase()
  return msg.includes('iot_data') && (msg.includes('does not exist') || msg.includes('schema cache'))
}

export function getIotDataDbSetupMessage() {
  return 'Database table missing. Run sql/create_iot_data_table.sql in Supabase SQL Editor, then upload again.'
}

export async function saveIotDataRows(rows, { replaceSourceDate = null } = {}) {
  if (!rows?.length) return { inserted: 0, skipped: 0 }

  const supabase = getSupabase()

  if (replaceSourceDate?.data_source && replaceSourceDate?.run_date) {
    const { error: delError } = await supabase
      .from(IOT_DATA_TABLE)
      .delete()
      .eq('data_source', replaceSourceDate.data_source)
      .eq('run_date', replaceSourceDate.run_date)
    if (delError) throw delError
  }

  const chunkSize = 500
  let inserted = 0
  let skipped = 0

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize)
    const { error } = await supabase.from(IOT_DATA_TABLE).insert(chunk)
    if (error) {
      if (error.code === '23505') {
        skipped += chunk.length
        continue
      }
      throw error
    }
    inserted += chunk.length
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

/** Latest data date per source with vehicle count and upload file count for that date. */
export async function fetchLastUploadBySource(sourceKeys) {
  const supabase = getSupabase()
  const keys = sourceKeys || []

  const entries = await Promise.all(
    keys.map(async (dataSource) => {
      const { data: latestRows, error: latestError } = await supabase
        .from(IOT_DATA_TABLE)
        .select('run_date')
        .eq('data_source', dataSource)
        .order('run_date', { ascending: false })
        .limit(1)

      if (latestError) throw latestError
      const latestRunDate = latestRows?.[0]?.run_date
      if (!latestRunDate) return [dataSource, null]

      const { data: rowsForDate, error: rowsError } = await supabase
        .from(IOT_DATA_TABLE)
        .select('created_at, vehicle_number, raw_vehicle_id')
        .eq('data_source', dataSource)
        .eq('run_date', latestRunDate)

      if (rowsError) throw rowsError

      const list = rowsForDate || []
      const vehicleKeys = new Set(
        list.map((row) => (row.vehicle_number || row.raw_vehicle_id || '').trim()).filter(Boolean),
      )
      const fileCount = new Set(list.map((row) => row.created_at).filter(Boolean)).size
      const latestUpload = list.reduce((max, row) => {
        if (!row.created_at) return max
        return !max || row.created_at > max ? row.created_at : max
      }, null)

      return [
        dataSource,
        {
          runDate: latestRunDate,
          createdAt: latestUpload,
          vehicleCount: vehicleKeys.size,
          fileCount,
        },
      ]
    }),
  )

  return Object.fromEntries(entries)
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
