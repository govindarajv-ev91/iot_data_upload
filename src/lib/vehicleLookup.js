import { formatRunDate, vehicleMatchKey, toText } from './uploadParseUtils.js'

const MATCH_PRIORITY = {
  vehicle_number: 0,
  chassis_number: 1,
  engine_motor_number: 2,
}

function pushToIndex(map, key, entry) {
  if (!key) return
  if (!map.has(key)) map.set(key, [])
  map.get(key).push(entry)
}

/**
 * Build lookup indexes from vehicle_master rows.
 * Keys are normalized (uppercase, no spaces/hyphens).
 */
export function buildVehicleMasterIndex(masterRows) {
  const byVehicle = new Map()
  const byChassis = new Map()
  const byEngine = new Map()

  for (const row of masterRows || []) {
    const entry = {
      id: row.id,
      vehicle_number: toText(row.vehicle_number),
      chassis_number: toText(row.chassis_number),
      engine_motor_number: toText(row.engine_motor_number),
      master_date: toText(row.master_date),
    }

    pushToIndex(byVehicle, vehicleMatchKey(entry.vehicle_number), entry)
    pushToIndex(byChassis, vehicleMatchKey(entry.chassis_number), entry)
    pushToIndex(byEngine, vehicleMatchKey(entry.engine_motor_number), entry)
  }

  return { byVehicle, byChassis, byEngine }
}

/**
 * Split composite IDs like:
 *   TN22EB2009-P6DEC12NPCA009484
 *   TN22EB2009-MTC12EA2412124
 *   TN22EB2009-P6DEC12NPCA009485-P6DEC12NPCA009485
 */
export function splitVehicleTokens(raw) {
  const text = toText(raw)
  if (!text) return []
  return text
    .split(/[-–—/\\|_,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function collectTokens(rawVehicleId, secondaryIds = []) {
  const tokens = new Set()
  const add = (value) => {
    const text = toText(value)
    if (!text) return
    tokens.add(text)
    for (const part of splitVehicleTokens(text)) tokens.add(part)
  }

  add(rawVehicleId)
  for (const secondary of secondaryIds) add(secondary)
  return [...tokens]
}

function lookupToken(key, index) {
  const { byVehicle, byChassis, byEngine } = index
  const hits = []

  if (byVehicle.has(key)) {
    for (const row of byVehicle.get(key)) {
      hits.push({ ...row, matchType: 'vehicle_number' })
    }
  }
  if (byChassis.has(key)) {
    for (const row of byChassis.get(key)) {
      hits.push({ ...row, matchType: 'chassis_number' })
    }
  }
  if (byEngine.has(key)) {
    for (const row of byEngine.get(key)) {
      hits.push({ ...row, matchType: 'engine_motor_number' })
    }
  }

  return hits
}

function filterByMasterDate(matches, asOfDate) {
  if (!asOfDate) return matches
  const asOf = formatRunDate(asOfDate)
  if (!asOf) return matches

  const eligible = matches.filter((m) => !m.master_date || m.master_date <= asOf)
  return eligible.length ? eligible : matches
}

function pickBestByTypeAndDate(matches) {
  return [...matches].sort((a, b) => {
    const pa = MATCH_PRIORITY[a.matchType] ?? 9
    const pb = MATCH_PRIORITY[b.matchType] ?? 9
    if (pa !== pb) return pa - pb
    return (b.master_date || '').localeCompare(a.master_date || '')
  })[0]
}

function pickBestMatch(matches) {
  const byVehicle = new Map()
  for (const m of matches) {
    const vn = m.vehicle_number
    if (!vn) continue
    if (!byVehicle.has(vn)) byVehicle.set(vn, [])
    byVehicle.get(vn).push(m)
  }

  if (byVehicle.size === 1) {
    return pickBestByTypeAndDate([...byVehicle.values()][0])
  }

  // Conflicting tokens (e.g. TN22EB2009-P6DEC12NPCA009485): chassis is most reliable.
  const conflictPriority = ['chassis_number', 'engine_motor_number', 'vehicle_number']
  for (const type of conflictPriority) {
    const typed = matches.filter((m) => m.matchType === type)
    if (typed.length) return pickBestByTypeAndDate(typed)
  }

  return pickBestByTypeAndDate(matches)
}

/**
 * Resolve a messy incoming V identifier to canonical vehicle_number from vehicle_master.
 *
 * Handles:
 * - Plain reg: TN22EB2009
 * - Chassis only: P6DEC12NPCA009484
 * - Motor only: MTC12EA2412124
 * - Composite: TN22EB2009-P6DEC12NPCA009484, TN22EB2009-MTC12EA2412124, etc.
 *
 * @param {string} rawVehicleId - value from Object / reg_no / Reg No / Vehicle No
 * @param {object} masterIndex - from buildVehicleMasterIndex()
 * @param {{ secondaryIds?: string[], asOfDate?: Date }} options
 */
export function resolveVehicleFromMaster(rawVehicleId, masterIndex, options = {}) {
  const { secondaryIds = [], asOfDate = null } = options
  const raw = toText(rawVehicleId)

  if (!raw) {
    return {
      vehicle_number: null,
      vehicle_master_id: null,
      lookup_matched: false,
      lookup_match_type: null,
      raw_vehicle_id: raw,
    }
  }

  const tokens = collectTokens(raw, secondaryIds)
  const allHits = []

  for (const token of tokens) {
    const key = vehicleMatchKey(token)
    if (!key) continue
    allHits.push(...lookupToken(key, masterIndex))
  }

  const filtered = filterByMasterDate(allHits, asOfDate)
  if (!filtered.length) {
    return {
      vehicle_number: null,
      vehicle_master_id: null,
      lookup_matched: false,
      lookup_match_type: null,
      raw_vehicle_id: raw,
    }
  }

  const best = pickBestMatch(filtered)
  return {
    vehicle_number: best.vehicle_number || null,
    vehicle_master_id: best.id ?? null,
    lookup_matched: Boolean(best.vehicle_number),
    lookup_match_type: best.matchType,
    raw_vehicle_id: raw,
  }
}

/**
 * Apply vehicle_master lookup to parsed IoT rows.
 */
export function attachVehicleLookup(rows, masterRows) {
  const index = buildVehicleMasterIndex(masterRows)
  return (rows || []).map((row) => {
    const resolved = resolveVehicleFromMaster(row.raw_vehicle_id, index, {
      secondaryIds: row.secondary_vehicle_ids || [],
      asOfDate: row.run_date_parsed,
    })
    return {
      ...row,
      vehicle_number: resolved.vehicle_number,
      vehicle_master_id: resolved.vehicle_master_id,
      lookup_matched: resolved.lookup_matched,
      lookup_match_type: resolved.lookup_match_type,
    }
  })
}
