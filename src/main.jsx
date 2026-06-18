import { Component, StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { loadAppConfig } from './lib/appConfig.js'
import { initSupabaseClient } from './lib/supabaseClient.js'

class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app">
          <div className="glass panel" style={{ maxWidth: 640, margin: '4rem auto' }}>
            <h1 style={{ margin: '0 0 0.75rem', fontSize: '1.25rem' }}>Something went wrong</h1>
            <p style={{ margin: 0, color: 'var(--text-dim)', lineHeight: 1.5 }}>{this.state.error.message}</p>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function Bootstrap() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    loadAppConfig()
      .then(() => {
        initSupabaseClient()
        setReady(true)
      })
      .catch((err) => {
        setError(err?.message || 'Failed to load app configuration.')
      })
  }, [])

  if (error) {
    return (
      <div className="app">
        <div className="glass panel" style={{ maxWidth: 640, margin: '4rem auto' }}>
          <h1 style={{ margin: '0 0 0.75rem', fontSize: '1.25rem' }}>Configuration required</h1>
          <p style={{ margin: 0, color: 'var(--text-dim)', lineHeight: 1.5 }}>{error}</p>
        </div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="app">
        <div className="glass panel" style={{ maxWidth: 420, margin: '4rem auto', textAlign: 'center' }}>
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>Loading…</p>
        </div>
      </div>
    )
  }

  return <App />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <Bootstrap />
    </ErrorBoundary>
  </StrictMode>,
)
