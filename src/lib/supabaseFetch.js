import { getSupabase } from './supabaseClient.js'

const DEFAULT_PAGE_SIZE = 1000

export async function fetchAllData(table, columns = '*', orderBy = 'id') {
  const supabase = getSupabase()
  const allData = []
  let cursor = null

  while (true) {
    let query = supabase.from(table).select(columns)
    if (orderBy) query = query.order(orderBy, { ascending: true })
    if (cursor != null) query = query.gt(orderBy, cursor)
    query = query.limit(DEFAULT_PAGE_SIZE)

    const { data, error } = await query
    if (error) throw error
    if (!data?.length) break

    allData.push(...data)
    cursor = data[data.length - 1][orderBy]
    if (data.length < DEFAULT_PAGE_SIZE) break
  }

  return { data: allData }
}
