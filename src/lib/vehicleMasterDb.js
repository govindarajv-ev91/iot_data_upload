import { getSupabase } from './supabaseClient.js'
import { fetchAllData } from './supabaseFetch.js'

export const VEHICLE_MASTER_TABLE = 'vehicle_master'

let cachedVehicleMaster = null

export async function fetchAllVehicleMaster({ force = false } = {}) {
  if (!force && cachedVehicleMaster) return cachedVehicleMaster

  const probe = await getSupabase().from(VEHICLE_MASTER_TABLE).select('id').limit(1)
  if (probe.error) throw probe.error

  const { data } = await fetchAllData(VEHICLE_MASTER_TABLE, '*', 'id')
  cachedVehicleMaster = data || []
  return cachedVehicleMaster
}
