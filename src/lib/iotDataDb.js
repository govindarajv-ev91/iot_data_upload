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
