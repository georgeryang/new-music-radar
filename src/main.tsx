import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// The loader checks that releases/upcoming are arrays, never the shape of their
// entries, so one malformed entry throws mid-render and blanks the page.
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <p role="alert" className="p-6 text-sm text-muted-foreground">
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
