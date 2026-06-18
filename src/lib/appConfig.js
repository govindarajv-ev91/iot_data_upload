let cachedConfig = null

function normalizeConfig(raw = {}) {
  return {
    supabaseUrl: (raw.VITE_SUPABASE_URL || raw.supabaseUrl || '').trim(),
    supabaseAnonKey: (raw.VITE_SUPABASE_ANON_KEY || raw.supabaseAnonKey || '').trim(),
  }
}

export async function loadAppConfig() {
  if (cachedConfig) return cachedConfig

  const fromEnv = normalizeConfig({
    VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
  })

  if (fromEnv.supabaseUrl && fromEnv.supabaseAnonKey) {
    cachedConfig = fromEnv
    return cachedConfig
  }

  const response = await fetch('/config.json', { cache: 'no-store' })
  if (!response.ok) {
    throw new Error('Could not load /config.json. Copy public/config.example.json to public/config.json and add your Supabase keys.')
  }

  const fromFile = normalizeConfig(await response.json())
  if (!fromFile.supabaseUrl || !fromFile.supabaseAnonKey) {
    throw new Error('public/config.json is missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY.')
  }

  cachedConfig = fromFile
  return cachedConfig
}

export function getAppConfig() {
  if (!cachedConfig) {
    throw new Error('App config not loaded yet.')
  }
  return cachedConfig
}

export function isAppConfigReady() {
  return Boolean(cachedConfig?.supabaseUrl && cachedConfig?.supabaseAnonKey)
}
