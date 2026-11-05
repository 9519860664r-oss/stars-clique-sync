import { Component, type ErrorInfo, type ReactNode } from 'react'

type ErrorBoundaryProps = {
  children: ReactNode
}

type ErrorBoundaryState = {
  error: Error | null
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
  }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Stars Clique Sync crashed:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <main className="app-shell">
          <section className="screen">
            <div className="surface crash-box">
              <h1>Something broke</h1>
              <p>{this.state.error.message}</p>
              <button type="button" onClick={() => window.location.reload()}>
                Reload
              </button>
            </div>
          </section>
        </main>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
