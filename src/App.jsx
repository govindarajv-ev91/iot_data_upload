import { useCallback, useEffect, useRef, useState } from 'react'
import { format } from 'date-fns'
import {
  Activity,
  AlertCircle,
  Bike,
  CheckCircle2,
  Database,
  FileSpreadsheet,
  Car,
  ClipboardList,
  Download,
  Loader2,
  Radio,
  Upload,
} from 'lucide-react'
import { IOT_DATA_SOURCES, parseIotWorkbookArrayBuffer, toIotDbRows, allowsMultiFilePerDate } from './lib/iotDataParse.js'
import { attachVehicleLookup } from './lib/vehicleLookup.js'
import { fetchAllVehicleMaster } from './lib/vehicleMasterDb.js'
import {
  fetchIotDataPreview,
  findExistingUploadsForDates,
  fetchLastUploadBySource,
  fetchUnmatchedIotRows,
  getIotDataDbSetupMessage,
  isMissingIotDataTable,
  saveIotDataRows,
} from './lib/iotDataDb.js'
import { isSupabaseConfigured, supabaseConfigError } from './lib/supabaseClient.js'
import { getTemplateUrl, IOT_SOURCE_TEMPLATES, isRequiredHeader } from './lib/sourceTemplates.js'
import { downloadUnmatchedVehicles } from './lib/downloadCsv.js'

const SOURCE_META = {
  opspod_ev91: { icon: Radio, color: '#38bdf8' },
  alt_mobility: { icon: Bike, color: '#a855f7' },
  vehicle_day_report: { icon: Car, color: '#2dd4bf' },
  Recent_Details: { icon: ClipboardList, color: '#f472b6' },
}

function formatLastUpload(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return format(date, 'dd MMM yyyy, hh:mm a')
}

function formatDataDate(value) {
  if (!value) return 'No data yet'
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return format(date, 'dd MMM yyyy')
}

function Alert({ type, children }) {
  const Icon = type === 'error' ? AlertCircle : type === 'success' ? CheckCircle2 : Loader2
  return (
    <div className={`alert ${type}`}>
      <Icon size={18} className={type === 'info' ? 'spin' : undefined} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{children}</span>
    </div>
  )
}

export default function App() {
  const [sourceKey, setSourceKey] = useState('opspod_ev91')
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [message, setMessage] = useState(null)
  const [lastResult, setLastResult] = useState(null)
  const [preview, setPreview] = useState([])
  const [unmatched, setUnmatched] = useState([])
  const [lastUploadBySource, setLastUploadBySource] = useState({})
  const [dbReady, setDbReady] = useState(true)
  const fileRef = useRef(null)

  const refreshDashboard = useCallback(async () => {
    if (!isSupabaseConfigured) return
    try {
      const sourceKeys = Object.keys(IOT_DATA_SOURCES)
      const [rows, badRows, lastUploads] = await Promise.all([
        fetchIotDataPreview(12),
        fetchUnmatchedIotRows(8),
        fetchLastUploadBySource(sourceKeys),
      ])
      setPreview(rows)
      setUnmatched(badRows)
      setLastUploadBySource(lastUploads)
      setDbReady(true)
    } catch (err) {
      if (isMissingIotDataTable(err)) {
        setDbReady(false)
        setPreview([])
        setUnmatched([])
        setLastUploadBySource({})
      }
    }
  }, [])

  useEffect(() => {
    refreshDashboard()
  }, [refreshDashboard])

  const processFile = async (file) => {
    if (!file || uploading) return

    setUploading(true)
    setMessage({ type: 'info', text: 'Reading file and resolving vehicles via vehicle_master…' })
    setLastResult(null)

    try {
      const buffer = await file.arrayBuffer()
      const { rows: parsed } = parseIotWorkbookArrayBuffer(buffer, sourceKey)
      if (!parsed.length) {
        setMessage({ type: 'error', text: 'No valid rows found. Check the file format and selected data source.' })
        return
      }

      const runDates = [...new Set(parsed.map((row) => row.run_date))]
      const multiFilePerDate = allowsMultiFilePerDate(sourceKey)

      if (!multiFilePerDate) {
        const conflicts = await findExistingUploadsForDates(sourceKey, runDates)
        if (conflicts.length) {
          const sourceLabel = IOT_DATA_SOURCES[sourceKey].label
          const detail = conflicts
            .map((c) => `${c.runDate} (uploaded ${formatLastUpload(c.uploadedAt)})`)
            .join(', ')
          setMessage({
            type: 'error',
            text: `Upload blocked — ${sourceLabel} data for this date already exists: ${detail}. Same data will not be uploaded again.`,
          })
          return
        }
      }

      const masterRows = await fetchAllVehicleMaster()
      const withLookup = attachVehicleLookup(parsed, masterRows)
      const uploadBatchId = crypto.randomUUID()
      const dbRows = toIotDbRows(withLookup, uploadBatchId)
      const matched = withLookup.filter((r) => r.lookup_matched).length
      const unmatchedCount = withLookup.length - matched

      const { inserted, skipped } = await saveIotDataRows(dbRows, { dedupeByVehicleDate: multiFilePerDate })
      const unmatchedRows = withLookup
        .filter((r) => !r.lookup_matched)
        .map((r) => ({
          raw_vehicle_id: r.raw_vehicle_id,
          vehicle_number: r.vehicle_number,
          run_date: r.run_date,
          total_distance: r.total_distance,
          data_source: r.data_source,
          created_at: new Date().toISOString(),
        }))
      const result = {
        total: withLookup.length,
        matched,
        unmatched: unmatchedCount,
        unmatchedRows,
        inserted,
        skipped,
        fileName: file.name,
      }
      setLastResult(result)

      let successText = `Uploaded ${file.name} — ${inserted.toLocaleString()} rows saved to iot_data.`
      if (multiFilePerDate && skipped > 0) {
        successText += ` ${skipped.toLocaleString()} skipped (same vehicle + date already exists).`
      } else if (skipped > 0) {
        successText += ` ${skipped.toLocaleString()} duplicate rows skipped.`
      }
      if (unmatchedCount > 0) {
        successText += ` ${unmatchedCount.toLocaleString()} unmatched vehicle(s) — download available below.`
      }
      setMessage({ type: 'success', text: successText })
      await refreshDashboard()
    } catch (err) {
      if (isMissingIotDataTable(err)) {
        setMessage({ type: 'error', text: getIotDataDbSetupMessage() })
        setDbReady(false)
      } else {
        setMessage({ type: 'error', text: err?.message || 'Upload failed.' })
      }
    } finally {
      setUploading(false)
    }
  }

  const handleFileInput = (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    processFile(file)
  }

  const handleDrop = (event) => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files?.[0]
    processFile(file)
  }

  const meta = SOURCE_META[sourceKey]
  const template = IOT_SOURCE_TEMPLATES[sourceKey]
  const SourceIcon = meta.icon
  const matchRate = lastResult
    ? Math.round((lastResult.matched / lastResult.total) * 100)
    : null

  const handleDownloadUploadUnmatched = () => {
    if (!lastResult?.unmatchedRows?.length) return
    downloadUnmatchedVehicles(lastResult.unmatchedRows, {
      fileNameHint: lastResult.fileName || 'upload',
    })
  }

  const handleDownloadDbUnmatched = async () => {
    try {
      const rows = await fetchUnmatchedIotRows(5000)
      if (!rows.length) {
        setMessage({ type: 'info', text: 'No unmatched vehicles found in the database.' })
        return
      }
      downloadUnmatchedVehicles(rows, { fileNameHint: 'iot_data_unmatched' })
      setMessage({
        type: 'success',
        text: `Downloaded ${rows.length.toLocaleString()} unmatched vehicle row(s).`,
      })
    } catch (err) {
      setMessage({ type: 'error', text: err?.message || 'Failed to download unmatched vehicles.' })
    }
  }

  return (
    <div className="app">
      <header className="page-header">
        <div>
          <h1>IoT Data Upload</h1>
          <p>
            Upload day-wise vehicle running data from Opspod, Alt Mobility,
            vehicle_day_report, or Recent_Details. Vehicle numbers are resolved against vehicle_master before saving.
          </p>
        </div>
        <span className="badge">
          <Database size={14} />
          iot_data table
        </span>
      </header>

      {!isSupabaseConfigured && (
        <Alert type="error">{supabaseConfigError}</Alert>
      )}

      {isSupabaseConfigured && !dbReady && (
        <Alert type="error">
          iot_data table not found. Run <strong>sql/create_iot_data_table.sql</strong> in Supabase SQL Editor first.
        </Alert>
      )}

      <div className="stats-grid">
        <div className="glass stat-card">
          <div className="label">Last upload rows</div>
          <div className="value blue">{lastResult ? lastResult.total.toLocaleString() : '—'}</div>
        </div>
        <div className="glass stat-card">
          <div className="label">Matched vehicles</div>
          <div className="value green">{lastResult ? lastResult.matched.toLocaleString() : '—'}</div>
        </div>
        <div className="glass stat-card">
          <div className="label">Unmatched</div>
          <div className="value amber">{lastResult ? lastResult.unmatched.toLocaleString() : unmatched.length || '—'}</div>
        </div>
        <div className="glass stat-card">
          <div className="label">Match rate</div>
          <div className="value purple">{matchRate != null ? `${matchRate}%` : '—'}</div>
        </div>
      </div>

      <div className="layout-grid">
        <section className="glass panel">
          <h2 className="panel-title">1. Select data source</h2>
          <div className="source-grid">
            {Object.entries(IOT_DATA_SOURCES).map(([key, cfg]) => {
              const m = SOURCE_META[key]
              const tpl = IOT_SOURCE_TEMPLATES[key]
              const Icon = m.icon
              const active = sourceKey === key
              const lastUpload = lastUploadBySource[key]
              const req = tpl?.requiredFields
              return (
                <button
                  key={key}
                  type="button"
                  className={`source-card${active ? ' active' : ''}`}
                  onClick={() => setSourceKey(key)}
                  disabled={uploading}
                >
                  <div className="source-card-top">
                    <div className="source-icon" style={{ background: `${m.color}22`, color: m.color }}>
                      <Icon size={18} />
                    </div>
                    <h3>{cfg.label}</h3>
                  </div>
                  {req && (
                    <p className="source-required-cols">
                      <span className="req-tag">V</span> {req.vehicle}
                      <span className="req-sep">·</span>
                      <span className="req-tag">Date</span> {req.date}
                      <span className="req-sep">·</span>
                      <span className="req-tag">Km</span> {req.distance}
                    </p>
                  )}
                  <p className="source-last-upload">
                    Last data date: <strong>{formatDataDate(lastUpload?.runDate)}</strong>
                  </p>
                  {lastUpload?.vehicleCount != null && lastUpload.vehicleCount > 0 && (
                    <p className="source-upload-time">
                      Vehicles: <strong>{lastUpload.vehicleCount.toLocaleString()}</strong>
                      {lastUpload.fileCount > 0 && (
                        <>
                          {' '}
                          · Files: <strong>{lastUpload.fileCount.toLocaleString()}</strong>
                        </>
                      )}
                    </p>
                  )}
                  {lastUpload?.createdAt && key !== 'opspod_ev91' && (
                    <p className="source-upload-time">
                      File uploaded: {formatLastUpload(lastUpload.createdAt)}
                    </p>
                  )}
                </button>
              )
            })}
          </div>

          <h2 className="panel-title">2. Upload file</h2>

          {template && (
            <div className="template-bar">
              <div className="template-bar-text">
                <FileSpreadsheet size={16} />
                <span>
                  Use exact column headers from the template. Required:{' '}
                  <strong>{template.requiredFields.vehicle}</strong>,{' '}
                  <strong>{template.requiredFields.date}</strong>,{' '}
                  <strong>{template.requiredFields.distance}</strong>
                  {allowsMultiFilePerDate(sourceKey) && (
                    <>
                      . Multiple files per day allowed — duplicates checked by{' '}
                      <strong>vehicle + date</strong>, not date alone.
                    </>
                  )}
                </span>
              </div>
              <a
                className="template-download-btn"
                href={getTemplateUrl(sourceKey)}
                download={template.templateFile}
                onClick={(e) => e.stopPropagation()}
              >
                <Download size={15} />
                Download template
              </a>
            </div>
          )}

          <div
            className={`dropzone${dragging ? ' dragging' : ''}${uploading ? ' disabled' : ''}`}
            onClick={() => !uploading && fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              if (!uploading) setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && fileRef.current?.click()}
          >
            <div className="dropzone-icon">
              {uploading ? <Loader2 size={24} className="spin" /> : <Upload size={24} />}
            </div>
            <h3>{uploading ? 'Processing upload…' : 'Drop Excel or CSV here'}</h3>
            <p>or click to browse — .xlsx, .xls, .csv</p>
            <p className="hint">
              Selected: <strong>{IOT_DATA_SOURCES[sourceKey].label}</strong>
            </p>
          </div>
          <input
            ref={fileRef}
            className="hidden-input"
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleFileInput}
            disabled={uploading}
          />

          {message && <Alert type={message.type}>{message.text}</Alert>}

          {lastResult?.unmatched > 0 && lastResult.unmatchedRows?.length > 0 && (
            <div className="unmatched-download-bar">
              <div className="unmatched-download-text">
                <AlertCircle size={16} />
                <span>
                  <strong>{lastResult.unmatched.toLocaleString()}</strong> unmatched vehicle
                  {lastResult.unmatched === 1 ? '' : 's'} in this upload — download CSV to fix in vehicle_master.
                </span>
              </div>
              <button type="button" className="template-download-btn" onClick={handleDownloadUploadUnmatched}>
                <Download size={15} />
                Download unmatched
              </button>
            </div>
          )}

          {preview.length > 0 && (
            <div className="preview-table-wrap">
              <h2 className="panel-title">Recent saved rows</h2>
              <table className="preview-table">
                <thead>
                  <tr>
                    <th>Vehicle</th>
                    <th>Date</th>
                    <th>Distance</th>
                    <th>Source</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row) => (
                    <tr key={row.id}>
                      <td>{row.vehicle_number || row.raw_vehicle_id || '—'}</td>
                      <td>{row.run_date}</td>
                      <td>{row.total_distance ?? '—'}</td>
                      <td>{IOT_DATA_SOURCES[row.data_source]?.label || row.data_source}</td>
                      <td>
                        <span className={`tag ${row.lookup_matched ? 'ok' : 'warn'}`}>
                          {row.lookup_matched ? 'Matched' : 'Unmatched'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="glass panel">
          <h2 className="panel-title">Column mapping</h2>
          <div className="source-panel-head">
            <div className="source-icon" style={{ background: `${meta.color}22`, color: meta.color }}>
              <SourceIcon size={18} />
            </div>
            <div>
              <div style={{ fontWeight: 600 }}>{IOT_DATA_SOURCES[sourceKey].label}</div>
              <div className="source-panel-sub">Maps to iot_data table</div>
            </div>
          </div>
          <ul className="mapping-list">
            <li>
              <span className="key">V Number</span>
              <span className="val">{template?.requiredFields.vehicle}</span>
            </li>
            <li>
              <span className="key">Date</span>
              <span className="val">{template?.requiredFields.date}</span>
            </li>
            <li>
              <span className="key">Distance</span>
              <span className="val">{template?.requiredFields.distance}</span>
            </li>
          </ul>

          {template && (
            <>
              <h2 className="panel-title panel-title-spaced">File column headers</h2>
              <p className="header-hint">Highlighted columns are required for upload.</p>
              <div className="header-chips">
                {template.headers.map((header) => (
                  <span
                    key={header}
                    className={`header-chip${isRequiredHeader(sourceKey, header) ? ' required' : ''}`}
                    title={isRequiredHeader(sourceKey, header) ? 'Required column' : 'Optional column'}
                  >
                    {header}
                  </span>
                ))}
              </div>
              <a
                className="template-download-btn template-download-block"
                href={getTemplateUrl(sourceKey)}
                download={template.templateFile}
              >
                <Download size={15} />
                Download {template.label} template (.csv)
              </a>
            </>
          )}

          <h2 className="panel-title panel-title-spaced">Lookup rules</h2>
          <ul className="mapping-list">
            <li>
              <span className="key">vehicle_number</span>
              <span className="val">Reg plate</span>
            </li>
            <li>
              <span className="key">chassis_number</span>
              <span className="val">Chassis / VIN</span>
            </li>
            <li>
              <span className="key">engine_motor_number</span>
              <span className="val">Motor no</span>
            </li>
          </ul>
          <p style={{ margin: '0.85rem 0 0', fontSize: '0.78rem', color: 'var(--text-dim)', lineHeight: 1.5 }}>
            Composite IDs like TN22EB2009-P6DEC12NPCA009484 are split and matched. Chassis wins on conflict.
          </p>

          {unmatched.length > 0 && (
            <>
              <h2 className="panel-title" style={{ marginTop: '1.5rem' }}>
                <Activity size={14} style={{ display: 'inline', verticalAlign: -2, marginRight: 4 }} />
                Unmatched IDs
              </h2>
              <ul className="mapping-list">
                {unmatched.slice(0, 5).map((row) => (
                  <li key={row.id}>
                    <span className="key">{row.raw_vehicle_id}</span>
                    <span className="val">{row.run_date}</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="template-download-btn template-download-block"
                onClick={handleDownloadDbUnmatched}
              >
                <Download size={15} />
                Download all unmatched (.csv)
              </button>
            </>
          )}

          <div style={{ marginTop: '1.5rem', padding: '0.85rem', borderRadius: 10, background: 'rgba(15,23,42,0.5)', fontSize: '0.8rem', color: 'var(--text-dim)' }}>
            <FileSpreadsheet size={14} style={{ display: 'inline', verticalAlign: -2, marginRight: 4 }} />
            Saved fields: vehicle_number, run_date, total_distance
          </div>
        </aside>
      </div>
    </div>
  )
}
