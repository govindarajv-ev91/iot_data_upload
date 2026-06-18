import { createClient } from '@supabase/supabase-js'
import { getAppConfig, isAppConfigReady } from './appConfig.js'

let client = null

export function initSupabaseClient() {
  const { supabaseUrl, supabaseAnonKey } = getAppConfig()
  client = createClient(supabaseUrl, supabaseAnonKey)
}

export function isSupabaseConfigured() {
  return isAppConfigReady()
}

export const supabaseConfigError =
  'Supabase is not configured. Edit public/config.json with your VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then redeploy. No paid Netlify plan needed.'

export function getSupabase() {
  if (!isSupabaseConfigured()) {
    throw new Error(supabaseConfigError)
  }
  if (!client) {
    initSupabaseClient()
  }
  return client
}
