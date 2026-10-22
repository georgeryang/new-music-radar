import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

declare const __BUILD_ID__: string

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  // A new deploy changes the script URL, which installs a fresh worker and shell cache.
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js?v=${__BUILD_ID__}`, { scope: import.meta.env.BASE_URL })
    .catch(() => {})
}

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <p role="alert" className="p-6 text-sm text-destructive">
        Something went wrong showing today's releases. Reload the page, or wait for tonight's update.
      </p>
    )
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
